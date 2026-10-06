#!/usr/bin/env node
// Builds public/apps/puzzles/ from Simon Tatham's Portable Puzzle Collection.
//
//   node scripts/build-puzzles.mjs
//
// Needs emcc/emcmake and cmake on PATH (Homebrew's emscripten works). The
// pinned source tarball is downloaded once into assets-too-big-for-pages/
// and checked against its sha256, built to WebAssembly with the collection's
// own CMake setup, and each puzzle gets a frame page:
//   public/apps/puzzles/<name>.html   the puzzle's menu bar, canvas and status
//                                     bar, from upstream html/jspage.pl
//   public/apps/puzzles/<name>.js / .wasm
//   public/apps/puzzles/LICENCE.txt   the MIT licence, which must ship with it
//
// The frames keep the collection's own menus (game type, new, restart, undo,
// redo, solve) and drop everything around them: the upstream title, the
// instructions and the links back to chiark. Rules and instructions live on
// each /run/<slug>/ page instead, written for this site.
//
// Licence: MIT for all code; the puzzles draw everything in code, so there
// are no separate art or sound assets to clear. Commercial use is fine, so
// these pages may carry ads (provenance "open", adsOk).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "20260923.616da16";
const URL = `https://www.chiark.greenend.org.uk/~sgtatham/puzzles/puzzles-${VERSION}.tar.gz`;
const SHA256 = "cc419c8060b4e22be398aa03e30651fbce146eee510645c303fb6f5f1b77b78e";
const CACHE = path.join(ROOT, "assets-too-big-for-pages", "puzzles");
const SRC = path.join(CACHE, `puzzles-${VERSION}`);
const BUILD = path.join(CACHE, "build");
const OUT = path.join(ROOT, "public", "apps", "puzzles");

fs.mkdirSync(CACHE, { recursive: true });
const tarball = path.join(CACHE, `puzzles-${VERSION}.tar.gz`);
if (!fs.existsSync(tarball)) {
  // The unversioned puzzles.tar.gz is the same file on the day it was pinned.
  const fallback = path.join(CACHE, "puzzles.tar.gz");
  if (fs.existsSync(fallback)) fs.copyFileSync(fallback, tarball);
  else execFileSync("curl", ["-sSL", "--fail", "-o", tarball, URL], { stdio: "inherit" });
}
const sum = crypto.createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
if (sum !== SHA256) throw new Error(`puzzles tarball sha256 ${sum} != pinned ${SHA256}`);
if (!fs.existsSync(SRC)) execFileSync("tar", ["xzf", tarball, "-C", CACHE]);

// Emscripten 4+ refuses the collection's default browser floors (Firefox 68),
// so raise them to the oldest versions current emcc still targets.
execFileSync("emcmake", ["cmake", "-S", SRC, "-B", BUILD, "-DCMAKE_BUILD_TYPE=Release",
  "-DMIN_FIREFOX_VERSION=79", "-DMIN_CHROME_VERSION=85", "-DMIN_SAFARI_VERSION=150000"], { stdio: "ignore" });
execFileSync("cmake", ["--build", BUILD, "-j8"], { stdio: "ignore" });

// Generate upstream's pages, then cut them down to the playable part.
const pages = path.join(CACHE, "pages");
fs.rmSync(pages, { recursive: true, force: true });
fs.mkdirSync(pages);
fs.writeFileSync(path.join(pages, "footer.html"), "");
const htmlDir = path.join(SRC, "html");
const sources = fs.readdirSync(htmlDir).filter((f) => f.endsWith(".html"));
execFileSync("perl", [path.join(htmlDir, "jspage.pl"), "footer.html", ...sources.map((f) => path.join(htmlDir, f))], { cwd: pages });

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const f of sources) {
  const name = f.replace(/\.html$/, "");
  if (/^unfinished:/.test(fs.readFileSync(path.join(htmlDir, f), "utf8"))) continue;
  const wasm = path.join(BUILD, `${name}.wasm`);
  if (!fs.existsSync(wasm)) continue;
  const page = fs.readFileSync(path.join(pages, f), "utf8");
  const head = page.slice(0, page.indexOf("</head>"));
  const main = page.slice(page.indexOf('<main id="puzzle"'), page.indexOf("</main>") + "</main>".length)
    // The permalink line points at chiark-style URLs; inside our frame it
    // only confuses.
    .replace(/\s*<p>\s*Link to this puzzle:[\s\S]*?<\/p>/, "")
    // Fit-to-container mode instead of the drag-to-resize box. emccpre.js
    // sizes the puzzle to #puzzlecanvascontain when that element exists (it
    // was written for KaiOS phones), so the grid fills whatever the iframe
    // gives it, phone or desktop, and re-fits on resize. The resize handle
    // would otherwise leave a 480px default grid overflowing a phone.
    .replace(/<div id="resizable">[\s\S]*?<\/svg>\s*<\/div>/,
      '<div id="puzzlecanvascontain"><canvas id="puzzlecanvas" tabindex="0"></canvas></div>\n  <div id="statusbar"></div>');
  if (!main.includes("puzzlecanvascontain")) throw new Error(`${name}: page layout changed upstream; fit-mode rewrite failed`);
  const title = (head.match(/<title>(.*?), from/) || [, name])[1];
  const html = `${head.replace(/<meta http-equiv[^>]*>/, '<meta charset="utf-8">').replace(/<title>.*?<\/title>/, `<title>${title}</title>`)}
<style>
html, body { height: 100%; }
body { margin: 0; background: #fff; color: #000; font-family: system-ui, sans-serif; display: flex; flex-direction: column; }
/* Visible from the start (upstream hides it until the puzzle has loaded):
   fit mode measures #puzzlecanvascontain while setting up, and a hidden
   container measures 0x0, which made every puzzle a 10px speck. */
main#puzzle { flex: 1; min-height: 0; flex-direction: column; padding-top: 6px; display: flex !important; }
#puzzlecanvascontain { flex: 1; min-height: 0; margin: 6px 8px 0; display: flex; align-items: center; justify-content: center; }
#puzzlecanvas { display: block; }
#statusbar { min-height: 1.2em; font-size: 13px; text-align: center; }
#apology { padding: 1em; text-align: center; }
.credit { text-align: center; font-size: 11px; color: #666; margin: 4px 0 6px; }
.credit a { color: #666; }
</style>
<meta name="robots" content="noindex">
</head>
<body>
${main}
<div id="apology"><p>Loading the puzzle&hellip; If this message stays, your browser may have WebAssembly turned off.</p></div>
<p class="credit">From <a href="https://www.chiark.greenend.org.uk/~sgtatham/puzzles/" target="_blank" rel="noopener">Simon Tatham's Portable Puzzle Collection</a> · <a href="LICENCE.txt" target="_blank">MIT licence</a></p>
</body>
</html>
`;
  fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  fs.copyFileSync(path.join(BUILD, `${name}.js`), path.join(OUT, `${name}.js`));
  fs.copyFileSync(wasm, path.join(OUT, `${name}.wasm`));
  n++;
}
fs.copyFileSync(path.join(SRC, "LICENCE"), path.join(OUT, "LICENCE.txt"));
console.log(`built ${n} puzzles into ${path.relative(ROOT, OUT)}`);
