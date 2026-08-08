/**
 * Starter documents.
 *
 * These only use packages in the bundled TeX Live subset — a template that
 * fails to compile on first click is worse than no template.
 */

export interface Template {
  id: string;
  name: string;
  description: string;
  source: string;
}

const ARTICLE = String.raw`\documentclass[11pt]{article}

\usepackage[margin=1in]{geometry}
\usepackage{amsmath}
\usepackage{amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{hyperref}

\title{A Document Written in the Browser}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
This document was typeset by a real \TeX{} engine compiled to WebAssembly,
running entirely inside your browser. Nothing was uploaded to a server.
\end{abstract}

\section{Mathematics}

Inline math works as you would expect: the Euler identity is
$e^{i\pi} + 1 = 0$. Display math is just as ordinary:

\begin{equation}
  \int_{-\infty}^{\infty} e^{-x^{2}} \, \mathrm{d}x = \sqrt{\pi}.
  \label{eq:gaussian}
\end{equation}

Equation~\eqref{eq:gaussian} is resolved on a second compilation pass, which
happens automatically whenever the log asks for one.

\section{Tables}

\begin{table}[ht]
  \centering
  \begin{tabular}{lrr}
    \toprule
    Engine & Cold start & Warm compile \\
    \midrule
    Server round trip & 2--8 s & 2--8 s \\
    WebAssembly, local & \textasciitilde 3 s & $<$ 1 s \\
    \bottomrule
  \end{tabular}
  \caption{Why compiling on the client is worth the download.}
\end{table}

\section{Lists}

\begin{enumerate}
  \item Type on the left.
  \item Watch the PDF rebuild on the right.
  \item Download the \texttt{.tex} or the \texttt{.pdf} when you are done.
\end{enumerate}

\end{document}
`;

const REPORT = String.raw`\documentclass[11pt,a4paper]{report}

\usepackage[margin=1in]{geometry}
\usepackage{amsmath}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Project Report}
\author{Your Name}
\date{\today}

\begin{document}
\maketitle
\tableofcontents

\chapter{Introduction}
\label{ch:intro}

Describe the problem here. Cross-references such as
Chapter~\ref{ch:results} resolve on the second pass.

\section{Background}

Some background material.

\chapter{Results}
\label{ch:results}

Report the findings, referring back to Chapter~\ref{ch:intro} as needed.

\end{document}
`;

const LETTER = String.raw`\documentclass[11pt]{letter}

\usepackage[margin=1in]{geometry}

\signature{Your Name}
\address{Your Street \\ Your City \\ Your Postcode}

\begin{document}

\begin{letter}{Recipient Name \\ Their Company \\ Their Address}

\opening{Dear Recipient,}

Write the body of the letter here. The \texttt{letter} class handles the
layout of the address blocks, the date, and the signature.

\closing{Yours sincerely,}

\end{letter}
\end{document}
`;

const BEAMER = String.raw`\documentclass{beamer}

\usetheme{default}
\usepackage{amsmath}

\title{A Talk}
\subtitle{Compiled in the browser}
\author{Your Name}
\date{\today}

\begin{document}

\frame{\titlepage}

\begin{frame}{Why this works}
  \begin{itemize}
    \item A real \TeX{} engine, compiled to WebAssembly.
    \item Packages are fetched from a static CDN, once, then cached.
    \item No server does any of the work.
  \end{itemize}
\end{frame}

\begin{frame}{Mathematics still works}
  \[
    \frac{\partial u}{\partial t} = \alpha \nabla^{2} u
  \]
\end{frame}

\end{document}
`;

const ARTICLE_MINIMAL = String.raw`\documentclass{article}
\begin{document}
Hello, \TeX{}.
\end{document}
`;

export const templates: Template[] = [
  {
    id: "article",
    name: "Article",
    description: "Sections, maths, a table — the default starting point.",
    source: ARTICLE,
  },
  {
    id: "report",
    name: "Report",
    description: "Chapters and a table of contents.",
    source: REPORT,
  },
  { id: "letter", name: "Letter", description: "A formal letter.", source: LETTER },
  {
    id: "beamer",
    name: "Presentation",
    description: "Beamer slides.",
    source: BEAMER,
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "The smallest document that compiles.",
    source: ARTICLE_MINIMAL,
  },
];

export const DEFAULT_SOURCE = ARTICLE;
