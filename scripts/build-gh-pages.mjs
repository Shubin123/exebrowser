#!/usr/bin/env node
// Builds the GitHub Pages copy of the site into _site/, which
// .github/workflows/gh-pages.yml uploads.
//
//   node scripts/build-gh-pages.mjs                  # base from GITHUB_REPOSITORY, else /exebrowser/
//   node scripts/build-gh-pages.mjs --base / --out /tmp/site
//
// public/ is written for Cloudflare Pages at the root of a domain, and GitHub
// Pages differs from that in four ways this script makes up for:
//
//   - The site is served under /<repo>/, so every absolute path ("/app.js",
//     href="/run/", url(/icons/…)) gets the base in front. Only paths whose
//     first segment is a real entry of public/ are touched, so emulator
//     strings like "/dev/null" or "/home/web_user" are left alone, and the
//     third-party runtimes in VENDOR are not rewritten at all.
//   - There are no Functions. /api/fs/, /api/overlay/ and /api/bwfs/ proxy the
//     Wine roots, and their upstreams can't be fetched from here directly: the
//     Worker only sends CORS for exebrowser.com and boxedwine.org sends none.
//     So the roots are downloaded (pinned by sha256) into boxedwine/fs/ and
//     served next to the pages; GitHub Pages answers Range requests, which is
//     all the on-demand engines need. /api/subscribe has nowhere to go, so the
//     newsletter form is dropped.
//   - _headers and _redirects are Cloudflare's and mean nothing here. No page
//     outside /64/ needs a header, and /64/ gets cross-origin isolation from
//     its coi-serviceworker. /64/'s wasm and file systems are gitignored and
//     reach exebrowser.com from a local disk, so they are fetched from there.
//   - Upstream's Google Analytics and Mediavine tags carry exebrowser.com's
//     account IDs, so they are taken out of every page.
//
// Every targeted patch below states how many times it must apply, and the
// build fails if it doesn't, so a change to the patched code can't silently
// leave this copy broken.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const CACHE = path.join(ROOT, "assets-too-big-for-pages", "gh-pages-roots");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repo = (process.env.GITHUB_REPOSITORY || "").split("/")[1];
let BASE = arg("--base") ?? (repo ? `/${repo}/` : "/exebrowser/");
BASE = ("/" + BASE + "/").replace(/\/+/g, "/");
const P = BASE.slice(0, -1); // "/exebrowser", or "" at the root of a domain
const OUT = path.resolve(arg("--out") || path.join(ROOT, "_site"));

// The roots the /api/ Functions proxy, by the name each engine asks for.
const ROOTS = [
  {
    file: "fullWine1.7.55-v8.zip",
    url: "https://www.boxedwine.org/boxedwine/fs/fullWine1.7.55-v8.zip",
    sha256: "0fccfd4239406364c8d5707960411131ab9841056de83e0c27c053a9d4f93c44",
  },
  {
    file: "minWine31v6.zip",
    url: "https://www.boxedwine.org/boxedwine/fs/minWine31v6.zip",
    sha256: "9b35aeb8b81056916c6120ec4b38567d548d26b32e10aae1be1bf9603db341ad",
  },
  {
    file: "wine1.7.55-v8-with-gecko.zip",
    url: "https://github.com/andrewnakas/exebrowser-assets/releases/download/runtime-v0.1/wine1.7.55-v8-with-gecko.zip",
    sha256: "5187a33fd811b9407c3c4cbdf7b5d6f2c1b30c956488cb857c7d6c1ed5e485dd",
  },
  {
    // The jit engine's rootBootChunks list is tied to this exact file.
    file: "TinyCore15Wine11.0-web.zip",
    url: "https://boxedwine.org/v2/23/TinyCore15Wine11.0-web.zip",
    sha256: "4d505092956dd78e36712dac8111c252e5d1b859ce2373fbe7c80242bb65ad47",
  },
];
const ROOTS_DIR = "boxedwine/fs/";

// Third-party runtimes: not rewritten. Their own absolute strings are file
// system paths inside the emulator, not URLs on this site.
const VENDOR = [
  /^boxedwine\/build\//,
  /^dosbox(-snap)?\//,
  /^64\/(boxedwine64|boxedwine-shell|coi-serviceworker)\.js$/,
  /^apps\/.*\.js$/,
];
const TEXT = /\.(html|css|js|mjs|json|webmanifest)$/;
const SKIP = new Set(["_headers", "_redirects", ".DS_Store"]);

// ─── copy ──────────────────────────────────────────────────────────────────

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(PUBLIC, OUT, {
  recursive: true,
  filter: (src) => !SKIP.has(path.basename(src)),
});

// ─── Wine roots ────────────────────────────────────────────────────────────

const sha256 = (...files) => {
  const h = crypto.createHash("sha256");
  for (const f of files) h.update(fs.readFileSync(f));
  return h.digest("hex");
};
const download = (url, to) => {
  console.log("downloading", url);
  execFileSync("curl", ["-sSL", "--fail", "--retry", "3", "-o", to, url], { stdio: "inherit" });
};

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.join(OUT, ROOTS_DIR), { recursive: true });
for (const r of ROOTS) {
  const cached = path.join(CACHE, r.file);
  if (!fs.existsSync(cached) || sha256(cached) !== r.sha256) download(r.url, cached);
  const sum = sha256(cached);
  if (sum !== r.sha256) throw new Error(`${r.file}: sha256 ${sum} != pinned ${r.sha256}`);
  fs.copyFileSync(cached, path.join(OUT, ROOTS_DIR, r.file));
}

// ─── /64/ ──────────────────────────────────────────────────────────────────
// The 64-bit engine's emscripten glue (boxedwine64.js) is committed and
// byte-identical to what exebrowser.com/64/ serves, so it matches that wasm;
// the wasm and the file systems aren't in git, so they
// come from there, pinned by sha256: the wasm, and each file system's parts
// end to end, as the launcher stitches them. They were built from
// andrewnakas/Boxedwine64 at 806e248f. If they can't be had, /64/ becomes a
// page saying where the 64-bit engine runs, rather than one that loads and
// then fails, and the Actions run carries a warning.

const X64_FROM = "https://exebrowser.com/64/";
const X64_CACHE = path.join(ROOT, "assets-too-big-for-pages", "gh-pages-64");
const X64 = [
  { name: "boxedwine64.wasm", sha256: "7850a5095a4787b915670e0e2c4d94d66e7358ea7d8c5dc90ccc01522c42fdf6" },
  { name: "glibc-rootfs64.zip", sha256: "81988f8813c71829dc3c10568af3b5070c7e74465a017aa1bc1b34b608d0ab8b" },
  { name: "prefix64.zip", sha256: "95ff3e7ab24313fa957492aae5e9c336079df440ec8f6a327e7983ad2e8a7b5f" },
  { name: "wine64.zip", sha256: "6dac17bdb9a525d9cfd766fed61767241e60ef135a1512fc3524e63db7912597" },
];

function fetch64() {
  fs.mkdirSync(X64_CACHE, { recursive: true });
  for (const x of X64) {
    const manifest = path.join(PUBLIC, "64", x.name + ".manifest.json");
    const parts = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).parts : [x.name];
    const cached = parts.map((f) => path.join(X64_CACHE, f));
    const ok = () => cached.every((f) => fs.existsSync(f)) && sha256(...cached) === x.sha256;
    if (!ok()) {
      for (const [i, f] of parts.entries()) download(X64_FROM + f, cached[i]);
      if (!ok()) throw new Error(`${x.name}: sha256 doesn't match the pinned ${x.sha256}`);
    }
    for (const [i, f] of parts.entries()) fs.copyFileSync(cached[i], path.join(OUT, "64", f));
  }
}

if (!fs.existsSync(path.join(PUBLIC, "64", "boxedwine64.wasm"))) {
  try {
    fetch64();
  } catch (e) {
    console.log(`::warning::/64/ has no engine on this copy: ${e.message}`);
    const frame = fs.readFileSync(path.join(PUBLIC, "offline", "index.html"), "utf8");
    const page = frame
      .replace(/<title>[^<]*<\/title>/, "<title>64-bit engine — ExeBrowser</title>")
      .replace(/<section class="card">[\s\S]*?<\/section>/, `<section class="card">
    <h1>The 64-bit engine isn't on this copy</h1>
    <p>This copy of ExeBrowser couldn't fetch the experimental 64-bit engine's runtime and Wine files when it was built. It runs at <a href="https://exebrowser.com/64/">exebrowser.com/64/</a>; pick your file again there.</p>
    <p><a class="button primary" href="/load-exe/">Back to the loader</a></p>
  </section>`);
    if (page === frame || !page.includes("isn't on this copy")) throw new Error("offline/index.html changed shape");
    for (const f of ["index.html", "wine64.html"]) fs.writeFileSync(path.join(OUT, "64", f), page);
  }
}

// ─── rewrite ───────────────────────────────────────────────────────────────

const top = fs.readdirSync(PUBLIC).filter((n) => !SKIP.has(n));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOP = [...top, "api"].map(esc).join("|");
// A quote, then "/" and a first segment that exists, then the end of it.
const ABS = new RegExp(`(["'\`])/(?=(?:${TOP})(?:[/"'\`?#]|$))`, "g");

// [file pattern, search, replace, times it must apply in the whole build]
const PATCHES = [
  // The Wine roots now sit at boxedwine/fs/ (before ABS adds the base).
  [/^app\.js$/, /"\/api\/(?:fs|overlay|bwfs)\/"/g, `"/${ROOTS_DIR}"`, 5],
  [/^boxedwine\/build\/default\/browserfs\.boxedwine\.js$/, /"\/api\/fs\/"/g, `"${P}/${ROOTS_DIR}"`, 1],
  // Per-page save slugs come from the path; keep them the same as on the
  // real site rather than "exebrowser/load-exe".
  [/^(app|embed)\.js$/, /location\.pathname === "\/"/g, `location.pathname === "${P}/"`, 2],
  [/^(app|embed)\.js$/, /location\.pathname\.replace\(\/\^\\\/\|\\\/\$\/g, ""\)/g,
    `location.pathname.replace(/^${esc(P).replace(/\//g, "\\/")}\\/|\\/$/g, "")`, 2],
  [/^sw\.js$/, /\/\^\\\/\(64\|apps\|api\)\\\/\//g, `/^${esc(P).replace(/\//g, "\\/")}\\/(64|apps|api)\\//`, 1],
  // /64/ gets isolation from coi-serviceworker here, not from headers, and
  // the site's own sw.js (scope: the whole site) may already control the page.
  // coi took that worker for its own failing one, reloaded once to "degrade",
  // and never registered; it now only counts itself.
  [/^64\/coi-serviceworker\.js$/, /const controlling = n\.serviceWorker && n\.serviceWorker\.controller;/g,
    "const controlling = n.serviceWorker && n.serviceWorker.controller &&\n" +
    "            /\\/coi-serviceworker\\.js$/.test(n.serviceWorker.controller.scriptURL);", 1],
  [/^64\/coi-serviceworker\.js$/, /registration\.active && !n\.serviceWorker\.controller/g,
    "registration.active && !controlling", 1],
  // It also reloaded on updatefound, before the new worker was active, so the
  // reload often went out unintercepted and, having "reloaded by itself",
  // it never tried again. Reload once the worker is activated.
  [/^64\/coi-serviceworker\.js$/, /(registration\.addEventListener\("updatefound", \(\) => \{\n)(\s+!coi\.quiet && console\.log\("Reloading page to make use of updated COOP\/COEP Service Worker\."\);\n\s+window\.sessionStorage\.setItem\("coiReloadedBySelf", "updatefound"\);\n\s+coi\.doReload\(\);\n)/g,
    'registration.addEventListener("updatefound", () => {\n' +
    "                    const sw = registration.installing;\n" +
    "                    const reload = () => {\n" +
    '                        !coi.quiet && console.log("Reloading page to make use of updated COOP/COEP Service Worker.");\n' +
    '                        window.sessionStorage.setItem("coiReloadedBySelf", "updatefound");\n' +
    "                        coi.doReload();\n" +
    "                    };\n" +
    "                    if (!sw) return reload();\n" +
    '                    sw.addEventListener("statechange", () => { if (sw.state === "activated") reload(); });\n', 1],
  // A page that isn't isolated yet is about to be reloaded by coi, so leave
  // the file handed over from /load-exe/ (and #handoff) for the page that is.
  [/^64\/wine64-launcher\.js$/, /if \(window\.location\.hash !== "#handoff" \|\| !window\.ExeHandoff\) return;/g,
    'if (window.location.hash !== "#handoff" || !window.ExeHandoff) return;\n' +
    "        if (window.crossOriginIsolated === false) return;", 1],
  // ScummVM's wasm fetches its data from DATA_PATH, "/data", by absolute path
  // (why public/data/ exists); these two helpers turn that path into a URL.
  [/^apps\/scummvm\/scummvm\.js$/, /url=UTF8ToString\(url\);/g,
    `url=UTF8ToString(url);if(url.startsWith("/data/"))url=${JSON.stringify(P)}+url;`, 2],
  // Upstream's analytics and ads.
  [/\.html$/, /<script[^>]*googletagmanager\.com\/gtag\/js[^>]*><\/script>\s*/g, "", null],
  [/\.html$/, /<script[^>]*scripts\.mediavine\.com[^>]*><\/script>\s*/g, "", null],
  // The newsletter posts to a Function.
  [/\.html$/, /\s*<section class="card newsletter">[\s\S]*?<\/section>/g, "", null],
];
const applied = PATCHES.map(() => 0);
const absByFile = new Map();

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (TEXT.test(e.name)) rewrite(full, path.relative(OUT, full).split(path.sep).join("/"));
  }
}

function rewrite(full, rel) {
  // latin1 round-trips every byte, so files that aren't valid UTF-8 survive.
  let s = fs.readFileSync(full, "latin1");
  const before = s;
  PATCHES.forEach(([file, re, to], i) => {
    if (!file.test(rel)) return;
    s = s.replace(re, () => (applied[i]++, to));
  });
  if (P && !VENDOR.some((v) => v.test(rel))) {
    let n = 0;
    s = s.replace(ABS, (_, q) => (n++, q + P + "/"));
    // HTML: the site root itself, href="/" and href="/#…".
    if (rel.endsWith(".html")) {
      s = s.replace(/(\s(?:href|src|action|content)=["'])\/(?=["'#?])/g, (_, a) => (n++, a + P + "/"));
    }
    if (rel.endsWith(".webmanifest")) s = s.replace(/"\/(?=["?#])/g, () => (n++, `"${P}/`));
    if (/\.(css|html)$/.test(rel)) {
      s = s.replace(/url\((["']?)\/(?!\/)/g, (_, q) => (n++, `url(${q}${P}/`));
    }
    if (n) absByFile.set(rel, n);
  }
  if (s !== before) fs.writeFileSync(full, s, "latin1");
}

walk(OUT);

PATCHES.forEach(([file, re, , want], i) => {
  if (want !== null && applied[i] !== want) {
    throw new Error(`patch ${re} on ${file}: applied ${applied[i]} times, expected ${want}`);
  }
});

// Make sure no page still points at a Function.
const left = [];
(function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) scan(full);
    else if (/\.(html|js)$/.test(e.name) && new RegExp(`["'\`]${esc(P)}/api/`).test(fs.readFileSync(full, "latin1"))) {
      left.push(path.relative(OUT, full));
    }
  }
})(OUT);
if (left.length) console.warn("still referencing /api/:", left.join(", "));

if (process.argv.includes("--report")) {
  for (const [rel, n] of [...absByFile].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(6), rel);
}
console.log(`built ${path.relative(ROOT, OUT) || OUT} for ${BASE}: ` +
  `${absByFile.size} files rewritten, patches applied ${applied.join("/")}`);
