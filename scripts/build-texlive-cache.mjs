#!/usr/bin/env node
/**
 * Builds the TeX Live subset that ships with the site.
 *
 * SwiftLaTeX's engine carries no TeX Live tree of its own — it fetches every
 * `.cls`, `.sty`, `.tfm` and font over HTTP, and the public server it was
 * written against is gone. Rather than run a replacement server (which would
 * mean paying for one), this script works out exactly which files a
 * representative corpus needs and writes them out as static assets.
 *
 *   1. Discovery — index a local TeX Live installation, serve it over the
 *      engine's native protocol, and drive the real WASM engine in headless
 *      Chromium: build `pdflatex.fmt` with this exact engine build, then
 *      compile the corpus, recording every file the engine asks for.
 *   2. Write — copy the recorded files into `public/texlive/files/`, trim the
 *      font map to what shipped, and write the manifest the browser shim uses
 *      to resolve names without a round trip.
 *   3. Verify — recompile the whole corpus against nothing but the generated
 *      static store, through the same shim the deployed site uses.
 *
 * The engine decides what is needed, not a hand-written package list. And step
 * 3 is not optional: the store is only useful if it is provably sufficient on
 * its own.
 *
 * Requires a local TeX Live (Debian/Ubuntu: texlive-latex-recommended and
 * friends) and a Chromium (set CHROMIUM_PATH, or let Playwright supply one).
 * The output is committed, so a normal `npm run build` never runs this.
 */

import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTexliveServer } from "./texlive-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = path.join(root, "public", "texlive");
const FILES_DIR = path.join(OUTPUT_DIR, "files");
const WORK_DIR = path.join(root, ".texlive-work");

const FONT_MAP = "pdftex.map";

/** Documents beyond the templates, chosen to pull in commonly needed support files. */
const EXTRA_CORPUS = {
  "font-shapes": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\begin{document}
\rmfamily Roman \textbf{bold} \textit{italic} \textsl{slanted} \textsc{caps}
\sffamily Sans \textbf{bold} \textit{italic}
\ttfamily Mono \textbf{bold} \textit{italic}
\rmfamily
{\tiny tiny}{\scriptsize script}{\footnotesize footnote}{\small small}
{\normalsize normal}{\large large}{\Large Large}{\LARGE LARGE}{\huge huge}{\Huge Huge}
$\mathrm{rm}\ \mathit{it}\ \mathbf{bf}\ \mathsf{sf}\ \mathtt{tt}\ \mathcal{ABC}$
\end{document}
`,
  "font-shapes-cm": String.raw`\documentclass[10pt]{article}
\begin{document}
\rmfamily Roman \textbf{bold} \textit{italic} \textsc{caps}
\sffamily Sans \textbf{bold}
\ttfamily Mono
\rmfamily
{\tiny t}{\scriptsize s}{\footnotesize f}{\small s}{\large l}{\Large L}{\huge h}{\Huge H}
$\alpha\beta\sum\int\prod\infty\leq\geq\neq\approx\rightarrow$
\end{document}
`,
  "amsthm+math": String.raw`\documentclass{article}
\usepackage{amsmath,amssymb,amsthm,mathtools}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\newtheorem{theorem}{Theorem}
\begin{document}
\begin{theorem}[Pythagoras]
For a right triangle, $a^2 + b^2 = c^2$.
\end{theorem}
\begin{proof}
\[ \sum_{k=1}^{n} k = \frac{n(n+1)}{2}, \qquad \lim_{x\to0}\frac{\sin x}{x} = 1. \]
\end{proof}
\begin{align}
  \nabla \cdot \mathbf{E} &= \frac{\rho}{\varepsilon_0} \\
  \nabla \times \mathbf{B} &= \mu_0 \mathbf{J}
\end{align}
\end{document}
`,
  typography: String.raw`\documentclass[12pt]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{lmodern}
\usepackage{textcomp}
\usepackage{xcolor}
\usepackage{enumitem}
\usepackage{booktabs}
\usepackage{caption}
\usepackage{fancyhdr}
\usepackage{titlesec}
\usepackage{microtype}
\pagestyle{fancy}
\begin{document}
\section{Text}
\textbf{Bold}, \textit{italic}, \texttt{monospace}, \textsc{small caps},
\textcolor{blue}{colour}, and a dash --- like this.
\begin{itemize}[noitemsep]
  \item First
  \item Second
\end{itemize}
\end{document}
`,
  bibliography: String.raw`\documentclass{article}
% Numeric mode: a plain thebibliography is not author-year compatible.
\usepackage[numbers]{natbib}
\begin{document}
Text with a citation~\cite{knuth1984}.
\begin{thebibliography}{9}
\bibitem{knuth1984} D. E. Knuth. \emph{The \TeX book}. Addison-Wesley, 1984.
\end{thebibliography}
\end{document}
`,
  "verbatim+listings": String.raw`\documentclass{article}
\usepackage{listings}
\usepackage{verbatim}
\begin{document}
\begin{lstlisting}[language=C]
int main(void) { return 0; }
\end{lstlisting}
\end{document}
`,
  "tables+graphics": String.raw`\documentclass{article}
\usepackage{graphicx}
\usepackage{array}
\usepackage{multirow}
\usepackage{longtable}
\usepackage{tabularx}
\usepackage{float}
\usepackage{subcaption}
\begin{document}
\begin{table}[H]
\centering
\begin{tabularx}{\textwidth}{lXr}
A & B & C \\
\end{tabularx}
\end{table}
\rotatebox{15}{Rotated} \scalebox{1.5}{Scaled}
\end{document}
`,
  // Résumés and CVs are the single most common thing people paste into an
  // editor like this, and they almost always switch the body font. Each roman
  // family needs its own document because they all redefine \rmdefault.
  "font-charter": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{charter}
\begin{document}
\section*{Charter}
Body text in Charter, \textbf{bold}, \textit{italic}, \texttt{mono}, \textsc{caps}.
$f(x) = x^2 + 1$
\end{document}
`,
  "font-times-helvet-courier": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{mathptmx}
\usepackage[scaled=0.9]{helvet}
\usepackage{courier}
\begin{document}
\rmfamily Times \textbf{bold} \textit{italic}
\sffamily Helvetica \textbf{bold}
\ttfamily Courier
\rmfamily $\int_0^1 x\,dx$
\end{document}
`,
  "font-palatino": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{mathpazo}
\begin{document}
Palatino body text, \textbf{bold}, \textit{italic}. $\sum_{i=1}^n i$
\end{document}
`,
  "font-newtx": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{newtxtext,newtxmath}
\begin{document}
Times clone with matching maths. \textbf{Bold} \textit{italic}. $\alpha+\beta$
\end{document}
`,
  "font-libertine": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{libertine}
\begin{document}
Linux Libertine, \textbf{bold}, \textit{italic}, \textsc{caps}.
\end{document}
`,
  "font-xcharter": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{XCharter}
\begin{document}
XCharter body text, \textbf{bold}, \textit{italic}.
\end{document}
`,
  // The shape a real CV preamble takes: a font package, tabularx-based entry
  // macros, titlesec section rules, and `comment` to keep unfinished sections
  // out of the output.
  "resume-machinery": String.raw`\documentclass[letterpaper,10pt]{article}
\usepackage[top=0.4in, bottom=0.4in, left=0.45in, right=0.45in]{geometry}
\usepackage{charter}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage{microtype}
\usepackage{titlesec}
\usepackage{enumitem}
\usepackage{tabularx}
\usepackage{comment}
\usepackage{calc}
\usepackage{ifthen}
\usepackage{etoolbox}
\usepackage{xspace}
\usepackage{soul}
\usepackage{ragged2e}
\usepackage{hyphenat}
\usepackage[hidelinks]{hyperref}

\excludecomment{hidden}
\pagestyle{empty}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

\titleformat{\section}{\vspace{-2pt}\scshape\large}{}{0em}{}[\titlerule]
\titlespacing*{\section}{0pt}{8pt}{4pt}
\setlist[itemize]{topsep=0pt, partopsep=0pt, parsep=0pt, itemsep=1pt,
  leftmargin=0.16in, labelsep=0.05in, label=\textbullet}

\newcommand{\entry}[4]{%
  \vspace{5pt}
  \begin{tabularx}{\textwidth}{@{}Xr@{}}
    \textbf{#1} & #2 \\ \textit{\small #3} & \textit{\small #4} \\
  \end{tabularx}\vspace{-6pt}}
\newenvironment{bullets}{\begin{itemize}}{\end{itemize}\vspace{-4pt}}

\begin{document}
\begin{center}
  {\LARGE \textbf{Example Name}} \\ \vspace{2pt}
  \small \href{https://example.com}{example.com} $|$ 555-0100
\end{center}
\vspace{-6pt}

\section{Education}
\entry{A University}{2023 -- 2027}{BSc Computer Science}{City, ST}
\begin{hidden}
\entry{Not Rendered}{2021 -- 2023}{Hidden by \texttt{comment}}{City, ST}
\end{hidden}

\section{Experience}
\entry{Software Engineering Intern}{2026}{A Company}{City, ST}
\begin{bullets}
  \item Grew a \$10,000 account to $\sim$\$15,000 ($\sim$50\% return).
  \item Achieved 99.9\% uptime; wrote \texttt{code} that shipped.
\end{bullets}
\end{document}
`,
  // Coursework territory: algorithms, units, quotes, wrapped figures.
  "coursework": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{algorithm}
\usepackage{algpseudocode}
\usepackage{siunitx}
\usepackage{csquotes}
\usepackage{wrapfig}
\usepackage{lastpage}
\usepackage{url}
\begin{document}
\begin{algorithm}
\caption{Binary search}
\begin{algorithmic}[1]
  \State $lo \gets 0$
  \While{$lo < hi$}
    \State $mid \gets \lfloor (lo+hi)/2 \rfloor$
  \EndWhile
  \State \Return $lo$
\end{algorithmic}
\end{algorithm}
A measurement of \SI{3.5}{\kilo\gram} and \enquote{a quotation}.
\end{document}
`,
  // TikZ is a large closure but too common to leave out — diagrams in reports,
  // plots in lab write-ups.
  "tikz": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{tikz}
\usetikzlibrary{arrows.meta, positioning, shapes.geometric}
\begin{document}
\begin{tikzpicture}[node distance=2cm]
  \node (a) [draw, rectangle] {Source};
  \node (b) [draw, ellipse, right=of a] {Sink};
  \draw [-{Stealth}] (a) -- (b) node [midway, above] {edge};
\end{tikzpicture}
\end{document}
`,
  "resume-layout": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\usepackage[margin=0.75in]{geometry}
\usepackage{charter}
\usepackage{titlesec}
\usepackage{enumitem}
\usepackage{tabularx}
\usepackage{array}
\usepackage{multicol}
\usepackage{ragged2e}
\usepackage{setspace}
\usepackage{parskip}
\usepackage{fancyhdr}
\usepackage{xcolor}
\usepackage{marvosym}
\usepackage[hidelinks]{hyperref}

\titleformat{\section}{\large\bfseries}{}{0em}{}[\titlerule]
\pagestyle{empty}

\begin{document}
\begin{center}
  {\LARGE \textbf{Your Name}}\\[2pt]
  \href{mailto:you@example.com}{you@example.com} $\cdot$ City, Country
\end{center}

\section{Experience}
\textbf{Job Title}, Company \hfill 2023--present
\begin{itemize}[leftmargin=*, noitemsep, topsep=2pt]
  \item Did a thing that had a measurable result.
  \item Did another thing.
\end{itemize}

\section{Education}
\begin{tabularx}{\textwidth}{@{}lXr@{}}
  BSc Something & University & 2019--2023 \\
\end{tabularx}

\section{Skills}
\begin{multicols}{2}
\begin{itemize}[leftmargin=*, noitemsep]
  \item One
  \item Two
\end{itemize}
\end{multicols}
\end{document}
`,
  // TeX picks a font's design size from context, so a document reaching a size
  // the store never fetched dies with "Metric (TFM) file not found" and no PDF.
  // These three guard the whole range rather than the sizes a corpus happens to
  // wander into.
  "font-size-range": String.raw`\documentclass[11pt]{article}
\begin{document}
{\tiny \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\scriptsize \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\footnotesize \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\small \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\normalsize \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\large \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\Large \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\LARGE \texttt{tt} \textbf{b} \textit{i} \textsl{s} \textsc{sc} \textsf{sf}}
{\huge \texttt{tt} \textbf{b} \textit{i}}
{\Huge \texttt{tt} \textbf{b} \textit{i}}
$x^{2^{2}}$ $\scriptstyle a$ $\scriptscriptstyle b$
\end{document}
`,
  // TS1 text symbols. The kernel reaches for these even with no fontenc and no
  // textcomp, which is how an ordinary OT1 document ends up needing cm-super.
  "ts1-symbols": String.raw`\documentclass[11pt]{article}
\begin{document}
\textcopyright\ \textregistered\ \texttrademark\ \textdegree\ \texteuro\
\textbullet\ \textperthousand\ \textsection\ \textparagraph\ \textdagger
{\large \textcopyright} {\small \textdegree} \textbf{\textcopyright}
\end{document}
`,
  // T1 without lmodern — the EC path, which resolves through cm-super.
  "t1-without-lmodern": String.raw`\documentclass[11pt]{article}
\usepackage[T1]{fontenc}
\begin{document}
Text with \textbf{bold}, \textit{italic}, \texttt{mono}, \textsc{caps}.
{\large \texttt{larger mono}} {\small \textsf{smaller sans}}
Accented: \"a \'e \^i \~n \c{c}
\end{document}
`,
  "hyperref+geometry": String.raw`\documentclass{article}
\usepackage[a4paper,margin=2cm]{geometry}
\usepackage[colorlinks=true]{hyperref}
\usepackage{url}
\usepackage{setspace}
\usepackage{parskip}
\begin{document}
\onehalfspacing
\section{Links}\label{sec:links}
See Section~\ref{sec:links} and \url{https://example.com}.
\tableofcontents
\end{document}
`,
};

/**
 * Breadth coverage.
 *
 * The curated corpus above proves that realistic *documents* work, but it only
 * ever covers packages someone thought to include — which means a user finds
 * the gaps one report at a time. This list is the other half: each entry gets a
 * minimal document of its own, so loading it is exercised and its files land in
 * the store.
 *
 * One package per document on purpose. Font and layout packages conflict with
 * each other (every one of them redefines something), and isolating them means
 * a package that cannot work in this engine fails alone instead of taking a
 * batch down with it.
 *
 * A failure here is a warning, not an error: some packages genuinely cannot run
 * in a browser engine (anything wanting shell-escape or an external binary).
 * The curated corpus stays strict — that is the contract.
 *
 * `body` is only needed when merely loading the package does not pull in what
 * documents actually use, which is typically fonts.
 */
const SMOKE_PACKAGES = [
  // Tables. `colortbl` is what `\usepackage[table]{xcolor}` loads.
  { name: "colortbl", body: String.raw`\begin{tabular}{|>{\columncolor{yellow}}l|c|}\hline
\rowcolor{gray!20} A & B \\\hline X & Y \\\hline\end{tabular}`, also: ["xcolor"] },
  { name: "multirow", body: String.raw`\begin{tabular}{|l|l|}\hline\multirow{2}{*}{A} & B \\ & C \\\hline\end{tabular}` },
  { name: "makecell", body: String.raw`\begin{tabular}{|l|}\hline\makecell{A\\B} \\\hline\end{tabular}` },
  { name: "hhline", body: String.raw`\begin{tabular}{|l|l|}\hline A & B \\\hhline{==} C & D \\\hline\end{tabular}` },
  { name: "threeparttable" },
  { name: "rotating" },
  { name: "adjustbox", body: String.raw`\adjustbox{width=2cm}{Scaled}` },
  { name: "changepage" },
  { name: "arydshln" },

  // Boxes and framing — homework templates lean on these heavily.
  { name: "tcolorbox", body: String.raw`\begin{tcolorbox}Boxed.\end{tcolorbox}` },
  { name: "mdframed", body: String.raw`\begin{mdframed}Framed.\end{mdframed}` },
  { name: "framed", body: String.raw`\begin{framed}Framed.\end{framed}` },
  { name: "environ" },

  // Maths notation.
  { name: "cancel", body: String.raw`$\cancel{x}$` },
  { name: "bm", body: String.raw`$\bm{x}$` },
  { name: "mathrsfs", body: String.raw`$\mathscr{L}$` },
  { name: "stmaryrd", body: String.raw`$\llbracket x \rrbracket$` },
  { name: "dsfont", body: String.raw`$\mathds{R}$` },
  { name: "amscd", body: String.raw`$\begin{CD} A @>>> B \end{CD}$` },
  { name: "empheq" },
  { name: "esint" },
  { name: "accents" },
  { name: "nicefrac", body: String.raw`$\nicefrac{1}{2}$` },
  { name: "xfrac", body: String.raw`$\sfrac{1}{2}$` },
  { name: "physics", body: String.raw`$\dv{f}{x}$ $\ket{\psi}$` },

  // Proofs and algorithms — CS coursework.
  { name: "bussproofs", body: String.raw`\begin{prooftree}\AxiomC{$A$}\UnaryInfC{$B$}\end{prooftree}` },
  { name: "algorithm2e", body: String.raw`\begin{algorithm}[H]\caption{X}\KwIn{n}\Return $n$\end{algorithm}` },
  { name: "thmtools" },

  // Text and layout.
  { name: "ulem", body: String.raw`\uline{underlined} \sout{struck}` },
  { name: "pifont", body: String.raw`\ding{51}` },
  { name: "paralist", body: String.raw`\begin{compactitem}\item One\end{compactitem}` },
  { name: "enumerate", body: String.raw`\begin{enumerate}[(a)]\item One\end{enumerate}` },
  { name: "cleveref", body: String.raw`\section{S}\label{sec:s}\Cref{sec:s}` },
  { name: "appendix" },
  { name: "titling" },
  { name: "fullpage" },
  { name: "tabto", body: String.raw`A\tabto{3cm}B` },
  { name: "lipsum", body: String.raw`\lipsum[1]` },
  { name: "blindtext", body: String.raw`\blindtext` },
  { name: "todonotes" },

  // Figures.
  { name: "subfig" },
  { name: "epsfig" },
  // Verbatim's body must start on its own line — fancyvrb reads it linewise.
  { name: "fancyvrb", body: "\\begin{Verbatim}\ncode\n\\end{Verbatim}" },

  // Drawing and plotting on top of TikZ.
  { name: "pgfplots", body: String.raw`\begin{tikzpicture}\begin{axis}\addplot coordinates {(0,0) (1,1)};\end{axis}\end{tikzpicture}` },
  { name: "forest", body: String.raw`\begin{forest}[A[B][C]]\end{forest}` },
  { name: "circuitikz", body: String.raw`\begin{circuitikz}\draw (0,0) to[R=$R$] (2,0);\end{circuitikz}` },
  { name: "mhchem", body: String.raw`\ce{H2O}` },
  { name: "chemfig" },
];

function smokeCorpus() {
  const documents = {};
  for (const entry of SMOKE_PACKAGES) {
    const packages = [...(entry.also ?? []), entry.name]
      .map((name) => `\\usepackage{${name}}`)
      .join("\n");
    documents[`pkg:${entry.name}`] =
      `\\documentclass[11pt]{article}\n` +
      `\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n\\usepackage{amsmath,amssymb}\n` +
      `${packages}\n\\begin{document}\n` +
      `${entry.body ?? "Text with \\textbf{bold} and $x^{2}$."}\n\\end{document}\n`;
  }
  return documents;
}

async function loadTemplates() {
  try {
    const module = await import(path.join(root, "lib", "templates.ts"));
    return Object.fromEntries(module.templates.map((t) => [`template:${t.id}`, t.source]));
  } catch (error) {
    throw new Error(
      "Could not load lib/templates.ts. This script needs Node 22.18+ for " +
        `built-in TypeScript stripping. (${error.message})`,
    );
  }
}

async function launchBrowser() {
  const { chromium } = await import("@playwright/test");
  // CHROMIUM_PATH lets a machine with a pre-installed browser skip Playwright's
  // own download, which is pinned to the exact build it shipped with.
  return chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
}

/** Compile every document in the corpus, returning the ones that failed. */
async function runCorpus(page, corpus, onDocument) {
  const failures = [];
  for (const [name, source] of Object.entries(corpus)) {
    process.stdout.write(`  ${name} … `);
    const result = await page.evaluate(([text]) => window.texpane.compile(text, 2), [source]);
    if (result.ok) {
      console.log(onDocument ? onDocument(name, result) : "ok");
    } else {
      console.log("FAILED");
      failures.push({ name, log: result.log });
    }
  }
  return failures;
}

function reportFailures(failures) {
  for (const failure of failures) {
    console.error(`\n--- ${failure.name} ---`);
    const interesting = failure.log
      .split("\n")
      .filter((line) => line.startsWith("!") || line.startsWith("l."));
    console.error(
      (interesting.length ? interesting : failure.log.split("\n").slice(-15))
        .slice(0, 12)
        .join("\n"),
    );
  }
}

/**
 * pdftex.map lists every font TeX Live knows about — five megabytes of entries,
 * almost all of them for fonts this site does not ship. Keep only the entries
 * whose files are actually present; a font with no file cannot be embedded
 * whether or not its map entry survives.
 */
function trimFontMap(text, available) {
  const kept = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("%") || trimmed.startsWith("#")) continue;
    const references = fontMapReferences(trimmed);
    if (references.length === 0) continue;
    if (references.every((reference) => available.has(reference))) kept.push(trimmed);
  }
  return kept.join("\n") + "\n";
}

/**
 * File names referenced by a pdftex map line.
 *
 * The `<` prefixes are directives, not part of the name: `<file` subsets it,
 * `<<file` includes it whole, and `<[file` marks an encoding. Leaving the `[`
 * attached makes every entry that uses an encoding file look unsatisfiable, so
 * the whole font family gets trimmed away and documents that compiled during
 * discovery fail against the store.
 */
function fontMapReferences(line) {
  return [...line.matchAll(/<{1,2}\[?\s*([^\s<[]+)/g)].map((match) => match[1]);
}

async function discover(corpus) {
  const overlay = new Map();
  const server = await startTexliveServer({ overlay, mode: "discovery" });
  console.log(
    `Indexed ${server.index.size} TeX Live files (${server.collisions} basename collisions resolved)\n`,
  );

  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error("  page error:", error.message));

  let failures = [];
  try {
    await page.goto(`${server.origin}/harness.html`);
    await page.evaluate(
      ([endpoint]) => window.texpane.start(endpoint),
      [`${server.origin}/texlive/`],
    );

    process.stdout.write("Building the format file … ");
    const format = await page.evaluate(() => window.texpane.buildFormat());
    if (!format.ok) {
      console.log("failed");
      console.error(format.log.split("\n").slice(-40).join("\n"));
      throw new Error("Could not build the format file");
    }
    const formatBytes = Buffer.from(format.bytes);
    // `compileformat` names its dump pdflatex.fmt, but the engine binary is
    // called swiftlatexpdftex and asks kpathsea for its own name.
    for (const name of ["swiftlatexpdftex.fmt", "pdflatex.fmt"]) overlay.set(name, formatBytes);
    server.used.add("swiftlatexpdftex.fmt");
    console.log(`${(formatBytes.length / 1024 / 1024).toFixed(2)} MB\n`);

    // Restart the engine before compiling. Building the format is an INITEX run
    // that reads latex.ltx, expl3-code.tex and megabytes of other sources which
    // are baked into the dump and never read again — and the engine caches
    // fetches for the life of the worker, so a fresh one is the only way to see
    // what compiling alone actually needs.
    server.used.clear();
    server.used.add("swiftlatexpdftex.fmt");
    await page.evaluate(
      ([endpoint]) => window.texpane.start(endpoint),
      [`${server.origin}/texlive/`],
    );

    console.log("Compiling the corpus:");
    let previous = server.used.size;
    failures = await runCorpus(page, corpus, () => {
      const added = server.used.size - previous;
      previous = server.used.size;
      return `ok (+${added} files)`;
    });
  } finally {
    await browser.close();
    await server.close();
  }

  return { server, overlay, failures };
}

/**
 * Font files shipped whether or not the corpus happened to ask for them.
 *
 * A corpus can only discover the font *sizes* it uses. TeX picks a design size
 * from the context — `\texttt` inside a 12pt title wants cmtt12, a footnote
 * wants cmtt8 — and a metric that is not in the store is not a degraded render,
 * it is `Metric (TFM) file not found` and no PDF at all. Guessing which sizes a
 * document will reach is a losing game, so the core families ship whole.
 *
 * Metrics are nearly free (Computer Modern's 75 are 0.1 MB). The Type 1
 * outlines cost more, but a metric without its outline just moves the fatal
 * error from load time to output time, so they travel together.
 *
 * The store grows; a visitor's download does not. Nobody fetches a font their
 * own document never selects.
 */
const ALWAYS_INCLUDE_PATTERNS = [
  // Computer Modern — what a document gets with no font package at all.
  /\/fonts\/tfm\/public\/cm\/[^/]+\.tfm$/,
  /\/fonts\/type1\/public\/amsfonts\/cm\/[^/]+\.pfb$/,
  // Latin Modern — the usual answer for T1 encoding.
  /\/fonts\/tfm\/public\/lm\/[^/]+\.tfm$/,
  /\/fonts\/type1\/public\/lm\/[^/]+\.pfb$/,
  /\/fonts\/vf\/public\/lm\/[^/]+\.vf$/,
  // EC metrics for T1 without lmodern, and TC metrics for the TS1 text
  // symbols — which modern LaTeX reaches for even in an OT1 document.
  /\/fonts\/tfm\/jknappen\/(ec|tc)\/[^/]+\.tfm$/,
  // The outlines both of those re-encode. cm-super is 58 MB in full, so this
  // takes the twelve families the standard classes select, at the ten design
  // sizes LaTeX's size commands actually ask for. Metrics without outlines
  // would only move the fatal error from load time to output time, so these
  // have to travel with the metrics above.
  /\/fonts\/type1\/public\/cm-super\/(sfrm|sfbx|sfti|sfsl|sfsc|sftt|sfss|sfsi|sfsx|sfbi|sfcc|sftc)(0500|0600|0700|0800|0900|1000|1095|1200|1440|1728)\.pfb$/,
  // ...and the encodings those map entries reference, or the font map trim
  // drops every cm-super line as unsatisfiable.
  /\/fonts\/enc\/dvips\/cm-super\/[^/]+\.enc$/,
];

/** Basenames in the index whose path matches an always-include pattern. */
function alwaysIncluded(index) {
  const names = [];
  for (const [name, filePath] of index) {
    if (ALWAYS_INCLUDE_PATTERNS.some((pattern) => pattern.test(filePath))) names.push(name);
  }
  return names;
}

async function writeStore(server, overlay, supportedPackages = []) {
  await rm(FILES_DIR, { recursive: true, force: true });
  await mkdir(FILES_DIR, { recursive: true });

  const forced = alwaysIncluded(server.index);
  const names = [...new Set([...server.used, ...forced])].sort();
  const available = new Set(names);
  console.log(
    `\nShipping ${forced.length} font files from the core families regardless of ` +
      `what the corpus reached (${names.length - server.used.size} of them new).`,
  );

  /**
   * Files are written uncompressed and left for the host to compress.
   *
   * Pre-compressing them and declaring `Content-Encoding: gzip` looks tempting —
   * the format dump is 21 MB of highly repetitive binary — but it breaks on any
   * host that compresses on the fly. GitHub Pages gzips every response
   * regardless of content type, so a browser strips exactly one layer and the
   * engine receives gzip bytes where it expected a font. Shipping raw is correct
   * everywhere; the worst case is a host that does not compress, which costs
   * bandwidth rather than breaking the site.
   */
  let stored = 0;
  let compressed = 0;

  async function emit(name, bytes) {
    await writeFile(path.join(FILES_DIR, name), bytes);
    stored += bytes.length;
    // Reported so the size of a compressing host's transfer is still visible.
    compressed += gzipSync(bytes, { level: 9 }).length;
  }

  let formatBytes = 0;
  for (const name of names) {
    if (name === FONT_MAP) continue; // written trimmed, below
    const source = overlay.get(name);
    const bytes = Buffer.isBuffer(source)
      ? source
      : await readFile(source ?? server.index.get(name));
    if (name.endsWith(".fmt")) formatBytes = bytes.length;
    await emit(name, bytes);
  }

  if (available.has(FONT_MAP)) {
    const full = await readFile(server.index.get(FONT_MAP), "utf8");
    const trimmed = trimFontMap(full, available);
    await emit(FONT_MAP, Buffer.from(trimmed));
    console.log(
      `\nFont map trimmed from ${(full.length / 1024 / 1024).toFixed(1)} MB to ` +
        `${(trimmed.length / 1024).toFixed(0)} KB (${trimmed.split("\n").length - 1} entries)`,
    );
  }

  // Which extension each kpathsea format code turned out to mean. Recording
  // what the engine actually did beats hard-coding the kpathsea enum, which
  // varies between engine builds.
  const formatExtensions = {};
  for (const { format, requested, resolved } of server.lookups) {
    if (!resolved || resolved === requested) continue;
    const extension = resolved.slice(requested.length);
    const seen = (formatExtensions[format] ??= []);
    if (!seen.includes(extension)) seen.push(extension);
  }

  await writeFile(
    path.join(OUTPUT_DIR, "manifest.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      note:
        "Lookup table for the browser TeX engine. `files` is everything served from " +
        "texlive/files/; `aliases` and `formatExtensions` restore the extension kpathsea " +
        "strips off. A name that resolves to nothing is answered in the browser itself, " +
        "with no network round trip. Files are stored uncompressed; compression is the " +
        "host's job. Generated by scripts/build-texlive-cache.mjs.",
      // Uncompressed size of the format dump, so the loading UI can show a
      // percentage for the largest thing the first visit downloads.
      format: { name: "swiftlatexpdftex.fmt", bytes: formatBytes },
      files: names,
      // Packages proven to load in this engine against this store. Generated
      // from what actually compiled, so it cannot drift from reality.
      packages: supportedPackages,
      aliases: Object.fromEntries([...server.aliases].sort()),
      formatExtensions,
    }) + "\n",
  );

  return { names, stored, compressed };
}

async function verify(corpus) {
  const server = await startTexliveServer({ mode: "static" });
  const browser = await launchBrowser();
  const page = await browser.newPage();

  const requests = [];
  page.on("pageerror", (error) => console.error("  page error:", error.message));
  page.on("requestfailed", (request) => requests.push(request.url()));

  try {
    await page.goto(`${server.origin}/harness.html`);
    await page.evaluate(
      ([endpoint, workerUrl]) => window.texpane.start(endpoint, workerUrl),
      [`${server.origin}/texlive/`, "/swiftlatex/texpane-engine.js"],
    );
    return await runCorpus(page, corpus);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function main() {
  const curated = { ...(await loadTemplates()), ...EXTRA_CORPUS };
  const smoke = smokeCorpus();
  const corpus = { ...curated, ...smoke };
  console.log(
    `Corpus: ${Object.keys(curated).length} documents + ` +
      `${Object.keys(smoke).length} package smoke tests\n`,
  );

  console.log("── Discovery ──────────────────────────────────");
  const { server, overlay, failures } = await discover(corpus);

  await mkdir(WORK_DIR, { recursive: true });
  await writeFile(
    path.join(WORK_DIR, "lookups.json"),
    JSON.stringify({ lookups: server.lookups, missing: [...server.missing] }, null, 2),
  );

  // A smoke package that cannot run in this engine is information, not a build
  // failure — the files it did fetch are still worth shipping. A curated
  // document failing means the store would be incomplete for a real document.
  const curatedFailures = failures.filter((f) => !f.name.startsWith("pkg:"));
  const smokeFailures = failures.filter((f) => f.name.startsWith("pkg:"));

  if (curatedFailures.length) {
    reportFailures(curatedFailures);
    throw new Error(
      `${curatedFailures.length} corpus document(s) failed during discovery; the store would be incomplete.`,
    );
  }

  const unsupported = new Set(smokeFailures.map((f) => f.name));
  if (unsupported.size) {
    console.log(
      `\n${unsupported.size} package(s) do not work in this engine and are not claimed as supported:`,
    );
    console.log(`  ${[...unsupported].map((n) => n.slice(4)).sort().join(", ")}`);
  }

  const supported = SMOKE_PACKAGES.map((entry) => entry.name)
    .filter((name) => !unsupported.has(`pkg:${name}`))
    .sort();

  const { names, stored, compressed } = await writeStore(server, overlay, supported);
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `\nWrote ${names.length} files to public/texlive/files/ — ` +
      `${mb(stored)} MB on disk, ${mb(compressed)} MB once a host gzips it`,
  );

  // Only verify what discovery proved can compile at all.
  const verifiable = Object.fromEntries(
    Object.entries(corpus).filter(([name]) => !unsupported.has(name)),
  );

  console.log("\n── Verification (static store only) ───────────");
  const verificationFailures = await verify(verifiable);
  if (verificationFailures.length) {
    reportFailures(verificationFailures);
    throw new Error(
      `${verificationFailures.length} document(s) failed against the generated store.`,
    );
  }

  console.log(
    `\nAll ${Object.keys(verifiable).length} documents compile from the static store alone.`,
  );
  if (compressed > 25 * 1024 * 1024) {
    console.warn("Warning: the store is large over the wire. Consider trimming the corpus.");
  }
}

await main();
