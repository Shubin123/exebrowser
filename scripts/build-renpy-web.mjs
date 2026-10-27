#!/usr/bin/env node
// Fetches Ren'Py's web runtime into public/renpy/<version>/ from the pinned
// release on renpy.org.
//
//   node scripts/build-renpy-web.mjs
//
// The loader (app.js runRenpy) runs Ren'Py games on it instead of Wine: a
// Ren'Py game's .exe only starts the 64-bit Python it bundles, while its game
// data and Ren'Py's own Python files run unchanged on the same Ren'Py version
// built for the web. The runtime (~37 MB) is gitignored, like public/64/ and
// LibreQuake: this script is the record of exactly what ships. It downloads the
// release once into assets-too-big-for-pages/, checks its sha256 (the one
// renpy.org publishes in checksums.txt), and writes renpy.js, renpy.wasm,
// renpy.data and renpy-pre.js. index.html and NOTICE.md there are ours and
// are committed. Each file is under the 25 MB Pages cap.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "8.5.3";
const RELEASE = `https://www.renpy.org/dl/${VERSION}/renpy-${VERSION}-web.zip`;
const SHA256 = "954db897e65f51ea63cb2fb7b203d02be0447f4e22069514020bbe6c6691fdfc";
const FILES = ["renpy.js", "renpy.wasm", "renpy.data", "renpy-pre.js"];
const CACHE = path.join(ROOT, "assets-too-big-for-pages", "renpy");
const OUT = path.join(ROOT, "public", "renpy", VERSION);

fs.mkdirSync(CACHE, { recursive: true });
const zip = path.join(CACHE, `renpy-${VERSION}-web.zip`);
const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
if (!fs.existsSync(zip) || sha256(zip) !== SHA256) {
  console.log("downloading", RELEASE);
  execFileSync("curl", ["-sSL", "--fail", "--retry", "3", "-o", zip, RELEASE], { stdio: "inherit" });
}
const sum = sha256(zip);
if (sum !== SHA256) throw new Error(`renpy-${VERSION}-web.zip sha256 ${sum} != pinned ${SHA256}`);

fs.mkdirSync(OUT, { recursive: true });
execFileSync("unzip", ["-o", "-q", "-j", zip, ...FILES.map((f) => "web/" + f), "-d", OUT], { stdio: "inherit" });

let total = 0;
for (const f of FILES) {
  const n = fs.statSync(path.join(OUT, f)).size;
  total += n;
  console.log(path.relative(ROOT, path.join(OUT, f)), n);
}
console.log(`total ${(total / 1e6).toFixed(1)} MB`);
