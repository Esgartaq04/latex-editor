/*
 * TeXPane — TeX Live resolver shim.
 *
 * SwiftLaTeX's pdftex build resolves every file kpathsea asks for over a
 * *synchronous* XHR:
 *
 *     GET <endpoint>pdftex/<kpse-format>/<filename>
 *       200 -> body is the file, response header `fileid` names it in /tex
 *       301 -> the file does not exist (the engine caches the miss)
 *
 * The reference implementation of that endpoint is a Docker service, and the
 * public one SwiftLaTeX shipped against (texlive.swiftlatex.com and
 * texlive2.swiftlatex.com) is offline, so this project serves TeX Live itself.
 *
 * Hosting a *dynamic* endpoint would mean paying for a server. Instead the TeX
 * Live subset ships as flat static files on the CDN and this shim adapts the
 * engine's protocol to them:
 *
 *   - `<endpoint>pdftex/<format>/<name>` is rewritten to `<endpoint>files/<name>`,
 *     so one copy of each file serves every kpathsea format code.
 *   - The `fileid` header the engine needs is synthesised from the filename,
 *     which a static host cannot set per-file.
 *   - A manifest fetched once tells us which names exist, so a miss is answered
 *     locally with a synthetic 301 and never touches the network. This matters:
 *     kpathsea probes far more names than it finds, and each probe is a
 *     blocking request.
 *   - A real 404 is also reported to the engine as 301, so it gets cached as a
 *     miss instead of being retried on every pass.
 *
 * Loaded via importScripts *before* the engine, so `self.XMLHttpRequest` is
 * already patched by the time the engine's resolver runs. Every URL that is not
 * a TeX Live lookup is passed straight through to the native implementation.
 */
(function () {
  "use strict";

  var Native = self.XMLHttpRequest;
  var MISS = 301;

  var files = null;
  var aliases = Object.create(null);
  var formatExtensions = Object.create(null);
  var manifestLoaded = false;

  function endpoint() {
    return self.texlive_endpoint || "";
  }

  function loadManifest(base) {
    if (files) return;
    files = Object.create(null);
    try {
      var x = new Native();
      x.open("GET", base + "manifest.json", false);
      /*
       * Always revalidate.
       *
       * Every other file in the store is immutable — a name maps to one body
       * forever — but the manifest changes whenever the store is rebuilt, and
       * it is the thing that decides whether a lookup reaches the network at
       * all. A stale copy makes the shim answer "no such file" locally for
       * files the server is serving perfectly well, which surfaces as a
       * document that fails here and works in a private window.
       *
       * The cost is one conditional request per worker start, normally a 304
       * with no body. Correctness is worth more than that.
       */
      x.setRequestHeader("Cache-Control", "no-cache");
      x.setRequestHeader("Pragma", "no-cache");
      x.send(null);
      if (x.status === 200) {
        var data = JSON.parse(x.responseText);
        var names = data.files || [];
        for (var i = 0; i < names.length; i++) files[names[i]] = 1;
        aliases = data.aliases || Object.create(null);
        formatExtensions = data.formatExtensions || Object.create(null);
        manifestLoaded = true;
      }
    } catch (err) {
      // No manifest: fall back to asking the network about every name.
      manifestLoaded = false;
    }
  }

  /**
   * kpathsea strips the extension and encodes it in the numeric format code, so
   * `cmr10` under the TFM format means `cmr10.tfm`. The manifest records both
   * the exact rewrites the engine performed during the build and the extension
   * each format code turned out to mean, so a name the build never saw still
   * resolves.
   */
  function resolve(format, name) {
    if (name in files) return name;
    var alias = aliases[format + "/" + name];
    if (alias) return alias;
    var extensions = formatExtensions[format];
    if (extensions) {
      for (var i = 0; i < extensions.length; i++) {
        if (name + extensions[i] in files) return name + extensions[i];
      }
    }
    return null;
  }

  /** Split `pdftex/<format>/<name>` (or `pdftex/pk/<dpi>/<name>`) off a URL. */
  function parseLookup(url, base) {
    if (!base || typeof url !== "string" || url.lastIndexOf(base, 0) !== 0) return null;
    var rel = url.slice(base.length);
    if (rel.lastIndexOf("pdftex/pk/", 0) === 0) return { pk: true };
    if (rel.lastIndexOf("pdftex/", 0) !== 0) return null;
    var rest = rel.slice(7);
    var slash = rest.indexOf("/");
    if (slash < 0) return null;
    return { pk: false, format: rest.slice(0, slash), name: rest.slice(slash + 1) };
  }

  function TexPaneXHR() {
    this._x = new Native();
    this._miss = false;
    this._fileid = null;
    this._async = true;
    this.onload = null;
    this.onerror = null;
    this.onreadystatechange = null;
  }

  TexPaneXHR.prototype.open = function (method, url, async_, user, password) {
    this._miss = false;
    this._fileid = null;
    this._async = async_ !== false;

    var base = endpoint();
    var lookup = parseLookup(url, base);
    if (lookup) {
      // Bitmap fonts are never shipped; Type 1 / OpenType covers everything
      // the bundled packages need.
      if (lookup.pk) {
        this._miss = true;
        return;
      }
      loadManifest(base);
      var resolved = manifestLoaded ? resolve(lookup.format, lookup.name) : lookup.name;
      if (!resolved) {
        this._miss = true;
        return;
      }
      this._fileid = resolved;
      url = base + "files/" + encodeURIComponent(resolved);
    }

    this._x.open(method, url, this._async, user, password);
  };

  TexPaneXHR.prototype.send = function (body) {
    if (this._miss) {
      if (this._async) {
        var self_ = this;
        setTimeout(function () {
          if (self_.onreadystatechange) self_.onreadystatechange();
          if (self_.onload) self_.onload();
        }, 0);
      }
      return;
    }
    var x = this._x;
    var outer = this;
    if (this._async) {
      x.onload = function () {
        if (outer.onload) outer.onload();
      };
      x.onerror = function () {
        if (outer.onerror) outer.onerror();
      };
      x.onreadystatechange = function () {
        if (outer.onreadystatechange) outer.onreadystatechange();
      };
    }
    x.send(body === undefined ? null : body);
  };

  TexPaneXHR.prototype.getResponseHeader = function (name) {
    if (this._fileid && String(name).toLowerCase() === "fileid") return this._fileid;
    if (this._miss) return null;
    return this._x.getResponseHeader(name);
  };

  TexPaneXHR.prototype.getAllResponseHeaders = function () {
    return this._miss ? "" : this._x.getAllResponseHeaders();
  };

  TexPaneXHR.prototype.setRequestHeader = function (k, v) {
    if (!this._miss) this._x.setRequestHeader(k, v);
  };

  TexPaneXHR.prototype.overrideMimeType = function (t) {
    if (!this._miss) this._x.overrideMimeType(t);
  };

  TexPaneXHR.prototype.abort = function () {
    if (!this._miss) this._x.abort();
  };

  TexPaneXHR.prototype.addEventListener = function (type, fn) {
    if (this._miss) {
      if (type === "load" || type === "readystatechange") this.onload = fn;
      return;
    }
    this._x.addEventListener(type, fn);
  };

  TexPaneXHR.prototype.removeEventListener = function (type, fn) {
    if (!this._miss) this._x.removeEventListener(type, fn);
  };

  Object.defineProperties(TexPaneXHR.prototype, {
    status: {
      get: function () {
        // A genuine 404 becomes a 301 so the engine records a permanent miss
        // rather than re-requesting the name on every compile pass.
        if (this._miss) return MISS;
        if (this._fileid && this._x.status === 404) return MISS;
        return this._x.status;
      },
    },
    statusText: { get: function () { return this._miss ? "" : this._x.statusText; } },
    readyState: { get: function () { return this._miss ? 4 : this._x.readyState; } },
    response: { get: function () { return this._miss ? null : this._x.response; } },
    responseText: { get: function () { return this._miss ? "" : this._x.responseText; } },
    responseURL: { get: function () { return this._miss ? "" : this._x.responseURL; } },
    responseType: {
      get: function () { return this._x.responseType; },
      set: function (v) { try { this._x.responseType = v; } catch (e) { /* ignore */ } },
    },
    timeout: {
      get: function () { return this._x.timeout; },
      set: function (v) { try { this._x.timeout = v; } catch (e) { /* ignore */ } },
    },
    withCredentials: {
      get: function () { return this._x.withCredentials; },
      set: function (v) { try { this._x.withCredentials = v; } catch (e) { /* ignore */ } },
    },
  });

  self.XMLHttpRequest = TexPaneXHR;
})();
