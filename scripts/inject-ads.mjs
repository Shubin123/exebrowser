#!/usr/bin/env node
// Adds the Mediavine ad tag to every page that should carry it and removes it
// from every page that shouldn't. The rule lives in scripts/ads.mjs.
// Idempotent; run it after the generators (README step 5c).
//
//   node scripts/inject-ads.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { AD_TAG, AD_TAG_RE, addRail, loadPages, noAdReason, stripRail } from "./ads.mjs";

const ROOT = resolve(process.cwd(), "public");
const bySlug = loadPages();

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) yield* htmlFiles(abs);
    else if (name.endsWith(".html")) yield abs;
  }
}

let added = 0, removed = 0, withAds = 0, without = 0;
for (const abs of htmlFiles(ROOT)) {
  const rel = relative(ROOT, abs).split("\\").join("/");
  const html = readFileSync(abs, "utf8");
  if (!/<\/head>/i.test(html)) continue; // fragments, not pages
  const stripped = stripRail(html.replace(AD_TAG_RE, ""));
  const want = noAdReason(rel, stripped, bySlug) === null;
  const next = want ? addRail(stripped.replace(/<\/head>/i, `${AD_TAG}\n</head>`)) : stripped;
  if (want) withAds++;
  else without++;
  if (next !== html) {
    writeFileSync(abs, next);
    if (want && !html.includes("scripts.mediavine.com/tags/")) added++;
    else if (!want) removed++;
  }
}
console.log(`ads: ${withAds} pages carry the tag, ${without} don't (added ${added}, removed ${removed})`);
