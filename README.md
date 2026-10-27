# ExeBrowser

Run Windows `.exe` files directly in your browser using WebAssembly + Wine. No installation, no upload. Live at https://exebrowser.com.

Built on [Boxedwine](https://www.boxedwine.org/) (Wine + a 32-bit x86 CPU emulator compiled to WebAssembly).

## This is a fork

This repository is a fork of
[andrewnakas/exebrowser](https://github.com/andrewnakas/exebrowser), branched
at `b353806` with no changes of its own before that point. The fork's work is
on emulator performance and on what happens with 64-bit programs. From
[Architecture](#architecture) down, this README documents the site as a whole.

### What the fork adds

- **Run refuses 64-bit EXEs up front.** The loader reads the PE header's
  Machine field itself, without needing `pe-inspect.js`. For anything that
  isn't i386 it shows a message where the program would have drawn, with the
  handoff to `/64/`, and downloads nothing. Before, Wine 1.7.55 logged "Bad
  EXE format" and the page sat on a black screen saying "Running…". A 32-bit
  program that tries to start a 64-bit one (a launcher, a `.bat`) gets the
  same message, taken from Wine's console line.
- **An opt-in JIT engine.** Upstream Boxedwine compiles hot x86 blocks to
  WebAssembly. See [The JIT engine (beta)](#the-jit-engine-beta) for how it
  is built and served. It is opt-in: the engine picker on `/load-exe/`, or
  `?engine=jit` on any page.
- **Faster JIT-engine boot.** It fetches the Wine root's boot pieces in
  parallel before starting, instead of one blocking request at a time.
- **A centred canvas.** A canvas narrower than its frame (the JIT engine
  sizes it to a game's GL window) now stays centred.
- **A GitHub Pages copy**, at https://shubin123.github.io/exebrowser/, so the
  fork's changes can be tried without a Cloudflare account. See
  [GitHub Pages](#github-pages).
- **Ren'Py games run.** A Ren'Py game's `.exe` only launches the 64-bit
  Python it bundles, so Wine here can't start it. Picking the game's folder,
  or a zip of it, now runs it on Ren'Py's official web runtime instead. The
  loader packs `game.zip` in the browser the way Ren'Py's own web build does
  (`main.py`, the compiled `renpy/`, and `game/`), and nothing is uploaded.
  The runtime is Ren'Py 8.5.3, fetched by `scripts/build-renpy-web.mjs`. A
  game's `renpy/` files have to match it, so games made with other Ren'Py
  versions get a message saying so. Picking only the launcher `.exe` explains
  that the game is the folder. A Ren'Py game is never sent to `/64/`, even
  with "wine64" picked. That page runs one `.exe`, so it got the launcher on
  its own, which only says "This program requires Windows 10 or greater to
  run." `/64/`'s own upload explains this instead of running the launcher.
- **Dropping a folder works, and reading shows progress.** A dropped folder
  arrives in the drop event as one entry that can't be read, and the loader
  tried to read it as a file, so nothing happened. It now walks the folder.
  While a folder or zip is read, the drop area shows a file count, the MB so
  far and a bar; a 240 MB game used to leave the page still for the whole
  read.
- **The 64-bit hand-off works.** The file you pick on `/load-exe/` now runs
  in `/64/`, on exebrowser.com too. Before, `/64/` booted only
  `wine64 --version` and wrote the file before the Wine prefix's home
  existed, so the write failed and the file was dropped. It now boots Notepad
  to bring up the prefix and session, creates the home directory, and waits
  for the session before spawning the file.

### Measured (headless Chrome, Apple M4)

A no-CRT 32-bit benchmark (sieve, crc32, x87 matmul, `rep movsb`, a switch
interpreter, fib) gives the same checksums on every engine:

| | Default engine (2019 build, Wine 1.7.55) | JIT engine (upstream `8ab37e7b`, Wine 11) |
|---|---|---|
| Benchmark total, lower is better | 1,553–1,629 ms | 403–412 ms |
| First window, fresh prefix | 2–3 s | 10.5–11 s (12 s at 60 ms latency) |
| First-visit download | 60 MB | 63 MB |
| Direct3D 9 (device + clear + present) | `CreateDevice` fails, `D3DERR_INVALIDCALL` | renders, through WineD3D → OpenGL → WebGL |

The same upstream commit built without the JIT scores 1,743 ms, so the
speed-up comes from the JIT, not from a newer emulator. On console programs
with the Wine 1.7.55 root the JIT build scores 272 ms. SkiFree, 7-Zip and
Notepad++ behave the same on both engines; Notepad++ stops at its
`langs.xml` dialog on both.

### Why the JIT engine isn't the default yet

Current upstream Boxedwine boots the default engine's `fullWine1.7.55-v8`
root, and console programs run. But several Wine processes then crash on
`Unhandled page fault on read access to 0xffffffff at address 0xc0dd8382`,
and no window is ever drawn. The interpreter build of the same commit fails
the same way, so the JIT is not the cause. The crash disappeared when the
boot was slowed by syscall logging, which points to a race. The JIT engine
therefore boots upstream's own web root, `TinyCore15Wine11.0-web.zip`.

To make the JIT the default, either:

- find the 1.7.55 regression (bisect upstream), or
- retest the hosted catalogue on Wine 11.

The JIT engine also starts slower, because Wine 11 starts more services.
Threaded builds (`multiThreadedJit`) need COOP/COEP, which the ad pages can't
send, so only the single-threaded `jit` target is usable here.

### Findings on the other Boxedwine forks

- **[danoon2/Boxedwine](https://github.com/danoon2/Boxedwine)** (upstream)
  - It already has the tiered 32-bit x86→WebAssembly JIT, so the fork uses
    it instead of writing one.
  - `make jit WASM_PROFILING=1` names the generated blocks for profiling in
    Chrome DevTools.
  - Its web build already routes Direct3D through WineD3D to WebGL, using the
    `drive_c/webgl` DLLs in the Wine 11 root.
- **[andrewnakas/Boxedwine64](https://github.com/andrewnakas/Boxedwine64)**
  - Its head (`58ecb0ff`) boots Debian wine64 8.0 to notepad, and CI
    smoke-tests that. The check is weak: a window mapped and the canvas
    partly lit.
  - `/64/` here runs `806e248f` (June 2026), about 4.5 months behind head.
  - x86-64 is interpreter-only, with no JIT. There is no memory protection
    or page-fault signal, and no AVX.
  - General 64-bit app support looks 6–12+ months away.
  - Its self-test passes 907/907.
  - Its lazy HTTP-Range zip mount needs pthreads, so the single-threaded
    32-bit engine can't use it.
- **[Kn0tzer/Boxedwine64](https://github.com/Kn0tzer/Boxedwine64)**
  - Agent-built: about 1,300 commits in 3½ weeks.
  - Its x86-64→WebAssembly JIT is real but opt-in, and about 1.27× faster
    on its one benchmark.
  - DXVK and vkd3d-proton run over a Vulkan command stream replayed on
    WebGPU.
  - The D3D "pixel tests" run on SwiftShader and have no reference images.
  - Its own results record D3D9 drawing black and D3D10 drawing nothing.
  - It can't be rebuilt from what is published: its runtime tarball is in an
    unpublished release.
  - The only cherry-pick candidates are its 32-bit SSE3–SSE4.2 instruction
    additions, which were not tested here.

### On a WebGPU path

For Direct3D up to 9, WineD3D's OpenGL backend over WebGL already works in
the JIT engine, so WebGPU would buy little. WebGPU matters for D3D10–12,
through DXVK or vkd3d. That is mostly 64-bit software, and the only
prototype (Kn0tzer's) doesn't yet draw D3D9 or D3D10 correctly. It is parked
until 64-bit programs run.

## Architecture

```
exebrowser.com   ────►  public/                 (Cloudflare Pages — static)
                          index.html, app.js, style.css
                          boxedwine/build/default/*    (runtime, ~2.5MB)
                          boxedwine/apps/*-min-online.zip  (overlay, ~9.3MB)

                ────►  boxedwine-assets.exebrowser.workers.dev  (Cloudflare Worker)
                          /fs/fullWine1.7.55-v8.zip   (50MB Wine root, range-fetched)
```

The Worker proxies the 50MB Wine root from `boxedwine.org` with CORS + range support (Cloudflare Pages free tier caps file size at 25MB).

## Local dev

```bash
# (one-time) fetch the Boxedwine runtime
./scripts/fetch-runtime.sh

# serve public/ on http://localhost:8765
python3 -m http.server 8765 --directory public
```

For local testing without the Worker, edit `public/app.js` and change `ROOT_FS_URL` to point at a local copy.

## Adding or changing a game

Every `/run/<slug>/` page is generated from `scripts/app-pages.json` — never
hand-edit the HTML, it gets overwritten.

Run all seven, in this order — the last two depend on the output of the others,
and running them out of order silently loses work:

```bash
# 1. all /run/ pages, the hub, /play/ category pages, 404, sitemap, feed, llms.txt
node scripts/gen-app-pages.mjs

# 1b. localised copies of the hand-maintained utility pages (/es/load-exe/ etc).
#     After step 1, because step 1 owns the sitemap and lists what this writes.
node scripts/gen-static-pages.mjs

# 2. the homepage's shelf, filter, ItemList and blog strip, in place
node scripts/gen-home-grid.mjs

# 3. /unblocked/ — the intent-modifier landing page
node scripts/gen-unblocked.mjs

# 4. /embed/ — the hub for the embed offer
node scripts/gen-embed-hub.mjs

# 5. head links onto the ~35 hand-maintained pages the generators don't own
node scripts/inject-page-links.mjs

# 5b. /embed/<slug>/ wrappers for our own games (a new own-work game fails
#     step 6 until this has run)
node scripts/gen-embeds.mjs

# 5c. the Mediavine ad tag: added where scripts/ads.mjs allows it, removed
#     everywhere else. Generators write pages without it, so this runs LAST;
#     step 6 fails if any page disagrees with the rule.
node scripts/inject-ads.mjs

# 6. check nothing drifted out of sync
node scripts/check-consistency.mjs
```

Some game data is too large for git and is gitignored, like `public/64/`. It
is rebuilt from a pinned, checksummed upstream release, and **must be on disk
before `wrangler pages deploy`**, or the deploy ships a page whose game 404s:

```bash
node scripts/build-librequake-data.mjs   # public/apps/librequake/id1/ (~79 MB)
node scripts/build-warzone2100-data.mjs  # public/apps/warzone2100/ parts, wasm, music (~87 MB)
node scripts/build-renpy-web.mjs         # public/renpy/8.5.3/ Ren'Py's web runtime (~37 MB)
```

### The logic puzzles

`public/apps/puzzles/` is Simon Tatham's Portable Puzzle Collection (MIT),
built from a pinned, sha-checked source tarball by
`node scripts/build-puzzles.mjs` (needs emcc and cmake). The output is small
and committed. Each frame uses the collection's fit-to-container mode, so a
puzzle fills its iframe at any width; its `/run/` page sets `iframeHeight`
rather than the default 16:10 box.

### Adding a DOS game

Every hosted title carries a `provenance` in `app-pages.json`: `clean`,
`open`, `freeware`, `shareware` or `grey`. Grey means abandoned: a commercial
game that no store sells today, hosted under the `/takedown/` policy. The
consistency check holds grey titles to three rules. They never get `adsOk`.
They need `public/apps/<slug>/NOTICE.md` with a `Not sold:` line naming the
stores checked and the date. And no title marked `sold` may be hosted.

```bash
# 1. pin the source in scripts/dos-sources.json (url, sha256, exe, strip, cycles)
node scripts/make-dos-bundle.mjs <slug>     # → public/apps/<slug>/<slug>.zip
# 2. it must draw a picture before its page may say "play"
node scripts/boot-test.mjs <slug> [--keys Enter] [--shot]
```

`boot-test.mjs` serves `public/` itself and loads the bundle into a bare DOS
embed, so a title can be tested before it has a page. It judges the
emulator's canvas buffer, not a page screenshot. `--shot` writes the page
screenshot from that same canvas. Failures land in
`assets-too-big-for-pages/boot-shots/` to look at.

Steps 3 and 4 were previously undocumented, which is how `/unblocked/` came to
sit on a stale `save-core.js` version: every other generator was bumped, that
one was not, and it would have reverted the page the next time anyone ran it.
The consistency check now fails when one asset is referenced at two versions.

The consistency check exists because the same class of bug kept recurring:
a page states something that was true when written and quietly stopped being
true when a game was added or a payload rebuilt. It verifies that hosted
payloads exist and fit the 25 MB Cloudflare Pages limit, that declared
screenshots are on disk, that **every** internal link resolves (not just
`/run/` ones — `_redirects` rules count as resolving), that hreflang
alternates exist and point back, that the sitemap lists every indexable page
and nothing else, that the blog compatibility table matches the live verdicts,
that no hosted game still claims it can't be played here, that guides link to
the playable version of the game they describe, that every `/play/`
category page carries its word floor of original prose, that no `related` card
links to the page it sits on or contradicts its own title, and that a localised
page translates every prose field its English original fills rather than
silently falling back to English. It exits non-zero, so
it can gate a deploy.

## After deploying

```bash
npx wrangler pages deploy public --project-name=exebrowser --branch=main
node scripts/indexnow.mjs        # tell Bing/DuckDuckGo/Yandex what changed
```

`--branch=main` is mandatory, not tidiness. Without it wrangler infers the
branch from git and ships a *preview* deployment, which succeeds, prints a URL,
and leaves production untouched.

`indexnow.mjs` is not optional housekeeping: Bing is this site's largest search
channel by roughly two to one, IndexNow gets URLs crawled in hours rather than
weeks, and Google ignores it entirely (Search Console is the only lever there).
Run it *after* the deploy is live — the endpoint fetches the URLs to verify
them, so submitting first wastes the ping.

**`window.__I18N` must be emitted before the scripts that read it.** embed.js,
app.js and dos-embed.js are IIFEs that run on parse, so a translation block
placed after them is set too late: every `T()` silently returns its English
fallback and you get a fully translated page wrapping an English application.
Nothing fails, and the HTML looks correct. Only loading the page shows it.

**Always boot-test a new payload before writing "play online" copy** — judge
the canvas buffer, not a screenshot of the page around it, and check the DOS
banner in the console output to confirm which edition of an engine you're
actually running.

## Deploy

### Worker (one-time)

```bash
cd worker
npx wrangler deploy
# Note the deployed URL, update ROOT_FS_URL in public/app.js if it differs
```

### Pages

```bash
npx wrangler pages deploy public --project-name=exebrowser --branch=main
```

Then in the Cloudflare dashboard:
1. Add custom domain `exebrowser.com` and `www.exebrowser.com`
2. Verify `_headers` is applied (COOP/COEP must be present for SharedArrayBuffer)

### GitHub Pages

`.github/workflows/gh-pages.yml` publishes a copy on every push to `main`,
at `https://<owner>.github.io/<repo>/`. In the repo settings, Pages' source
must be "GitHub Actions". The copy is built by `scripts/build-gh-pages.mjs`,
which you can run yourself (`node scripts/build-gh-pages.mjs`, output in
`_site/`). It changes four things:

- **The base path.** The site is served under `/<repo>/`, so the build
  prefixes the site's absolute paths. It leaves the third-party runtimes
  alone, apart from patching ScummVM's data fetches.
- **The Wine roots.** There are no Functions. The four roots that `/api/fs/`,
  `/api/overlay/` and `/api/bwfs/` proxy (~210 MB, pinned by sha256) are served
  from `boxedwine/fs/` next to the pages. GitHub Pages answers Range requests,
  so both engines still read them on demand.
- **What's left out.** Upstream's Google Analytics and Mediavine tags, which
  carry exebrowser.com's account IDs, are removed. So is the newsletter form,
  which posts to a Function.
- **`/64/`.** Its wasm and file systems (~225 MB) aren't in git. The build
  fetches the ones exebrowser.com/64/ serves, pinned by sha256, and the
  committed glue matches them byte for byte. GitHub Pages can't send
  COOP/COEP, so `/64/` gets cross-origin isolation from its
  `coi-serviceworker` instead. The build patches that worker twice. It took
  the site's own `sw.js` for itself and gave up. It also reloaded before its
  worker was active, which made it fail at random. If the fetch fails, `/64/`
  becomes a page pointing at exebrowser.com/64/, and the Actions run carries a
  warning.

The workflow also runs the LibreQuake, Warzone 2100 and Ren'Py web-runtime
scripts, so the copy has their gitignored files. All of it comes to ~941 MB,
under GitHub Pages' 1 GB limit, so there is little room left. Canonical links
still point at exebrowser.com.

## Refreshing the runtime

```bash
./scripts/fetch-runtime.sh
```

This re-downloads Boxedwine's published JS/WASM from `boxedwine.org`. Commit the updated files in `public/boxedwine/`.

### The JIT engine (beta)

`public/boxedwine/build/jit/` is built from upstream Boxedwine source rather
than downloaded, because the JIT isn't in boxedwine.org's published build:

```bash
./scripts/build-boxedwine-jit.sh   # needs emcc; pinned commit, writes NOTICE.md
```

The CPU compiles hot x86 blocks to WebAssembly instead of interpreting them:
3.4–6× on a CPU-bound benchmark against the default engine. It boots
upstream's Wine 11 web root through `functions/api/bwfs/`, read on demand by
Range request, and keeps each program's writes in IndexedDB (`storageKey`).
It is opt-in: the engine picker on `/load-exe/`, or `?engine=jit` on any page
that would use the default engine. Browsers without Wasm exception handling,
tail calls and SIMD fall back to the default engine. The script header
explains why it doesn't run the default engine's Wine 1.7.55 root yet.

## License

ExeBrowser frontend: MIT. Boxedwine (bundled in `public/boxedwine/`) is GPL-2.0. Wine is LGPL.
