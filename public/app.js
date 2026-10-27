// ExeBrowser — run user-supplied Windows EXE files inside Boxedwine (Wine +
// x86 emulator) in WebAssembly. No upload; everything stays in the browser.
//
// How it integrates with Boxedwine's shell:
//   1. Load boxedwine-shell.js + browserfs.boxedwine.js + jszip.min.js
//      (these come from /boxedwine/build/default/, served same-origin).
//   2. Configure shell.js via the global `Config` it exports:
//        Config.locateRootBaseUrl  = where the Wine root zip lives
//        Config.locateAppBaseUrl   = where the per-app zip lives
//        Config.locateOverlayBaseUrl = where DLL/font overlays live
//        Config.urlParams = "root=...&app=...&p=EXENAME.EXE&..."
//   3. Inject boxedwine.js — Emscripten runtime that pulls boxedwine.wasm.
//
// For step 2, the app zip is normally a static file on the server. We don't
// have one — the user just picked an EXE. We zip it client-side with JSZip,
// stash the Blob URL, and intercept the XHR for that specific filename so
// shell.js receives our blob instead of hitting the network.

(() => {
  "use strict";

  // ─── Wine variants ─────────────────────────────────────────────────────
  // Each variant bundles a Boxedwine runtime build + a Wine root + optional
  // overlay. Two loading modes:
  //   ondemand : large root range-fetched lazily as DLLs are needed (the
  //              boxedwine.org Win32 model). Requires a same-origin proxy that
  //              honors Range requests; browserfs.boxedwine.js was patched to
  //              hardcode fetches to /api/fs/.
  //   inline   : whole root zip downloaded up-front (the 16-bit model + the
  //              older 18R2 build). Smaller roots make this viable.
  // The runtime base controls which boxedwine.js/.wasm/shell.js the page loads.
  // Variants that need the patched browserfs use runtime "default"; others
  // (18R2, win3x) ship their own runtime under /boxedwine/build/<name>/.
  const WINE_VARIANTS = {
    default: {
      label: "Wine 1.7.55 — Win32 (default, range-fetched)",
      runtimeBase: "/boxedwine/build/default/",
      loadMode: "ondemand",
      rootBaseUrl: "/api/fs/",
      rootBasename: "fullWine1.7.55-v8",
      overlayBaseUrl: "/boxedwine/apps/",
      overlayBasename: "wine1.7.55-v8-min-online",
    },
    gecko: {
      label: "Wine 1.7.55 — Win32 + Gecko MSI bundled",
      runtimeBase: "/boxedwine/build/default/",
      loadMode: "ondemand",
      rootBaseUrl: "/api/fs/",
      rootBasename: "fullWine1.7.55-v8",
      overlayBaseUrl: "/api/overlay/",
      overlayBasename: "wine1.7.55-v8-with-gecko",
    },
    win3x: {
      label: "Wine 3.1 — Win3.x 16-bit only (inline, 20 MB)",
      runtimeBase: "/boxedwine/build/default/",
      loadMode: "inline",
      rootBaseUrl: "/api/fs/",
      rootBasename: "minWine31v6",
    },
    // A current Boxedwine build whose CPU compiles hot x86 blocks to
    // WebAssembly instead of interpreting them (scripts/build-boxedwine-jit.sh),
    // on the Wine 11 root upstream tests its web build with. Not the default
    // engine's Wine 1.7.55 root: current Boxedwine boots that one but its
    // Wine processes crash before any window appears (see the script). Its
    // shell is upstream's, which talks to the page differently: see
    // runUpstreamShell.
    jit: {
      label: "Wine 11 — Win32, JIT engine (faster, beta, ~100 MB root read on demand)",
      runtimeBase: "/boxedwine/build/jit/",
      shell: "upstream",
      loadMode: "ondemand",
      rootBaseUrl: "/api/bwfs/",
      rootBasename: "TinyCore15Wine11.0-web",
      // The 512 KB pieces of that root every boot reads (58 MB of 99.5 MB),
      // fetched in parallel before the emulator starts instead of one
      // blocking request at a time: at 60 ms a round trip, one at a time took
      // the first window from 10.5 s to 18 s. Tied to the pinned file in
      // functions/api/bwfs/; the log prints the pieces read beyond it.
      rootBootChunks: "0-5,7-11,13-16,18-36,39-43,59,61,63-69,72-73,85-86,89-92,94,96-114,116-117,121-126," +
        "132-135,137-139,147-156,167-168,170-176,184-189",
    },
    r18: {
      label: "Boxedwine 18R2 (experimental, inline, 19 MB)",
      runtimeBase: "/boxedwine/build/18r2/",
      loadMode: "inline",
      // 18R2's bundled root ships inside its own runtime tree.
      rootBaseUrl: "/boxedwine/build/18r2/",
      rootBasename: "boxedwine",
    },
  };

  const VIRTUAL_APP_ZIP = "userapp.zip"; // the filename shell.js will request

  const els = {
    bootBtn: document.getElementById("bootBtn"),
    bootStatus: document.getElementById("bootStatus"),
    bootProgress: document.getElementById("bootProgress"),
    wineVariant: document.getElementById("wineVariant"),
    loaderSection: document.getElementById("loader-section"),
    dropzone: document.getElementById("dropzone"),
    exeInput: document.getElementById("exeInput"),
    folderInput: document.getElementById("folderInput"),
    zipInput: document.getElementById("zipInput"),
    pickBtn: document.getElementById("pickBtn"),
    pickFolderBtn: document.getElementById("pickFolderBtn"),
    pickZipBtn: document.getElementById("pickZipBtn"),
    entryPickerWrap: document.getElementById("entryPickerWrap"),
    entryPicker: document.getElementById("entryPicker"),
    fileInfo: document.getElementById("fileInfo"),
    runBtn: document.getElementById("runBtn"),
    saveStateBtn: document.getElementById("saveStateBtn"),
    logOutput: document.getElementById("logOutput"),
    canvas: document.getElementById("canvas"),
    screenContainer: document.getElementById("screen-container"),
  };

  const state = {
    depsLoaded: false,
    // Files staged for the virtual app zip. Each: { path: "RELATIVE/IN/ZIP", bytes: Uint8Array }
    // path uses forward slashes and is what Wine sees relative to its working dir.
    // The visitor's own files also keep raw, the path as given: Wine gets
    // upper-cased 8.3-safe names, Ren'Py's Python needs the real ones.
    stagedFiles: [],
    // EXEs found among stagedFiles, populated for the entry-EXE picker.
    candidateExes: [],
    // The selected entry. { name: "FOO.EXE", path: "subdir/FOO.EXE", originalName: "Foo.exe" }
    pickedExe: null,
    appZipBlob: null,
    bootInFlight: false,
    booted: false,
    // Locked in when the user clicks Boot Wine; reused on Run.
    selectedVariant: "default",
    // Where the staged files came from: "exe" | "folder" | "zip" | "files"
    // (a multi-file drop) for the visitor's own, "hosted" for a /run/ payload.
    entrySource: null,
    // What pe-inspect made of the entry EXE, for the byo_result event.
    preflight: null,
    // The variant the preflight replaced, so picking a different file can put
    // the visitor's own choice back rather than leaving ours in place.
    autoSwitchedFrom: null,
    // A Ren'Py game among the staged files (detectRenpy), which Run starts on
    // Ren'Py's web engine instead of Wine.
    renpy: null,
  };

  // ─── helpers ───────────────────────────────────────────────────────────

  function log(msg, level = "info") {
    msg = String(msg).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); // Wine 11's cursor hide/show
    const ts = new Date().toLocaleTimeString();
    const prefix = level === "error" ? "[!]" : level === "warn" ? "[~]" : "[·]";
    els.logOutput.textContent += `${ts} ${prefix} ${msg}\n`;
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
    if (state.bootInFlight || state.booted) noticeWineRefusal(msg);
  }

  // Run refuses a 64-bit entry up front (archBlock), but the program it does
  // start can still ask Wine for a 64-bit one — a launcher, a .bat, an
  // updater. Wine 1.7.55 says so on the console only:
  //   err:process:create_process L"D:\\userapp\\X.EXE" not supported on this installation (x86_64 binary)
  // If nothing has been drawn yet, that is the whole story, so it goes on the
  // screen. Once the program has painted, its own error dialog says it better.
  const WINE_REFUSED_64 = /create_process L"([^"]+)" not supported on this installation \(x86_64 binary\)/;
  function noticeWineRefusal(msg) {
    const m = WINE_REFUSED_64.exec(msg);
    if (!m || state.frameOutcome === "frame") return;
    const name = m[1].split(/\\+/).pop();
    showScreenMessage({ kase: "x64" }, name);
    setStatus(T("runChildStatus", "Stopped — see the message above."));
    track("preflight_action", { action: "wine_refused_x64" });
  }

  // ── Translation ─────────────────────────────────────────────────────────
  // The generator injects window.__I18N on localised pages only, so English
  // pages are byte-for-byte unchanged and ship no extra bytes. The English
  // text stays inline as the fallback: a missing key shows English rather
  // than an empty status line.
  //
  // Only the strings a visitor reads go through this. The log() output below
  // stays English deliberately — it is diagnostic, it interleaves with Wine's
  // own English output, and translating half a console transcript would make
  // it harder to read rather than easier.
  function T(key, fallback, vars) {
    let s = (window.__I18N && window.__I18N[key]) || fallback;
    if (vars) for (const k in vars) s = s.split("{" + k + "}").join(vars[k]);
    return s;
  }

  function setStatus(text) {
    els.bootStatus.textContent = text;
  }

  // Exposed for the inlined shell+config script (which runs in its own scope)
  // to call back into us for logging/status.
  window.__exeBrowserLog = log;
  window.__exeBrowserStatus = setStatus;

  function sanitizeExeName(name) {
    // Wine wants an 8.3-friendly DOS-safe name; uppercase, alnum + underscore.
    let base = name.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "");
    base = base.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
    if (base.length === 0) base = "USERAPP";
    if (base.length > 8) base = base.slice(0, 8);
    return base + ".EXE";
  }

  // Sanitize a relative path inside the virtual app zip. Splits on / and \,
  // strips ".." segments, normalizes each segment to alnum + a few safe chars,
  // and 8.3-truncates the final EXE basename so Wine's loader is happy.
  function sanitizeRelPath(rel) {
    const parts = rel.split(/[\\/]+/).filter((s) => s && s !== "." && s !== "..");
    if (parts.length === 0) return null;
    const out = parts.map((seg, i) => {
      const isLast = i === parts.length - 1;
      if (isLast && /\.exe$/i.test(seg)) return sanitizeExeName(seg);
      // Allow letters, digits, underscore, dash, dot, parentheses for non-final segments.
      let s = seg.replace(/[^A-Za-z0-9_.()\- ]/g, "_");
      if (s.length === 0) s = "_";
      return s.toUpperCase();
    });
    return out.join("/");
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false; // preserve execution order
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  // Inject inline JS code as a <script> tag and wait for it to execute.
  function runInlineScript(code) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.textContent = code;
      s.onerror = (e) => reject(new Error("inline script error"));
      try {
        document.head.appendChild(s);
        // Inline scripts execute synchronously on append for classic scripts.
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    return await r.text();
  }

  // Ensure DOM elements that boxedwine-shell.js queries exist. Checkbox-style
  // stubs (showConsole/sound-checkbox/soundToggle) MUST be real <input
  // type="checkbox"> nodes so reads of .checked don't throw on null/undefined.
  function ensureShellDomStubs() {
    const stubs = [
      // [id, tag, extras]
      ["status", "div"], ["progress", "progress"], ["spinner", "div"],
      ["output", "pre"],
      ["startbtn", "button"], ["uploadbtn", "button"], ["downloadbtn", "button"],
      ["inline-runbtn", "button"], ["inline", "div"], ["run-inline", "button"],
      ["loading", "div"],
      ["showConsole", "input", { type: "checkbox" }],
      ["sound-checkbox", "input", { type: "checkbox" }],
      ["soundToggle", "input", { type: "checkbox" }],
      ["message", "div"], ["modalLink", "a"], ["modalLinkExe", "a"],
      ["openModalExeClick", "button"], ["tree", "div"], ["items", "div"],
      ["selectedItem", "div"], ["loadStatus", "div"],
      // also looked up by the upstream shell (jit variant)
      ["pointerLock", "input", { type: "checkbox" }], ["savejitbtn", "button"],
      ["cdromdisc", "select"], ["cdromejectbtn", "button"],
    ];
    for (const [id, tag, attrs] of stubs) {
      if (!document.getElementById(id)) {
        const el = document.createElement(tag);
        el.id = id;
        if (attrs) for (const [k, v] of Object.entries(attrs)) el[k] = v;
        el.style.display = "none";
        document.body.appendChild(el);
      }
    }
    // shell.js calls dropzone.addEventListener; our existing #dropzone works.
  }

  // ─── loading-phase status line ─────────────────────────────────────────
  // A single secondary line under the main boot status: byte counts while
  // Boxedwine range-fetches its runtime (the "default"/"gecko" variants give
  // no other signal of progress during that phase), then reassurance text
  // once watchFirstFrame takes over waiting for a picture. One slot, reused
  // across both phases rather than two competing status lines.
  function fetchStatusEl() {
    let el = document.getElementById("bootFetchStatus");
    if (!el && els.bootStatus) {
      el = document.createElement("span");
      el.id = "bootFetchStatus";
      el.className = "muted small";
      els.bootStatus.after(el);
    }
    return el;
  }
  function setFetchStatusText(text) {
    const el = fetchStatusEl();
    if (el) el.textContent = text || "";
  }

  let xhrBytesFetched = 0;
  let fetchStatusTimer = null;
  function resetFetchProgress() {
    xhrBytesFetched = 0;
    setFetchStatusText("");
  }
  function bumpFetchProgress(delta) {
    if (delta <= 0) return;
    xhrBytesFetched += delta;
    if (fetchStatusTimer) return;
    // Throttle DOM writes to a few times a second rather than on every chunk
    // — Range-fetched DLLs come in frequently once the runtime gets going.
    fetchStatusTimer = setTimeout(() => {
      fetchStatusTimer = null;
      setFetchStatusText(T("wineFetchedSoFar", "Fetched {amount} of runtime files so far…", { amount: formatBytes(xhrBytesFetched) }));
    }, 300);
  }

  // ─── XHR interception ──────────────────────────────────────────────────
  // Boxedwine's shell.js uses XMLHttpRequest to fetch the app zip:
  //     locateAppBaseUrl + appZipFile
  // We monkey-patch XHR.open to detect requests for our virtual app zip,
  // and override responses with the in-memory Blob.

  function installXhrInterceptor() {
    const NativeXHR = window.XMLHttpRequest;
    const origOpen = NativeXHR.prototype.open;
    const origSend = NativeXHR.prototype.send;
    const origSetRequestHeader = NativeXHR.prototype.setRequestHeader;
    const origGetResponseHeader = NativeXHR.prototype.getResponseHeader;

    NativeXHR.prototype.open = function (method, url, async, user, pass) {
      let u = String(url);
      // Variant-specific URL rewrites. Inline-mode variants fetch the root
      // zip with an empty baseUrl, so the request lands at /boxedwine.zip or
      // /minWine31v6.zip on the page origin. Redirect to where we actually
      // ship the assets.
      const variant = activeVariant();
      if (variant.loadMode === "inline") {
        const want = variant.rootBasename + ".zip";
        if (u === want || u.endsWith("/" + want)) {
          u = variant.rootBaseUrl + want;
        }
      }
      this.__exebrowser_url = u;
      return origOpen.call(this, method, u, async !== false, user, pass);
    };

    NativeXHR.prototype.setRequestHeader = function (k, v) {
      if (this.__exebrowser_url && this.__exebrowser_url.includes(VIRTUAL_APP_ZIP)) {
        // Suppress — we'll handle responses ourselves.
        this.__exebrowser_headers = this.__exebrowser_headers || {};
        this.__exebrowser_headers[k.toLowerCase()] = v;
        return;
      }
      return origSetRequestHeader.call(this, k, v);
    };

    NativeXHR.prototype.send = function (body) {
      const url = this.__exebrowser_url || "";
      if (!url.includes(VIRTUAL_APP_ZIP)) {
        // Real network traffic: Boxedwine's own runtime/DLL fetches (Range
        // chunks under ondemand mode, or the whole root zip under inline
        // mode). `loaded` is cumulative per request, so track the delta.
        let lastLoaded = 0;
        this.addEventListener("progress", (ev) => {
          const loaded = ev.loaded || 0;
          const delta = loaded - lastLoaded;
          if (delta > 0) { lastLoaded = loaded; bumpFetchProgress(delta); }
        });
        return origSend.call(this, body);
      }

      if (!state.appZipBlob) {
        log("Internal: XHR for user app zip but no blob ready.", "error");
        this.readyState = 4;
        this.status = 500;
        this.onreadystatechange && this.onreadystatechange();
        return;
      }

      // Synthesize a response from the in-memory Blob, honoring Range.
      const reader = new FileReader();
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        const headers = this.__exebrowser_headers || {};
        let responseBytes = bytes;
        let status = 200;

        // Honor Range: bytes=N-M (Boxedwine OnDemand mode uses this)
        if (headers["range"]) {
          const m = /bytes=(\d+)-(\d+)?/.exec(headers["range"]);
          if (m) {
            const start = parseInt(m[1], 10);
            const end = m[2] ? Math.min(parseInt(m[2], 10) + 1, bytes.length) : bytes.length;
            responseBytes = bytes.slice(start, end);
            status = 206;
          }
        }

        Object.defineProperty(this, "readyState", { value: 4, writable: true });
        Object.defineProperty(this, "status", { value: status, writable: true });
        // Shell uses overrideMimeType('text/plain; charset=x-user-defined') and reads .responseText
        // as a binary-ish string. We need to reconstruct that.
        let responseText = "";
        for (let i = 0; i < responseBytes.length; i++) {
          responseText += String.fromCharCode(responseBytes[i]);
        }
        Object.defineProperty(this, "responseText", { value: responseText, writable: true });
        Object.defineProperty(this, "response", { value: responseBytes.buffer, writable: true });

        // Override header getter for Content-Length
        this.getResponseHeader = function (name) {
          if (name.toLowerCase() === "content-length") return String(state.appZipBlob.size);
          return null;
        };

        if (this.onreadystatechange) this.onreadystatechange();
        if (this.onload) this.onload();
      };
      reader.readAsArrayBuffer(state.appZipBlob);
    };
  }

  // ─── boot Boxedwine ────────────────────────────────────────────────────

  function activeVariant() {
    return WINE_VARIANTS[state.selectedVariant] || WINE_VARIANTS.default;
  }

  // Stage 1: load dependencies that shell.js needs (BrowserFS, JSZip).
  // The browserfs filename + the need for the ?v= cache buster vary by variant:
  //   - default/gecko use the patched browserfs.boxedwine.js (hardcoded path
  //     redirected from /boxedwine/fs/ to /api/fs/), so the bust is mandatory.
  //   - 18r2 ships its own browserfs.min.js — no patch, no cache concern.
  //   - win3x uses default runtime so default rules apply.
  async function loadBoxedwineDeps() {
    if (state.depsLoaded) return;
    setStatus(T("wineLoadingRuntime", "Loading Boxedwine runtime…"));
    els.bootProgress.hidden = false;
    els.bootProgress.value = 10;

    const variant = activeVariant();
    const runtimeBase = variant.runtimeBase;

    // The upstream shell doesn't use JSZip or BrowserFS (it mounts zips in
    // the emulator), but buildAppZip still needs JSZip.
    await loadScript((variant.shell === "upstream" ? WINE_VARIANTS.default.runtimeBase : runtimeBase) + "jszip.min.js");
    els.bootProgress.value = 25;

    if (variant.shell === "upstream") {
      // nothing else to load
    } else if (variant.runtimeBase === "/boxedwine/build/18r2/") {
      await loadScript(runtimeBase + "browserfs.min.js");
    } else {
      await loadScript(runtimeBase + "browserfs.boxedwine.js?v=8");
    }
    els.bootProgress.value = 40;

    ensureShellDomStubs();
    state.depsLoaded = true;
    log("Dependencies loaded (runtime=" + runtimeBase + ").");
  }

  // Stage 2: build a single combined script: shell.js source + our Config
  // mutations. They share scope so we can reach the `let Config` shell.js
  // declares. Then inject boxedwine.js which triggers preRun → initialSetup.
  async function runShellWithConfig() {
    setStatus(T("wineConfiguring", "Configuring Wine launch…"));
    els.bootProgress.value = 50;

    const variant = activeVariant();
    const runtimeBase = variant.runtimeBase;
    if (variant.shell === "upstream") return runUpstreamShell(variant);
    const shellSrc = await fetchText(runtimeBase + "boxedwine-shell.js?v=2");
    els.bootProgress.value = 60;

    // urlParams depends on the variant's load mode:
    //   ondemand : range-fetch root; preload overlay; needs locateRootBaseUrl
    //              pointing at the Range-capable proxy (/api/fs/).
    //   inline   : root downloaded whole; no overlay; locateRootBaseUrl just
    //              needs to serve the .zip (Range optional).
    const rootBasename = variant.rootBasename;
    const overlayBasename = variant.overlayBasename;
    const overlayBaseUrl = variant.overlayBaseUrl || "/boxedwine/apps/";
    const exeName = state.pickedExe.path.replace(/\//g, "\\");

    let urlParams;
    if (variant.loadMode === "ondemand") {
      urlParams = [
        "ondemand=root",
        "root=" + encodeURIComponent(rootBasename),
        "inline-default-ondemand-root-overlay=" + encodeURIComponent(overlayBasename),
        "app=" + encodeURIComponent(VIRTUAL_APP_ZIP),
        "p=" + encodeURIComponent(exeName),
        "auto=true",
        "sound=true",
        "bpp=32",
      ].join("&");
    } else {
      urlParams = [
        "root=" + encodeURIComponent(rootBasename),
        "app=" + encodeURIComponent(VIRTUAL_APP_ZIP),
        "p=" + encodeURIComponent(exeName),
        "auto=true",
        "sound=true",
        "bpp=32",
      ].join("&");
    }

    // The Config object inside shell.js is `let`-scoped, so we can only mutate
    // it from inside the same <script> block. We append our setup at the end
    // of the shell.js source and run the combined whole as one inline script.
    const configCode = `
      // ── ExeBrowser-injected configuration ──
      Config.isRunningInline = true;
      Config.locateRootBaseUrl  = ${JSON.stringify(variant.rootBaseUrl)};
      Config.locateAppBaseUrl   = ${JSON.stringify("/boxedwine/apps/")};
      Config.locateOverlayBaseUrl = ${JSON.stringify(overlayBaseUrl)};
      Config.urlParams = ${JSON.stringify(urlParams)};

      // shell.js declares its own var Module; reach in and add our hooks.
      var __originalPreRun = Module.preRun ? Module.preRun.slice() : [];
      Module.canvas = document.getElementById("canvas");
      Module.print = function (t) { window.__exeBrowserLog(String(t)); };
      Module.printErr = function (t) { window.__exeBrowserLog(String(t), "warn"); };
      Module.setStatus = function (t) { if (t) window.__exeBrowserStatus(t); };
      Module.locateFile = function (path) { return ${JSON.stringify(runtimeBase)} + path; };
      // Expose for our outer code to verify.
      window.__BoxedwineConfig = Config;
      window.__BoxedwineModule = Module;
    `;

    await runInlineScript(shellSrc + "\n;\n" + configCode);

    if (!window.__BoxedwineConfig) {
      throw new Error("Combined shell+config script failed to expose Config.");
    }

    log("Wine shell configured (variant=" + state.selectedVariant +
        ", root=" + rootBasename +
        (overlayBasename ? ", overlay=" + overlayBasename : "") +
        ", program=" + exeName + ").");
  }

  // The upstream shell (jit variant) takes the same Config.urlParams idea but
  // different parameters, fetches with fetch() rather than XHR, mounts zips
  // inside the emulator, and keeps every write under one directory (ROOT) in
  // IndexedDB, keyed per program by storageKey. Two of its functions are
  // replaced from inside the same script: loadFile, so the visitor's zip
  // comes from memory and the ~100 MB root is not downloaded whole, and
  // createFile, which mounts that root as a Range-backed file instead.
  async function runUpstreamShell(variant) {
    const shellSrc = await fetchText(variant.runtimeBase + "boxedwine-shell.js?v=1");
    els.bootProgress.value = 60;

    const path = state.pickedExe.path;
    const slash = path.lastIndexOf("/");
    const workDir = "c:/files/userapp" + (slash >= 0 ? "/" + path.slice(0, slash) : "");
    const exeName = path.slice(slash + 1);
    // Base URLs go in as parameters too: the shell's setConfiguration()
    // rereads them from urlParams and would blank anything set on Config.
    const urlParams = [
      "rootBase=" + encodeURIComponent(variant.rootBaseUrl),
      "root=" + encodeURIComponent(variant.rootBasename),
      ...(variant.overlayBasename ? [
        "overlayBase=" + encodeURIComponent(variant.overlayBaseUrl),
        "overlay=" + encodeURIComponent(variant.overlayBasename),
      ] : []),
      "app=" + encodeURIComponent(VIRTUAL_APP_ZIP),
      "p=" + encodeURIComponent(exeName),
      "w=" + encodeURIComponent(workDir),
      "storageKey=" + encodeURIComponent(resolveWineSlug()),
      "sound=true",
      "bpp=32",
    ].join("&");
    const rootUrl = variant.rootBaseUrl + variant.rootBasename + ".zip";

    const configCode = `
      // ── ExeBrowser-injected configuration (upstream shell) ──
      Config.urlParams = ${JSON.stringify(urlParams)};
      Config.showSaveJITCache = false;

      // The shell's own loadFile logs a failed fetch and stops there, which
      // left the page on "Preparing..." for good.
      loadFile = function (prefix, filename, callback) {
        if (filename === Config.appZipFile) {
          window.__exeBrowserAppZip().then(callback);
        } else if (filename === Config.rootZipFile) {
          // createFile below mounts it lazily, once the boot pieces are in
          window.__exeBrowserPreloadRoot().then(function () { callback(null); });
        } else {
          fetch(prefix + filename)
            .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.arrayBuffer(); })
            .then(function (b) { window.__exeBrowserFetched(b.byteLength); callback(new Uint8Array(b)); })
            .catch(function (e) { window.__exeBrowserBootError(prefix + filename, e); });
        }
      };
      var __bwCreateFile = createFile;
      createFile = function (dir, name, buf) {
        if (buf === null && name === Config.rootZipFile) {
          window.__exeBrowserRangeFile(FS, dir, name, ${JSON.stringify(rootUrl)}, window.__exeBrowserRootPreload);
        } else {
          __bwCreateFile(dir, name, buf);
        }
      };

      Module.canvas = document.getElementById("canvas");
      Module.print = function (t) { window.__exeBrowserLog(String(t)); };
      Module.printErr = function (t) { window.__exeBrowserLog(String(t), "warn"); };
      Module.setStatus = function (t) { if (t) window.__exeBrowserStatus(t); };
      Module.locateFile = function (path) { return ${JSON.stringify(variant.runtimeBase)} + path; };
      window.__BoxedwineConfig = Config;
      window.__BoxedwineModule = Module;
      window.__BoxedwineRoot = function () { return ROOT; };
    `;
    presentCanvas();
    window.__exeBrowserAppZip = () => state.appZipBlob.arrayBuffer().then((b) => new Uint8Array(b));
    window.__exeBrowserFetched = bumpFetchProgress;
    window.__exeBrowserRangeFile = createRangeFile;
    window.__exeBrowserPreloadRoot = () => preloadRange(rootUrl, variant.rootBootChunks || "")
      .then((p) => { window.__exeBrowserRootPreload = p; });
    window.__exeBrowserBootError = (what, err) => {
      log(`Boot failed: could not load ${what} (${err.message}).`, "error");
      setStatus(T("wineBootFailed", "Boot failed. See console."));
      track("boot_error", { error_message: ("fetch " + what + ": " + err.message).slice(0, 120) });
    };
    await runInlineScript(shellSrc + "\n;\n" + configCode);
    if (!window.__BoxedwineConfig) {
      throw new Error("Combined shell+config script failed to expose Config.");
    }
    log("Wine shell configured (variant=" + state.selectedVariant + ", root=" + variant.rootBasename +
        " on demand" + (variant.overlayBasename ? ", overlay=" + variant.overlayBasename : "") + ", program=" + path + ").");
  }

  // What the jit runtime needs from the browser, in one 67-byte module:
  // try_table (exnref exceptions), return_call (tail calls) and a v128
  // (SIMD). Chrome 137+, Firefox 131+, Safari 18.4+. An older browser can't
  // compile boxedwine.wasm at all and would sit on a black screen.
  const JIT_FEATURES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 8, 2, 96, 0, 1, 123, 96, 0, 0, 3, 3, 2, 0, 0,
    13, 3, 1, 0, 1, 10, 37, 2, 30, 0, 2, 64, 31, 64, 1, 2, 0, 1, 11, 11, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 11, 4, 0, 18, 0, 11]);
  function jitSupported() {
    try { return WebAssembly.validate(JIT_FEATURES); } catch { return false; }
  }

  // The upstream runtime draws Wine's windows into a second, 2D canvas laid
  // over #canvas (its shell.html stacks the two); #canvas keeps the WebGL
  // context and the input. Without this one the program ran behind a black
  // screen. It follows #canvas's box, which SDL resizes.
  function presentCanvas() {
    let c = document.getElementById("boxedwine-webgl-canvas-0");
    if (c) return c;
    c = document.createElement("canvas");
    c.id = "boxedwine-webgl-canvas-0";
    c.className = "present-canvas";
    els.screenContainer.append(c);
    const follow = () => {
      const r = els.canvas;
      c.style.left = r.offsetLeft + "px";
      c.style.top = r.offsetTop + "px";
      c.style.width = r.offsetWidth + "px";
      c.style.height = r.offsetHeight + "px";
    };
    new ResizeObserver(follow).observe(els.canvas);
    addEventListener("resize", follow);
    follow();
    return c;
  }

  // An Emscripten file that holds a remote zip and reads it by Range request
  // as the emulator asks, so a Wine root of thousands of files costs only
  // what the program opens. This runs on the page's own thread, where a synchronous
  // XHR may not ask for an ArrayBuffer: the x-user-defined charset passes the
  // bytes through responseText unmangled instead (as browserfs.boxedwine.js
  // does for the default engine). Chunks are kept for the session.
  const RANGE_CHUNK = 512 * 1024;
  let rangeLazy = null; // piece numbers read on demand, for the log

  // The pieces listed in spec ("0-5,7,9-12"), fetched six at a time. A
  // failure only costs the speed-up: those pieces are read on demand.
  async function preloadRange(url, spec) {
    const want = [];
    for (const part of spec.split(",").filter(Boolean)) {
      const [a, b = a] = part.split("-").map(Number);
      for (let n = a; n <= b; n++) want.push(n);
    }
    const chunks = new Map();
    let size = -1;
    let next = 0;
    const worker = async () => {
      while (next < want.length) {
        const n = want[next++];
        // Its own URL per piece: Chrome's HTTP cache lets one request per URL
        // through at a time, which made these four workers take turns.
        const r = await fetch(url + "?piece=" + n, { headers: { Range: `bytes=${n * RANGE_CHUNK}-${(n + 1) * RANGE_CHUNK - 1}` } });
        if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
        const total = /\/(\d+)$/.exec(r.headers.get("Content-Range") || "");
        if (total) size = +total[1];
        const bytes = new Uint8Array(await r.arrayBuffer());
        chunks.set(n, bytes);
        bumpFetchProgress(bytes.length);
      }
    };
    try {
      await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
    } catch (err) {
      log(`Preloading the Wine root failed (${err.message}); reading it on demand instead.`, "warn");
    }
    return { chunks, size };
  }

  function createRangeFile(FS, dir, name, url, preload) {
    let size = preload && preload.size > 0 ? preload.size : -1;
    const chunks = preload ? preload.chunks : new Map();
    rangeLazy = [];
    const get = (from, to) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, false);
      xhr.setRequestHeader("Range", `bytes=${from}-${to}`);
      xhr.overrideMimeType("text/plain; charset=x-user-defined");
      xhr.send(null);
      // A 200 is the whole file: a server or cache that ignored Range.
      if (xhr.status === 200) size = xhr.responseText.length;
      else if (xhr.status !== 206) throw new Error(`Range ${from}-${to} of ${url}: HTTP ${xhr.status}`);
      const total = /\/(\d+)$/.exec(xhr.getResponseHeader("Content-Range") || "");
      if (total) size = +total[1];
      const text = xhr.responseText;
      const bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
      bumpFetchProgress(bytes.length);
      if (xhr.status === 200) {
        for (let n = 0; n * RANGE_CHUNK < size; n++) chunks.set(n, bytes.subarray(n * RANGE_CHUNK, (n + 1) * RANGE_CHUNK));
        return bytes.subarray(from, to + 1);
      }
      return bytes;
    };
    const chunk = (n) => {
      let c = chunks.get(n);
      if (!c) {
        c = get(n * RANGE_CHUNK, Math.min(size, (n + 1) * RANGE_CHUNK) - 1);
        chunks.set(n, c);
        rangeLazy.push(n);
      }
      return c;
    };
    if (size < 0) chunks.set(0, get(0, RANGE_CHUNK - 1)); // also learns the size
    const node = FS.createFile(dir, name, { isDevice: false }, true, false);
    Object.defineProperty(node, "usedBytes", { get: () => size });
    node.stream_ops = Object.assign({}, node.stream_ops, {
      read(stream, buffer, offset, length, position) {
        const n = Math.max(0, Math.min(length, size - position));
        for (let done = 0; done < n;) {
          const at = position + done;
          const c = chunk(Math.floor(at / RANGE_CHUNK));
          const from = at % RANGE_CHUNK;
          const take = Math.min(c.length - from, n - done);
          buffer.set(c.subarray(from, from + take), offset + done);
          done += take;
        }
        return n;
      },
    });
    log(`Mounted ${name} on demand (${formatBytes(size)}, fetched in ${formatBytes(RANGE_CHUNK)} pieces as needed).`);
  }

  // Stage 3: inject the Emscripten runtime. Its preRun calls initialSetup
  // which reads Config.urlParams and builds the filesystem.
  async function startEmulator() {
    setStatus(T("wineStartingEmulator", "Starting emulator…"));
    els.bootProgress.value = 75;
    await loadScript(activeVariant().runtimeBase + "boxedwine.js");
    els.bootProgress.value = 100;
    installAudioReviver();
  }

  // Chrome blocks AudioContext until a user gesture. Boxedwine creates one
  // inside SDL_OpenAudio and never resumes it, so apps run silently. Poll
  // for Module.SDL2.audioContext and resume on the next user interaction
  // (or immediately, since the run-button click that brought us here counts).
  function installAudioReviver() {
    let resumed = false;
    const tryResume = () => {
      const ctx = window.Module && window.Module.SDL2 && window.Module.SDL2.audioContext;
      if (!ctx) return false;
      if (ctx.state === "suspended") {
        ctx.resume().then(
          () => { log("AudioContext resumed."); },
          (e) => { log("AudioContext resume failed: " + e, "warn"); }
        );
      }
      resumed = true;
      return true;
    };

    // Poll for up to 30s while Wine is booting.
    const start = Date.now();
    const poll = setInterval(() => {
      if (resumed || Date.now() - start > 30000) {
        clearInterval(poll);
        return;
      }
      tryResume();
    }, 250);

    // Belt + suspenders: any future click/keydown will also nudge it.
    const onGesture = () => { tryResume(); };
    window.addEventListener("click", onGesture, { capture: true });
    window.addEventListener("keydown", onGesture, { capture: true });
  }

  // ─── app payload handling ──────────────────────────────────────────────
  // The user can supply: (a) one EXE, (b) a folder with one or more EXEs +
  // assets, or (c) a zip. We normalize all three into `state.stagedFiles`
  // — a list of { path, bytes } — then build the virtual app zip at boot.

  function clearStaged() {
    state.stagedFiles = [];
    state.candidateExes = [];
    state.pickedExe = null;
    els.entryPickerWrap.hidden = true;
    els.entryPicker.innerHTML = "";
    els.fileInfo.textContent = "";
    els.runBtn.disabled = true;
    state.entrySource = null;
    state.preflight = null;
    state.renpy = null;
    stopRenpy();
    showPreflight(null);
    showHandoffNotice(null);
    if (!state.booted) showScreenMessage(null);
  }

  // After stagedFiles is populated, find EXEs, refresh the entry-picker, and
  // default to the only one (or the first if multiple).
  function refreshEntryPicker() {
    state.renpy = detectRenpy(state.stagedFiles);
    if (state.renpy) {
      // Run doesn't use the .exe (runRenpy), so there is nothing to choose
      // between among it and the Python ones in lib/.
      const g = state.renpy;
      const exe = state.stagedFiles.find((f) => f.raw && f.raw.toLowerCase() === (g.prefix + g.name + ".exe").toLowerCase());
      state.candidateExes = exe ? [exe] : [];
      els.entryPickerWrap.hidden = true;
      setEntry(exe || g.launcher);
      return;
    }
    state.candidateExes = state.stagedFiles
      .filter((f) => /\.(exe|bat)$/i.test(f.path))
      .sort((a, b) => {
        // EXEs before BATs so default pick is still an EXE when both exist
        const aExe = /\.exe$/i.test(a.path) ? 0 : 1;
        const bExe = /\.exe$/i.test(b.path) ? 0 : 1;
        return aExe - bExe || a.path.localeCompare(b.path);
      });

    if (state.candidateExes.length === 0) {
      els.entryPickerWrap.hidden = true;
      els.runBtn.disabled = true;
      state.pickedExe = null;
      log("No .exe or .bat found in the supplied files.", "warn");
      return;
    }

    if (state.candidateExes.length === 1) {
      els.entryPickerWrap.hidden = true;
      setEntry(state.candidateExes[0]);
      return;
    }

    // Multiple EXEs — show the picker.
    els.entryPicker.innerHTML = "";
    for (const f of state.candidateExes) {
      const opt = document.createElement("option");
      opt.value = f.path;
      opt.textContent = `${f.path} (${formatBytes(f.bytes.length)})`;
      els.entryPicker.appendChild(opt);
    }
    els.entryPickerWrap.hidden = false;
    setEntry(state.candidateExes[0]);
  }

  function setEntry(stagedFile) {
    // Wine launch path is just the basename (we cd into the right subdir).
    const baseName = stagedFile.path.split("/").pop();
    state.pickedExe = {
      path: stagedFile.path,
      name: baseName,
      originalName: baseName,
      bytes: stagedFile.bytes,
    };
    const exeCount = state.candidateExes.length;
    const totalSize = state.stagedFiles.reduce((n, f) => n + f.bytes.length, 0);
    const suffix = state.stagedFiles.length > 1
      ? ` · ${state.stagedFiles.length} files, ${formatBytes(totalSize)} total`
      : "";
    els.fileInfo.textContent = T("wineEntry", "Entry: {path}", { path: stagedFile.path + suffix }) +
      (exeCount > 1 ? " · " + T("wineExesAvailable", "{n} EXEs available", { n: exeCount }) : "");
    els.runBtn.disabled = false;
    if (state.entrySource && state.entrySource !== "hosted") preflight(stagedFile);
  }

  // Check PE magic on every EXE the user gives us; warn (not fail) on misses.
  function warnIfNotPe(path, bytes) {
    if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
      log(`Warning: ${path} doesn't start with PE 'MZ' magic.`, "warn");
    }
  }

  // The COFF Machine field of a PE file, or null for anything that is not one
  // (DOS, NE, LE, not an EXE at all). Deliberately not pe-inspect.js: the Run
  // gate below must hold even on a page that doesn't load the parser, or when
  // the parser throws on a malformed file.
  const PE_I386 = 0x014c;
  const PE_MACHINE_NAMES = { 0x8664: "x86-64", 0xaa64: "ARM64", 0x01c0: "ARM", 0x01c4: "ARM", 0x0200: "Itanium" };
  function peMachine(bytes) {
    if (!bytes || bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lfanew = dv.getUint32(0x3c, true);
    if (lfanew < 0x40 || lfanew + 6 > bytes.length) return null;
    if (dv.getUint32(lfanew, true) !== 0x00004550) return null; // "PE\0\0"
    return dv.getUint16(lfanew + 4, true);
  }

  // Every engine on this page is 32-bit Wine. Its loader reads the same
  // Machine field and refuses anything that isn't i386 ("Bad EXE format"),
  // after which the tab sat on a black screen saying "Running…" for good.
  // Unlike the rest of the preflight this is not a guess about the file, it
  // is the check Wine itself makes, so Run stops here instead.
  function archBlock(bytes) {
    const machine = peMachine(bytes);
    if (machine == null || machine === PE_I386) return null;
    return {
      kase: machine === 0x8664 ? "x64" : "cpu",
      cpu: PE_MACHINE_NAMES[machine] || "0x" + machine.toString(16).padStart(4, "0"),
    };
  }

  // ─── Ren'Py games ──────────────────────────────────────────────────────
  // A Ren'Py game for Windows is <name>.exe and <name>.py next to renpy/,
  // game/ and lib/. The .exe is a small launcher for the 64-bit Python in
  // lib/py3-windows-x86_64 (Ren'Py 8 has no 32-bit Windows build), so Wine
  // here refuses it. Ren'Py ships the same engine built for the web, though,
  // and its own web build only repackages files the game already has: main.py
  // (<name>.py), renpy/ as compiled Python, and game/. So Run packs exactly
  // that, in the browser, and opens Ren'Py's web runtime on it
  // (public/renpy/, fetched by scripts/build-renpy-web.mjs).
  //
  // The compiled renpy/ files have to come from the same Ren'Py as the
  // runtime's wasm, so each version needs its own runtime.
  const RENPY_RUNTIMES = {
    "8.5.3": { base: "/renpy/8.5.3/", pycTag: ".cpython-312.pyc" },
  };
  const RENPY_SUPPORTED = Object.keys(RENPY_RUNTIMES).join(", ");

  function detectRenpy(files) {
    const vc = files.find((f) => f.raw && /(^|\/)renpy\/vc_version\.py$/.test(f.raw));
    if (!vc) return null;
    const prefix = vc.raw.slice(0, vc.raw.length - "renpy/vc_version.py".length);
    const top = (f) => f.raw && f.raw.startsWith(prefix) ? f.raw.slice(prefix.length) : null;
    if (!files.some((f) => (top(f) || "").startsWith("game/"))) return null;
    const pys = files.filter((f) => /^[^/]+\.py$/.test(top(f) || ""));
    const exes = new Set(files.map(top).filter((r) => r && /^[^/]+\.exe$/i.test(r)).map((r) => r.slice(0, -4).toLowerCase()));
    const launcher = pys.length === 1 ? pys[0] : pys.find((f) => exes.has(top(f).slice(0, -3).toLowerCase()));
    if (!launcher) return null;
    const m = /\bversion\s*=\s*['"](\d+\.\d+\.\d+)/.exec(new TextDecoder().decode(vc.bytes));
    return { prefix, launcher, name: top(launcher).slice(0, -3), version: m ? m[1] : null };
  }

  // The launcher .exe on its own: it loads lib\py3-…\librenpython.dll, and
  // nothing else carries that name.
  function isRenpyLauncher(bytes) {
    if (!bytes || bytes.length > 4 * 1024 * 1024 || peMachine(bytes) == null) return false;
    const want = Array.from("librenpython", (c) => c.charCodeAt(0));
    outer: for (let i = 0; i + want.length * 2 <= bytes.length; i++) {
      for (let j = 0; j < want.length; j++) {
        if (bytes[i + j * 2] !== want[j] || bytes[i + j * 2 + 1] !== 0) continue outer;
      }
      return true;
    }
    return false;
  }

  // What Ren'Py's own web build (launcher/game/web.rpy) puts in game.zip:
  // main.py, renpy/ with each __pycache__/*.cpython-3xx.pyc moved up beside
  // its module and the .py dropped, and game/. game/cache is left out (Ren'Py
  // rebuilds it); a .py with no compiled copy is kept so it can still import.
  function renpyGameZipEntries(g, rt) {
    const rows = [];
    for (const f of state.stagedFiles) {
      if (!f.raw || !f.raw.startsWith(g.prefix)) continue;
      const rel = f.raw.slice(g.prefix.length);
      if (/(^|\/)(\.DS_Store|\._[^/]*)$/.test(rel)) continue;
      if (rel.startsWith("renpy/") || (rel.startsWith("game/") && !rel.startsWith("game/cache/"))) rows.push({ rel, f });
    }
    const pyc = (rel) => rel.replace("__pycache__/", "").slice(0, -rt.pycTag.length) + ".pyc";
    const compiled = new Set(rows.filter((r) => r.rel.includes("/__pycache__/") && r.rel.endsWith(rt.pycTag))
      .map((r) => pyc(r.rel).slice(0, -1)));
    const out = [{ name: "main.py", bytes: g.launcher.bytes }];
    for (const { rel, f } of rows) {
      if (rel.startsWith("renpy/")) {
        if (rel.includes("/__pycache__/")) {
          if (rel.endsWith(rt.pycTag)) out.push({ name: pyc(rel), bytes: f.bytes });
          continue;
        }
        if (rel.endsWith(".py") && compiled.has(rel)) continue;
      }
      out.push({ name: rel, bytes: f.bytes });
    }
    return out;
  }

  // A stored (uncompressed) zip, built as a Blob from the staged arrays
  // rather than one more contiguous copy of a game that can run to hundreds
  // of MB. Ren'Py's Python checks each entry's CRC when it unpacks.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function storeZip(entries) {
    if (entries.length > 0xffff) throw new Error(`${entries.length} files is more than a zip without zip64 holds`);
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, bytes } of entries) {
      const nm = enc.encode(name);
      const crc = crc32(bytes);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true); // names are UTF-8
      lh.setUint16(12, 0x0021, true); // 1980-01-01
      lh.setUint32(14, crc, true);
      lh.setUint32(18, bytes.length, true);
      lh.setUint32(22, bytes.length, true);
      lh.setUint16(26, nm.length, true);
      parts.push(lh, nm, bytes);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(14, 0x0021, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, bytes.length, true);
      cd.setUint32(24, bytes.length, true);
      cd.setUint16(28, nm.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd, nm);
      offset += 30 + nm.length + bytes.length;
      if (offset > 0xffffffff) throw new Error("the game is over 4 GB, more than a zip without zip64 holds");
    }
    const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  function renpyVars() {
    return { version: (state.renpy && state.renpy.version) || "?", supported: RENPY_SUPPORTED };
  }

  async function runRenpy() {
    const g = state.renpy;
    const rt = RENPY_RUNTIMES[g.version];
    if (!rt) {
      log(`Not started: this is a Ren'Py ${g.version || "(unknown version)"} game, and this page has Ren'Py's web engine for ${RENPY_SUPPORTED} only.`, "warn");
      setStatus(T("runBlockedStatus", "Not started — see the message above."));
      showScreenMessage({ kase: "renpy_version" });
      els.screenContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      track("preflight_action", { action: "blocked_renpy_version" });
      return;
    }
    els.runBtn.disabled = true;
    setStatus(T("renpyPacking", "Packing the game for Ren'Py's web engine…"));
    await new Promise((r) => setTimeout(r, 0)); // let the status paint first
    let blob;
    try {
      const entries = renpyGameZipEntries(g, rt);
      blob = storeZip(entries);
      log(`Ren'Py ${g.version} game "${g.name}": packed ${entries.length} files into a ${formatBytes(blob.size)} game.zip for Ren'Py's web engine. Wine isn't used.`);
    } catch (err) {
      log("Could not pack the Ren'Py game: " + err.message, "error");
      setStatus(T("wineBootFailed", "Boot failed. See console."));
      els.runBtn.disabled = false;
      return;
    }
    stopRenpy();
    showScreenMessage(null);
    window.__exeBrowserRenpyZip = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.id = "renpy-frame";
    frame.className = "renpy-frame";
    frame.title = g.name;
    frame.allow = "autoplay; fullscreen";
    frame.src = rt.base;
    if (els.canvas) els.canvas.style.display = "none";
    els.screenContainer.append(frame);
    els.screenContainer.classList.add("has-content");
    els.screenContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    frame.focus();
    setStatus(T("renpyRunning", "Running {name} on Ren'Py {version}…", { name: g.name, version: g.version }));
    track("renpy_run", { version: g.version, size_mb: Math.round(blob.size / 1e6) });
  }

  function stopRenpy() {
    document.getElementById("renpy-frame")?.remove();
    if (window.__exeBrowserRenpyZip) URL.revokeObjectURL(window.__exeBrowserRenpyZip);
    window.__exeBrowserRenpyZip = null;
    if (els.canvas) els.canvas.style.display = "";
  }

  // ─── preflight: read the visitor's EXE before booting it ───────────────
  // Until this existed the only check was the MZ test above, logged to a
  // console most people never open. A 64-bit build, a DOS game, a .NET tool or
  // a 16-bit Windows 3.x program all booted the 30–60 MB runtime and ended on a
  // blank screen with no explanation. pe-inspect.js (the /exe-inspector/
  // parser) already knows every one of those cases, so the loader asks it
  // first and says what it found — in a sentence, before the download.
  //
  // It never blocks Run, with one exception (archBlock: a non-x86 Machine
  // field, which Wine refuses too). The parser reads what a file declares,
  // and saying "this won't run" about something that would have is worse
  // than letting the visitor find out.
  const MODERN_CRT = /^(vcruntime140|msvcp140|ucrtbase|api-ms-win-crt|msvcr(90|100|110|120))/i;

  // Named once so the "crt" preflight case can say which DLL it is, not just
  // that one is missing.
  function findCrtDll(p) {
    const hit = (p.imports || []).find((d) => MODERN_CRT.test(d.dll || ""));
    return hit ? hit.dll : null;
  }

  function classify(p, info) {
    if (p.format === "not-exe") return "not_exe";
    if (p.format === "dos") return "dos";
    if (p.format === "ne") return "win16";
    if (p.format === "le") return "cpu";
    const arch = p.machineInfo && p.machineInfo.arch;
    if (arch === "x64") return "x64";
    if (!p.sections || !p.sections.length || p.truncated) return "damaged";
    if (arch !== "x86") return "cpu";
    if (p.dotnet) return ".net";
    if (p.subsystem === 1 || (p.subsystem >= 10 && p.subsystem <= 13)) return "driver";
    if (p.isDll) return "dll";
    if (info.installer && p.overlaySize > p.size * 0.5) return "installer";
    // Only worth saying for a lone EXE: from a folder or zip the DLLs came along.
    if (state.entrySource === "exe" && findCrtDll(p)) return "crt";
    return "ok";
  }

  // pe-inspect.js already parsed the icon, version-info fields and capability
  // list for the analytics snapshot below — this just keeps what's worth
  // showing, so the preflight banner can say what the file actually is
  // instead of only what's wrong with it. Mirrors the null-checking idiom
  // pe-inspect.js's own render() uses (resources/icon/version can each be
  // null independently).
  function buildEnrichment(p, info, kase) {
    const ver = p.resources && p.resources.version;
    const fields = (ver && ver.fields) || {};
    return {
      icon: (p.resources && p.resources.icon) || null,
      description: fields.FileDescription || fields.ProductName || "",
      company: fields.CompanyName || "",
      capabilities: info.capabilities || [],
      crtDll: kase === "crt" ? findCrtDll(p) : null,
    };
  }

  // Ported, not re-derived, from pe-inspect.js's own verdict() blocker
  // phrasing — the loader only surfaces the subset relevant to whether this
  // specific sandbox can run the file, not the full capability list.
  function blockerNotes(caps) {
    const notes = [];
    if (caps.indexOf("Draws with Direct3D or OpenGL") >= 0) {
      notes.push(T("pfCapGfx", "it draws with Direct3D or OpenGL, and there is no GPU passthrough here"));
    }
    if (caps.indexOf("Talks to the network") >= 0) {
      notes.push(T("pfCapNet", "it expects a network, and the tab gives it none"));
    }
    return notes;
  }

  // [headline, explanation] per case. Plain text: these go through T() and
  // are set with textContent, so a translation cannot inject markup.
  const PF_TEXT = {
    x64: ["pfX64", "64-bit program",
      "pfX64Body", "The engine here runs 32-bit Windows programs only, so Run will not start this one. If the download page offers a 32-bit (x86) build of the same version, that one usually runs."],
    win16: ["pfWin16", "16-bit Windows program — switched engine",
      "pfWin16Body", "This was built for Windows 3.x. The engine is now set to Wine 3.1 (16-bit), the one that can run it."],
    win32: ["pfWin32", "32-bit program — switched engine back",
      "pfWin32Body", "The 16-bit engine cannot run this one, so the engine is back on Wine 1.7.55 (Win32)."],
    dos: ["pfDos", "A DOS program, not a Windows one",
      "pfDosBody", "Wine runs Windows programs, so it will not start this — but the DOS player on this site will, and your files go with you."],
    not_exe: ["pfNotExe", "This is not a Windows program",
      "pfNotExeBody", "It does not start with the MZ marker every .exe has. It may be a renamed archive or document, or a download that did not finish."],
    damaged: ["pfDamaged", "This file is incomplete or damaged",
      "pfDamagedBody", "Its headers describe more data than the file holds, which usually means the download stopped early. Download it again."],
    cpu: ["pfCpu", "Built for a different processor",
      "pfCpuBody", "The emulator here runs x86 code only, so this file cannot start."],
    driver: ["pfDriver", "A driver, not an application",
      "pfDriverBody", "This loads into the Windows kernel or runs before Windows does. There is nothing here to load it into."],
    ".net": ["pfDotnet", "A .NET program",
      "pfDotnetBody", "It needs the .NET Framework, which this Wine version predates, so it will most likely stop at startup."],
    dll: ["pfDll", "This is a DLL, not a program",
      "pfDllBody", "A DLL is a library that programs load. Load the program's whole folder and pick its .exe."],
    installer: ["pfInstaller", "This is an installer",
      "pfInstallerBody", "Running it unpacks the program rather than starting it. That can work — let it finish. Extracting the files may be quicker, but only works for ZIP/7z-based installers; it won't help with an InstallShield, MSI or NSIS-wrapped one."],
    crt: ["pfCrt", "It needs DLLs that came with it",
      "pfCrtBody", "This program uses {dll}, a Visual C++ runtime that is not part of Windows. Load its whole folder instead of the lone .exe, so those DLLs come too."],
  };
  Object.assign(PF_TEXT, {
    renpy: ["pfRenpy", "Ren'Py game — runs on Ren'Py's own engine",
      "pfRenpyBody", "Made with Ren'Py {version}. Run starts it on Ren'Py's web engine instead of Wine, so its 64-bit launcher doesn't matter. Only the game's own folders are used, and they stay on this device."],
    renpy_version: ["pfRenpyVersion", "Ren'Py {version} game — not supported yet",
      "pfRenpyVersionBody", "Ren'Py games run here on Ren'Py's own web engine, and this page has version {supported} of it. A game's Ren'Py files have to match that version, so Run will not start this one."],
    renpy_launcher: ["pfRenpyLauncher", "The launcher of a Ren'Py game",
      "pfRenpyLauncherBody", "This .exe only starts the Python that comes with the game; the game itself is the folder around it. Pick the whole folder, or a zip of it, and it runs here on Ren'Py's web engine."],
  });
  const PF_BAD = new Set(["x64", "dos", "not_exe", "damaged", "cpu", "driver", ".net", "dll", "renpy_version", "renpy_launcher"]);

  function preflightBox() {
    let box = document.getElementById("preflight");
    if (!box && els.dropzone) {
      box = document.createElement("div");
      box.id = "preflight";
      box.className = "preflight";
      box.setAttribute("role", "status");
      box.hidden = true;
      // Outside the dropzone: a click anywhere in there opens the file picker.
      els.dropzone.after(box);
    }
    return box;
  }

  function showPreflight(kase, enrichment) {
    const box = preflightBox();
    if (!box) return;
    box.replaceChildren();
    box.hidden = !kase;
    box.classList.toggle("preflight-bad", PF_BAD.has(kase));
    if (!kase) return;
    const t = PF_TEXT[kase];
    const head = document.createElement("strong");
    const vars = kase === "crt" ? { dll: (enrichment && enrichment.crtDll) || "a Visual C++ runtime" }
      : kase.startsWith("renpy") ? renpyVars() : undefined;
    head.textContent = T(t[0], t[1], vars);
    const body = document.createElement("p");
    body.textContent = T(t[2], t[3], vars);
    box.append(head, body);

    // What the file claims to be, read from the exact parse this banner's
    // verdict came from — turns "64-bit program" into "Notepad++ (Don Ho) —
    // 64-bit program" before the visitor commits to the download. Shows
    // nothing when a file carries no icon/version resource (most small
    // utilities don't) rather than a placeholder — this is additive, not a
    // thing every file needs to have.
    if (enrichment) {
      const idLine = [enrichment.description, enrichment.company].filter(Boolean).join(" — ");
      if (enrichment.icon || idLine) {
        const id = document.createElement("p");
        id.className = "preflight-id muted small";
        if (enrichment.icon) {
          const img = new Image();
          img.alt = "";
          img.width = 24;
          img.height = 24;
          img.style.cssText = "vertical-align:middle;image-rendering:pixelated;margin-right:.4em;border-radius:4px;";
          img.src = URL.createObjectURL(enrichment.icon.blob);
          img.onload = () => URL.revokeObjectURL(img.src);
          img.onerror = () => img.remove();
          id.append(img);
        }
        if (idLine) id.append(document.createTextNode(idLine));
        box.append(id);
      }
      // Only for the cases that aren't flatly broken — a blocker worth
      // knowing about before trying, not a pile-on next to "this is a DLL".
      if (!PF_BAD.has(kase) && enrichment.capabilities.length) {
        const notes = blockerNotes(enrichment.capabilities);
        if (notes.length) {
          const capP = document.createElement("p");
          capP.className = "muted small";
          capP.textContent = T("pfCapNote", "Worth knowing: {notes}.", { notes: notes.join("; ") });
          box.append(capP);
        }
      }
    }

    const actions = document.createElement("p");
    actions.className = "preflight-actions";
    const link = (href, key, text, action) => {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = T(key, text);
      if (action) a.addEventListener("click", () => track("preflight_action", { action }));
      actions.append(a, " ");
    };
    if (kase === "x64") {
      // The files travel with them, same as the DOS case below.
      link("/64/?chunked=1#handoff", "pfOpen64", "Try the experimental 64-bit engine — your file comes with you →", null);
      const a = actions.querySelector('a[href="/64/?chunked=1#handoff"]');
      a?.addEventListener("click", (e) => { e.preventDefault(); handoffToX64(); });
    }
    if (kase === "dos") {
      // The files travel with them, so the DOS player opens ready to run.
      link("/dos-emulator/#handoff", "pfDosLink", "Open it in the DOS player →", "open_dos");
      const a = actions.querySelector('a[href="/dos-emulator/#handoff"]');
      a?.addEventListener("click", async (e) => {
        e.preventDefault();
        await window.ExeHandoff?.put(state.stagedFiles, state.pickedExe && state.pickedExe.path);
        location.href = a.href;
      });
    }
    if (kase === "installer") link("/run/extract-archive/", "pfExtract", "Extract the files instead →", "extract");
    if (kase === "crt" || kase === "dll" || kase === "renpy_launcher") {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linklike";
      b.textContent = T("pfPickFolder", "Pick the folder instead");
      b.addEventListener("click", () => {
        track("preflight_action", { action: "pick_folder" });
        els.folderInput.click();
      });
      actions.append(b);
    }
    if (actions.childNodes.length) box.append(actions);
    // "Headers are occasionally wrong" is not true of the Machine field: Wine
    // reads it too, and Run won't start the file (archBlock).
    if (PF_BAD.has(kase) && !kase.startsWith("renpy") && !archBlock(state.pickedExe && state.pickedExe.bytes)) {
      const note = document.createElement("p");
      note.className = "muted small";
      note.textContent = T("pfRunAnyway", "You can still press Run — this is read from the file's headers, and they are occasionally wrong.");
      box.append(note);
    }
  }

  // What Run says, on the screen where the program would have appeared, when
  // it refuses a 64-bit or non-x86 file (archBlock) — or when Wine refuses
  // one mid-run because the visitor's program tried to start it.
  function showScreenMessage(block, child) {
    let box = document.getElementById("screen-message");
    if (!block) {
      if (box) box.remove();
      if (!state.booted && !state.bootInFlight) els.screenContainer.classList.remove("has-content");
      return;
    }
    if (!box) {
      box = document.createElement("div");
      box.id = "screen-message";
      box.className = "screen-message";
      box.setAttribute("role", "alert");
      els.screenContainer.append(box);
    }
    box.replaceChildren();
    const head = document.createElement("strong");
    const body = document.createElement("p");
    if (child) {
      head.textContent = T("runChildX64", "It tried to start a 64-bit program");
      body.textContent = T("runChildX64Body", "Wine here is a 32-bit build, so it refused to start {name}, which is 64-bit. If that program has a 32-bit (x86) build, put that in the folder instead.", { name: child });
    } else if (block.kase.startsWith("renpy")) {
      const t = PF_TEXT[block.kase];
      head.textContent = T(t[0], t[1], renpyVars());
      body.textContent = T(t[2], t[3], renpyVars());
    } else if (block.kase === "x64") {
      head.textContent = T("runBlockedX64", "64-bit program — not started");
      body.textContent = T("runBlockedX64Body", "Wine on this page is a 32-bit build. It checks the same header field Windows does and refuses 64-bit programs, so starting this would only end on a blank screen. If the download page offers a 32-bit (x86) build of the same version, that one usually runs here.");
    } else {
      head.textContent = T("runBlockedCpu", "Built for {cpu} — not started", { cpu: block.cpu });
      body.textContent = T("runBlockedCpuBody", "The emulator here runs x86 code only, and this file's header says it was built for a different processor. Look for an x86 (32-bit) build of the same program.");
    }
    box.append(head, body);
    // Not for a child: what would travel is the 32-bit program that started
    // it, and the 64-bit engine has no 32-bit Wine to run that with.
    if (!child && block.kase === "x64") {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = T("pfOpen64", "Try the experimental 64-bit engine — your file comes with you →");
      b.addEventListener("click", () => handoffToX64());
      box.append(b);
    }
    els.screenContainer.classList.add("has-content");
  }

  // A small, neutral confirmation that a handoff from the other loader (DOS
  // player <-> this one) actually carried files — the only prior sign was a
  // console log() line inside the collapsed <details> panel, which is not
  // somewhere a visitor who just clicked a link looks.
  function handoffNoticeBox() {
    let box = document.getElementById("handoff-notice");
    if (!box && els.dropzone) {
      box = document.createElement("p");
      box.id = "handoff-notice";
      box.className = "preflight";
      box.setAttribute("role", "status");
      box.hidden = true;
      els.dropzone.after(box);
    }
    return box;
  }
  function showHandoffNotice(text) {
    const box = handoffNoticeBox();
    if (!box) return;
    box.hidden = !text;
    box.textContent = text || "";
  }

  // The runtime is fetched in bootAndRun, so until then the engine is free to
  // change. After a boot it is not, and the caller says nothing rather than
  // claim a switch that did not happen.
  function switchVariant(to) {
    if (state.booted || state.bootInFlight) return false;
    state.selectedVariant = to;
    if (els.wineVariant) els.wineVariant.value = to;
    log(`Preflight: switched engine to ${to}.`);
    return true;
  }

  // Carries the staged files to the experimental 64-bit page through the same
  // handoff mailbox the DOS player uses (public/handoff.js), so neither the
  // reactive preflight link nor a proactive engine pick loses the upload the
  // way the old "pick the file again there" redirect did. Exposed on
  // window.ExeBrowser so embed.js's variant <select> can call it too.
  async function handoffToX64() {
    track("preflight_action", { action: "open_64" });
    await window.ExeHandoff?.put(state.stagedFiles, state.pickedExe && state.pickedExe.path);
    location.href = "/64/?chunked=1#handoff";
  }

  function preflight(stagedFile) {
    state.preflight = null;
    showPreflight(null);
    const rk = state.renpy ? (RENPY_RUNTIMES[state.renpy.version] ? "renpy" : "renpy_version")
      : isRenpyLauncher(stagedFile.bytes) ? "renpy_launcher" : null;
    if (rk) {
      log(state.renpy ? `Preflight: Ren'Py ${state.renpy.version || "?"} game "${state.renpy.name}".` : "Preflight: the launcher of a Ren'Py game, without the game.");
      showPreflight(rk);
      track("preflight_shown", { preflight: rk, format: "renpy", arch: "n/a", verdict: rk });
      return;
    }
    if (!window.PEInspect || !/\.exe$/i.test(stagedFile.path)) return;
    let p, info, v;
    try {
      const b = stagedFile.bytes;
      const buf = b.byteOffset === 0 && b.byteLength === b.buffer.byteLength
        ? b.buffer : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      p = window.PEInspect.parse(buf);
      info = window.PEInspect.interpret(p);
      v = window.PEInspect.verdict(p, info);
    } catch (err) {
      log("Preflight could not read this file: " + err.message, "warn");
      return;
    }
    let kase = classify(p, info);
    const enrichment = buildEnrichment(p, info, kase);
    state.preflight = {
      format: p.format,
      arch: (p.machineInfo && p.machineInfo.arch) || "n/a",
      subsystem: p.subsystem === 2 ? "gui" : p.subsystem === 3 ? "console" : p.subsystem == null ? "n/a" : "other",
      is_dotnet: p.dotnet ? 1 : 0,
      installer: info.installer ? 1 : 0,
      gfx3d: info.capabilities.indexOf("Draws with Direct3D or OpenGL") >= 0 ? 1 : 0,
      verdict: v.kind,
      preflight: kase,
      size_bucket: window.PEInspect.sizeBucket ? window.PEInspect.sizeBucket(stagedFile.bytes.length) : "n/a",
    };

    // The engine mismatches are fixed for them rather than described: a 16-bit
    // file gets the 16-bit engine, and a 32-bit file is taken off it again
    // (it is 16-bit only, whoever picked it).
    if (kase === "win16") {
      const from = state.selectedVariant;
      if (from === "win3x" || !switchVariant("win3x")) kase = null;
      else {
        state.autoSwitchedFrom = from;
        track("preflight_action", { action: "auto_16bit" });
      }
    } else if (state.selectedVariant === "win3x" && p.format === "pe" && state.preflight.arch === "x86") {
      const back = state.autoSwitchedFrom || "default";
      state.autoSwitchedFrom = null;
      if (switchVariant(back)) {
        track("preflight_action", { action: "auto_32bit" });
        if (kase === "ok") kase = "win32";
      }
    } else if (state.autoSwitchedFrom) {
      // We picked 16-bit for an earlier file; this one is not. Quietly give
      // back the engine the visitor had.
      if (switchVariant(state.autoSwitchedFrom)) state.autoSwitchedFrom = null;
    }
    if (kase === "ok") return;
    if (!kase) return;
    log(`Preflight: ${kase} (${state.preflight.format}/${state.preflight.arch}).`, PF_BAD.has(kase) ? "warn" : "info");
    showPreflight(kase, enrichment);
    track("preflight_shown", {
      preflight: kase, format: state.preflight.format, arch: state.preflight.arch, verdict: v.kind,
    });
  }

  async function handleSingleExe(file) {
    if (!file) return;
    clearStaged();
    const bytes = new Uint8Array(await file.arrayBuffer());
    warnIfNotPe(file.name, bytes);
    const safe = sanitizeExeName(file.name);
    state.stagedFiles.push({ path: safe, bytes });
    log(`Loaded ${file.name} → ${safe} (${formatBytes(file.size)}).`);
    state.entrySource = "exe";
    refreshEntryPicker();
  }

  async function handleFolder(fileList) {
    if (!fileList || fileList.length === 0) return;
    clearStaged();

    // webkitRelativePath looks like "MyApp/subdir/foo.dll". Drop the common
    // top-level folder so the zip root matches the folder root.
    const files = Array.from(fileList);
    const firstSlash = (p) => p.indexOf("/");
    const topLevel = files
      .map((f) => f.webkitRelativePath || f.name)
      .map((p) => (firstSlash(p) >= 0 ? p.slice(0, firstSlash(p)) : ""))
      .filter(Boolean);
    const allSameTop = topLevel.length > 0 && topLevel.every((t) => t === topLevel[0]);

    for (const f of files) {
      const raw = f.webkitRelativePath || f.name;
      const stripped = allSameTop ? raw.slice(topLevel[0].length + 1) : raw;
      if (!stripped) continue;
      const safe = sanitizeRelPath(stripped);
      if (!safe) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
      state.stagedFiles.push({ path: safe, bytes, raw: stripped });
    }
    log(`Loaded folder: ${files.length} files staged.`);
    state.entrySource = "folder";
    refreshEntryPicker();
  }

  async function handleZip(file) {
    if (!file) return;
    if (typeof JSZip === "undefined") {
      log("JSZip isn't loaded yet — try again in a moment.", "error");
      return;
    }
    clearStaged();
    const buf = await file.arrayBuffer();
    const zip = await loadZip(buf);
    const entries = listZipEntries(zip);
    for (const e of entries) {
      const safe = sanitizeRelPath(e.path);
      if (!safe) continue;
      const bytes = await readZipEntry(zip, e);
      if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
      state.stagedFiles.push({ path: safe, bytes, raw: e.path });
    }
    log(`Loaded zip: ${state.stagedFiles.length} files extracted.`);
    state.entrySource = "zip";
    refreshEntryPicker();
  }

  // ─── JSZip 2.x compatibility helpers ───────────────────────────────────
  // Boxedwine bundles JSZip 2.6.x (no async API). It accepts ArrayBuffer in
  // its constructor and returns string/Uint8Array from .asUint8Array().
  function loadZip(arrayBuffer) {
    // JSZip 2.x: `new JSZip(data)` or `new JSZip().load(data)`. Both sync.
    return new JSZip(arrayBuffer);
  }
  function listZipEntries(zip) {
    const out = [];
    // JSZip 2.x exposes .files as a name->ZipObject map.
    for (const name of Object.keys(zip.files)) {
      const obj = zip.files[name];
      if (obj.dir) continue;
      out.push({ path: name, obj });
    }
    return out;
  }
  function readZipEntry(zip, e) {
    // .asUint8Array() exists in JSZip 2.6+. Synchronous despite the function name.
    return Promise.resolve(e.obj.asUint8Array());
  }

  // ─── save writable layer ───────────────────────────────────────────────
  // Boxedwine's home overlay is an OverlayFS whose writable side is an
  // InMemory BFS. We reach it via BrowserFS.BFSRequire('fs').getRootFS() and
  // pull the writable layer out with getOverlayedFileSystems(). That layer
  // contains *only* files the running app wrote during this session — no
  // boilerplate Wine prefix — so zipping it gives us a clean delta.

  // Boxedwine mounts two OverlayFS instances:
  //   '/root/base'  → rootOverlay  (Wine system; writable side captures
  //                    installer output under C:\windows, C:\Program Files, …
  //                    because C:\ maps to /root/base/home/username/.wine/drive_c)
  //   '/root/files' → homeOverlay (the app's working dir; user-app writes)
  // Return both writable layers so we can zip the union and not miss either.
  function getWritableLayers() {
    if (activeVariant().shell === "upstream") {
      const FS = window.FS || (window.__BoxedwineModule && window.__BoxedwineModule.FS);
      if (!FS || !window.__BoxedwineRoot) throw new Error("Wine is not running yet.");
      return [{ mount: "", writable: emscriptenLayer(FS, window.__BoxedwineRoot()) }];
    }
    const BFS = window.BrowserFS;
    if (!BFS) throw new Error("BrowserFS not initialized — boot Wine first.");
    const fs = BFS.BFSRequire("fs");
    const root = fs.getRootFS && fs.getRootFS();
    if (!root || !root.mntMap) throw new Error("BrowserFS root not mounted.");

    // Different Boxedwine runtimes name the home overlay's mount point
    // differently: 'default' uses Config.appDirPrefix (= "/root/files/"),
    // 18R2 uses Config.dirPrefix. Pull whichever exists and don't crash if
    // one is missing — we'll still get the system overlay.
    const cfg = window.__BoxedwineConfig || {};
    const homeMount = ((cfg.appDirPrefix || cfg.dirPrefix || "")).replace(/\/$/, "");

    const out = [];
    for (const [mount, ov] of Object.entries(root.mntMap)) {
      if (mount !== "/root/base" && mount !== homeMount) continue;
      if (ov && typeof ov.getOverlayedFileSystems === "function") {
        const { writable } = ov.getOverlayedFileSystems();
        if (writable) out.push({ mount, writable });
      }
    }
    if (out.length === 0) throw new Error("No OverlayFS layers found.");
    return out;
  }

  // The upstream shell has no overlays: everything Wine or the program wrote
  // is under one Emscripten directory. This gives that directory the three
  // BrowserFS calls collectWritableFiles makes. lstat, so the dosdevices
  // drive links are skipped rather than walked twice.
  function emscriptenLayer(FS, root) {
    const at = (p) => root + (p === "/" ? "" : p);
    return {
      readdirSync: (p) => FS.readdir(at(p)).filter((n) => n !== "." && n !== ".."),
      statSync: (p) => {
        const mode = FS.lstat(at(p)).mode;
        return { isDirectory: () => FS.isDir(mode), isFile: () => FS.isFile(mode) };
      },
      readFileSync: (p) => FS.readFile(at(p)),
    };
  }

  // Walk a BrowserFS layer synchronously (sync API works on InMemory) and
  // collect { path, bytes } pairs. Skip /.deletedFiles.log (BFS bookkeeping).
  //
  // `layer` is the raw writable backend — fine for readdir/stat, but its
  // readFileSync takes (path, encoding, flag) and throws "Cannot read
  // properties of undefined" on the Node-style call. So we enumerate on the
  // layer and read through the mounted fs façade at `mount`, which builds the
  // FileFlag for us. Reading the layer directly silently yielded zero files,
  // which is why the download button produced empty zips.
  function collectWritableFiles(layer, mount = "", dir = "/") {
    const out = [];
    let entries;
    try {
      entries = layer.readdirSync(dir);
    } catch (e) {
      return out;
    }
    const rootFs = mount ? window.BrowserFS.BFSRequire("fs") : null;
    for (const name of entries) {
      const full = dir === "/" ? "/" + name : dir + "/" + name;
      if (full === "/.deletedFiles.log") continue;
      let stat;
      try { stat = layer.statSync(full); } catch (e) { continue; }
      if (stat.isDirectory()) {
        out.push(...collectWritableFiles(layer, mount, full));
      } else if (stat.isFile()) {
        let buf;
        try {
          buf = rootFs ? rootFs.readFileSync(mount + full) : layer.readFileSync(full);
        } catch (e) { continue; }
        out.push({ path: full.replace(/^\//, ""), bytes: buf });
      }
    }
    return out;
  }

  // ─── persist writable layer across visits ──────────────────────────────
  // Same idea as the DOS save layer: the writable side of each OverlayFS
  // holds only what the running app wrote, so it's a clean delta to store.
  // Keyed per app slug so KeePass databases don't leak into PuTTY's session
  // list. Best-effort — browsers evict IndexedDB, and the copy shipped here
  // is a convenience, not a backup (downloadWritableLayer stays the export).
  const WINE_PERSIST_ON = new URLSearchParams(location.search).get("persist") !== "0";
  const WINE_DB = "wineSaves";
  const WINE_STORE = "layers";
  const WINE_MAX_BYTES = 16 * 1024 * 1024;
  // On a game page the slug is the game. Off one — the homepage's bring-your-
  // own-EXE loader — there is no slug, and everything used to share the single
  // key "home": upload KeePass, then upload PuTTY, and PuTTY booted with
  // KeePass's files layered over it. Key on the executable instead.
  const wineSlugBase = (location.pathname.match(/\/run\/([^/]+)/) || [])[1] || "";
  let wineSlug = wineSlugBase || "home";

  function shortHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i) & 0xff;
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  // Called once the chosen executable is known, before the first save.
  function resolveWineSlug() {
    if (wineSlugBase) return wineSlug;
    const name = state.pickedExe?.originalName || "";
    wineSlug = name ? "byo-" + shortHash(name.toLowerCase()) : "home";
    return wineSlug;
  }

  function wineIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(WINE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(WINE_STORE)) req.result.createObjectStore(WINE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function wineIdbGet(key) {
    return wineIdb().then(db => new Promise((res, rej) => {
      const r = db.transaction(WINE_STORE, "readonly").objectStore(WINE_STORE).get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    }));
  }
  function wineIdbPut(key, val) {
    return wineIdb().then(db => new Promise((res, rej) => {
      const r = db.transaction(WINE_STORE, "readwrite").objectStore(WINE_STORE).put(val, key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    }));
  }

  // Which writable-layer paths are worth carrying between visits. Wine's own
  // prefix scaffolding is rebuilt on every boot, so we keep the user's home
  // and documents, the app's own working directory, and the registry hives
  // that hold app settings — and skip symlink stubs and .keep placeholders.
  function isUserData(path) {
    if (/\.link$/.test(path) || /(^|\/)\.keep$/.test(path)) return false;
    if (/(^|\/)\.deletedFiles\.log$/.test(path)) return false;
    // Booting Wine copies its own runtime into the writable layer — lib/,
    // usr/, bin/, share/ hold ~20 MB of .so files that are identical on every
    // boot. Allow-list the two places user state actually lives instead of
    // trying to name everything to exclude.
    const home = path.match(/^home\/[^/]+\/\.wine\/(.*)$/);
    if (!home) {
      // Anything outside home/ is either Wine's runtime (system layer) or the
      // app's own working directory (/root/files layer). The latter has no
      // home/ prefix at all, so keep only paths that aren't system trees.
      return !/^(lib|usr|bin|etc|share|dev|proc|mnt|tmp|var|sbin|opt)(\/|$)/.test(path);
    }
    const rest = home[1];
    // Registry hives carry app settings and are small.
    if (/^(user|system|userdef)\.reg$/.test(rest)) return true;
    const drivec = rest.match(/^drive_c\/(.*)$/);
    if (!drivec) return false;
    const inC = drivec[1];
    if (/^windows\//i.test(inC)) return false;                          // Wine-generated
    if (/^users\/[^/]+\/Local Settings\/Temp\//i.test(inC)) return false; // scratch
    return true;                                                         // documents, app data, installs
  }

  // Snapshot every writable layer into a plain {mount: {path: bytes}} map.
  let winePersistInFlight = null;
  function persistWineLayers(reason) {
    if (!WINE_PERSIST_ON || !state.booted || winePersistInFlight) return winePersistInFlight || Promise.resolve();
    winePersistInFlight = (async () => {
      try {
        const snapshot = {};
        let total = 0;
        for (const { mount, writable } of getWritableLayers()) {
          const files = {};
          for (const f of collectWritableFiles(writable, mount)) {
            // Booting Wine writes ~26 MB of prefix boilerplate into the
            // writable layer — font links, .keep placeholders, the default
            // registry. That's regenerated on every boot, so persisting it
            // would blow the size cap and save nothing anyone cares about.
            // Keep the parts that represent user state instead.
            if (!isUserData(f.path)) continue;
            const bytes = f.bytes.buffer
              ? new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength)
              : new Uint8Array(f.bytes);
            total += bytes.length;
            if (total > WINE_MAX_BYTES) throw new Error("saved files exceed " + (WINE_MAX_BYTES / 1048576) + " MB");
            files[f.path] = bytes;
          }
          if (Object.keys(files).length) snapshot[mount] = files;
        }
        if (!total) { log("Nothing new to save yet.", "warn"); return; }
        const key = resolveWineSlug();
        await wineIdbPut(key, snapshot);
        log(`Saved ${formatBytes(total)} of your files in this browser.`);

        window.SaveCore?.note({
          slug: key,
          // On a game page the title people recognise is the page's, not the
          // executable's — nobody is looking for "SKI32.EXE" in a resume card.
          // An uploaded EXE has no page, so there the filename is all there is.
          name: (wineSlugBase && document.getElementById("exe-embed")?.dataset.appName)
            || state.pickedExe?.originalName
            || key,
          runtime: "wine",
          kind: "files",
          payload: { db: WINE_DB, store: WINE_STORE, key },
          bytes: total,
          // Boxedwine draws through Emscripten's Browser.createContext, which
          // may hand back a WebGL context with no preserveDrawingBuffer — that
          // reads back blank. thumbFromCanvas returns null rather than a black
          // rectangle, and the card falls back to the game's poster art. Not
          // worth the per-frame cost of forcing a readable buffer for a
          // thumbnail on something like PuTTY.
          thumb: window.SaveCore.thumbFromCanvas(document.getElementById("canvas")),
        });
        track("persist_save", { bytes: total, reason });
        // Same reasoning as dos-embed.js: the first save landing is the moment
        // a player learns the site remembers them, so that is where the offer
        // to keep it one tap away belongs.
        noteWineReturnRoute();
      } catch (err) {
        log("Could not save your files: " + err.message, "warn");
      } finally {
        winePersistInFlight = null;
      }
    })();
    return winePersistInFlight;
  }

  // Poll for the exact state restoreWineLayers needs: both overlays mounted,
  // and Wine's own prefix copy finished. That second part matters — the mounts
  // appear well before Wine has populated them, and restoring into a prefix
  // that's still being written gets the files overwritten a moment later.
  // A non-empty writable layer is the cheapest available proof it's done.
  async function waitForOverlays(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const layers = getWritableLayers();
        const populated = layers.some(({ writable }) => {
          try { return writable.readdirSync("/").length > 0; } catch { return false; }
        });
        if (populated) return true;
      } catch {
        // Not mounted yet — getWritableLayers throws with a precise reason.
      }
      await new Promise(r => setTimeout(r, 250));
    }
    log("Wine's filesystem never finished mounting — skipping the restore.", "warn");
    return false;
  }

  // Write a stored snapshot back into the fresh overlays after boot.
  async function restoreWineLayers() {
    if (!WINE_PERSIST_ON) return 0;
    let snapshot;
    try {
      snapshot = await wineIdbGet(resolveWineSlug());
      // Everything uploaded on the homepage used to land under "home". Read it
      // once so an existing save isn't stranded by the new per-EXE key; the
      // next save writes it back under the key it should have had.
      if (!snapshot && !wineSlugBase) snapshot = await wineIdbGet("home");
    } catch { return 0; }
    if (!snapshot) return 0;
    let restored = 0;
    try {
      // Write through the mounted fs façade rather than the raw layer: the
      // backend's own writeFileSync takes (path, data, encoding, flag, mode)
      // and throws on the friendlier Node signature. Going through the mount
      // point also lets OverlayFS route the write to the writable side.
      const fs = window.BrowserFS.BFSRequire("fs");
      const Buffer = window.BrowserFS.BFSRequire("buffer").Buffer;
      for (const { mount } of getWritableLayers()) {
        const files = snapshot[mount];
        if (!files) continue;
        for (const [path, bytes] of Object.entries(files)) {
          const full = mount + "/" + path;
          try {
            mkdirpSync(fs, full.slice(0, full.lastIndexOf("/")));
            fs.writeFileSync(full, Buffer.from(bytes));
            restored++;
          } catch { /* one bad file shouldn't sink the restore */ }
        }
      }
    } catch (err) {
      log("Could not restore your files: " + err.message, "warn");
      return 0;
    }
    if (restored) {
      log(`Restored ${restored} file(s) you saved here previously.`);
      track("persist_restore", { files: restored });
    }
    return restored;
  }

  function mkdirpSync(fs, dir) {
    const parts = dir.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur += "/" + p;
      try { fs.mkdirSync(cur); } catch { /* already exists */ }
    }
  }

  async function downloadWritableLayer() {
    try {
      const layers = getWritableLayers();
      const zip = new JSZip();
      let totalBytes = 0;
      let totalFiles = 0;
      const perLayerCounts = [];

      for (const { mount, writable } of layers) {
        const files = collectWritableFiles(writable, mount);
        perLayerCounts.push(`${mount || "root"}: ${files.length}`);
        // Top-level folder in the output zip mirrors the BFS mount so users
        // can see which writes came from where. `/root/base` → "system",
        // `/root/files` → "appdir" — friendlier than raw mount paths.
        const folder = mount === "/root/base" || mount === "" ? "system" : "appdir";
        for (const f of files) {
          const bytes = f.bytes.buffer
            ? new Uint8Array(f.bytes.buffer, f.bytes.byteOffset, f.bytes.byteLength)
            : new Uint8Array(f.bytes);
          zip.file(`${folder}/${f.path}`, bytes);
          totalBytes += bytes.length;
          totalFiles += 1;
        }
      }

      log(`Writable layer scan: ${perLayerCounts.join(", ")}.`);

      if (totalFiles === 0) {
        log("Writable layers are empty — nothing to download.", "warn");
        return;
      }

      const zipBytes = zip.generate({ type: "uint8array", compression: "DEFLATE" });
      const blob = new Blob([zipBytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
      const a = document.createElement("a");
      a.href = url;
      a.download = `exebrowser-output-${ts}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      log(`Downloaded ${totalFiles} file(s), ${formatBytes(totalBytes)} (zipped to ${formatBytes(zipBytes.length)}).`);
    } catch (err) {
      log("Save failed: " + err.message, "error");
    }
  }

  async function buildAppZip() {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip not loaded — boot Wine first.");
    }
    if (state.stagedFiles.length === 0 || !state.pickedExe) {
      throw new Error("No files staged.");
    }
    // Boxedwine's shell.js uses the zip basename (sans .zip) as the working-dir
    // folder name. So we wrap every staged file under `userapp/...` and that
    // becomes `D:/userapp` at runtime — which matches our app-zip filename
    // (userapp.zip). Entry EXE keeps its relative subpath so assets resolve.
    const zip = new JSZip();
    const ROOT = "userapp/";
    for (const f of state.stagedFiles) {
      zip.file(ROOT + f.path, f.bytes);
    }
    const bytes = zip.generate({ type: "uint8array", compression: "STORE" });
    state.appZipBlob = new Blob([bytes], { type: "application/zip" });
    log(`Packaged ${state.stagedFiles.length} file(s) under userapp/ into ${formatBytes(state.appZipBlob.size)} virtual zip.`);
  }

  // ─── orchestrator ──────────────────────────────────────────────────────

  let wineReturnNoted = false;
  function noteWineReturnRoute() {
    if (wineReturnNoted) return;
    wineReturnNoted = true;
    const host = document.getElementById("dos-save-state") || document.getElementById("save-state");
    if (!host) return;
    const note = document.createElement("span");
    note.className = "muted small save-return-note";
    note.textContent = " — it will still be here when you come back.";
    host.appendChild(note);
    if (window.ExeInstall && window.ExeInstall.available() && !window.ExeInstall.isIOS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linklike save-install";
      b.textContent = T("wineInstallPrompt", "Install for one-tap return");
      b.addEventListener("click", () => window.ExeInstall.prompt());
      host.appendChild(document.createTextNode(" "));
      host.appendChild(b);
    }
  }

  function track(name, params) {
    if (typeof window.gtag === "function") {
      // /run/<slug>/ names itself; the home page is "home"; anything else uses
      // its own path. The bare "home" fallback meant /load-exe/ — a second page
      // with the same loader on it — reported its boots as the home page's,
      // which is exactly the comparison the page exists to be measured on.
      const slug = (location.pathname.match(/\/run\/([^/]+)/) || [])[1]
        || (location.pathname === "/" ? "home" : location.pathname.replace(/^\/|\/$/g, "") || "home");
      window.gtag("event", name, Object.assign({ app_slug: slug, runtime: "boxedwine" }, params || {}));
    }
  }

  // Playtime heartbeat: one event per minute of *foreground* use. Same shape as
  // dos-embed.js and play-events.js — see the note there. This one had no stop
  // at all, so a Wine app left open in a background tab reported playtime
  // indefinitely; setInterval's background throttle is about one minute, which
  // happens to be our cadence, so the inflated numbers looked entirely normal.
  let hbTimer = null, lastBeat = 0, hbLive = false;
  function startHeartbeat() {
    hbLive = true;
    if (hbTimer || document.visibilityState === "hidden") return;
    lastBeat = performance.now();
    hbTimer = setInterval(() => {
      lastBeat = performance.now();
      track("playtime_heartbeat", { seconds: 60 });
    }, 60000);
  }
  function pauseHeartbeat() {
    if (!hbTimer) return;
    const partial = Math.round((performance.now() - lastBeat) / 1000);
    clearInterval(hbTimer);
    hbTimer = null;
    if (partial >= 5) track("playtime_heartbeat", { seconds: partial });
  }
  function stopHeartbeat() {
    pauseHeartbeat();
    hbLive = false;
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") pauseHeartbeat();
    else if (hbLive) startHeartbeat();
  });
  addEventListener("pagehide", pauseHeartbeat);

  // ─── did it actually draw? ─────────────────────────────────────────────
  // boot_success fires once the emulator script has loaded, before Wine has
  // drawn anything, so a blank screen counts as a success there. This watches
  // the canvas itself — Boxedwine draws through a plain 2D context, so it can
  // be read back — and reports the first frame that shows a picture. One
  // definition of "it ran" for uploads (byo_result) and hosted titles
  // (first_frame) alike. boot_success stays as it was so its history holds.
  const FRAME_POLL_MS = 500;
  const FRAME_TIMEOUT_MS = 90000;
  const FRAME_MIN_COLOURS = 4;
  let frameProbe = null;

  function canvasColours(canvas) {
    try {
      if (!canvas || !canvas.width || !canvas.height) return 0;
      if (!frameProbe) {
        frameProbe = document.createElement("canvas");
        frameProbe.width = 64;
        frameProbe.height = 48;
      }
      const ctx = frameProbe.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(canvas, 0, 0, 64, 48);
      const d = ctx.getImageData(0, 0, 64, 48).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    } catch {
      return 0;
    }
  }

  // The timeout counts only time the tab was on screen. A hidden tab gets no
  // animation frames, so Boxedwine paints nothing however long it runs, and
  // someone who switched tabs during the download would otherwise be counted
  // as a program that never drew.
  // Boxedwine's SDL draws through WebGL without preserveDrawingBuffer, so the
  // buffer is cleared once each frame is composited and reading it back
  // between paints returns a blank image. An animated game is caught mid-paint
  // often enough to look fine; a static window like Notepad reads as empty
  // forever. Asking for a preserved buffer on this one canvas makes the
  // picture readable at any moment, for the watcher below and for save
  // thumbnails alike. On an 800x600 canvas the cost is one small copy a frame.
  function keepCanvasReadable() {
    const proto = HTMLCanvasElement.prototype;
    if (proto.getContext.__exeBrowserPreserve) return;
    const original = proto.getContext;
    const patched = function (type, attrs) {
      if (this === els.canvas && /webgl/i.test(String(type))) {
        attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
      }
      return original.call(this, type, attrs);
    };
    patched.__exeBrowserPreserve = true;
    proto.getContext = patched;
  }

  function watchFirstFrame(t0, report, onTick) {
    let done = false;
    let visibleMs = 0;
    let last = performance.now();
    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      removeEventListener("pagehide", onHide);
      report(outcome, Math.round(performance.now() - t0));
    };
    const onHide = () => finish("left_early");
    const timer = setInterval(() => {
      const now = performance.now();
      if (document.visibilityState === "visible") visibleMs += now - last;
      last = now;
      const present = document.getElementById("boxedwine-webgl-canvas-0");
      if (Math.max(canvasColours(els.canvas), canvasColours(present)) >= FRAME_MIN_COLOURS) finish("frame");
      else if (visibleMs > FRAME_TIMEOUT_MS) finish("no_frame");
      else if (onTick) onTick(visibleMs);
    }, FRAME_POLL_MS);
    addEventListener("pagehide", onHide);
  }

  // Reassurance during the frame-wait, keyed to the same clock watchFirstFrame
  // already runs. A static window (Notepad-style) can go a long time before
  // the colour-sample catches a real paint; without this the wait looks
  // identical to a stall. Thresholds sit well short of the real 90s no_frame
  // timeout so this never implies failure before that timeout does.
  function makeFrameWaitTicker() {
    const shown = new Set();
    const thresholds = [
      [8000, "wineStillStarting", "Still starting…"],
      [25000, "wineStillWaiting", "Still waiting for a picture — normal for some older software. Check Console output below if this continues."],
    ];
    return (visibleMs) => {
      for (const [ms, key, fallback] of thresholds) {
        if (visibleMs >= ms && !shown.has(ms)) {
          shown.add(ms);
          setFetchStatusText(T(key, fallback));
        }
      }
    };
  }

  // Everything byo_result knows about the visitor's program. Never the name:
  // what they run is theirs, and the shape of it is all the question needs.
  function byoParams() {
    const isBat = /\.bat$/i.test(state.pickedExe?.path || "");
    return Object.assign(
      { format: isBat ? "bat" : "n/a" },
      state.preflight || {},
      { variant: state.selectedVariant, entry_source: state.entrySource },
    );
  }

  async function bootAndRun() {
    if (state.bootInFlight) return;
    if (!state.pickedExe) {
      log("Pick an EXE first.", "error");
      return;
    }
    if (state.renpy) return runRenpy();
    if (isRenpyLauncher(state.pickedExe.bytes)) {
      log(`Not started: ${state.pickedExe.path} is the launcher of a Ren'Py game, and the game is the folder around it.`, "warn");
      setStatus(T("runBlockedStatus", "Not started — see the message above."));
      showScreenMessage({ kase: "renpy_launcher" });
      els.screenContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      track("preflight_action", { action: "blocked_renpy_launcher" });
      return;
    }

    const blocked = archBlock(state.pickedExe.bytes);
    if (blocked) {
      log(`Not started: ${state.pickedExe.path} is built for ${blocked.cpu}, and Wine here runs 32-bit x86 programs only.`, "warn");
      setStatus(T("runBlockedStatus", "Not started — see the message above."));
      showScreenMessage(blocked);
      els.screenContainer.scrollIntoView({ behavior: "smooth", block: "nearest" });
      track("preflight_action", { action: "blocked_" + blocked.kase });
      return;
    }

    if (activeVariant().shell === "upstream" && !jitSupported()) {
      log("This browser can't run the JIT engine (it needs WebAssembly exception handling, tail calls and SIMD), so the default engine runs this instead.", "warn");
      state.selectedVariant = "default";
      if (els.wineVariant) els.wineVariant.value = "default";
    }

    state.bootInFlight = true;
    els.runBtn.disabled = true;
    els.bootBtn.disabled = true;
    const t0 = performance.now();
    const byo = !!state.entrySource && state.entrySource !== "hosted";
    if (byo && state.preflight && PF_BAD.has(state.preflight.preflight)) {
      track("preflight_action", { action: "run_anyway" });
    }

    try {
      keepCanvasReadable();
      installXhrInterceptor();
      resetFetchProgress();
      await loadBoxedwineDeps();
      await buildAppZip();
      await runShellWithConfig();

      els.screenContainer.classList.add("has-content");

      await startEmulator();
      state.booted = true;
      els.saveStateBtn.disabled = false;
      setStatus(T("wineRunning", "Running {name}…", { name: state.pickedExe.originalName }));
      setFetchStatusText("");
      // Someone who has got a program running has earned the install offer,
      // whether or not they have ever saved anything.
      if (window.ExeInstall && window.ExeInstall.engaged) window.ExeInstall.engaged("boot");
      log("Launch dispatched. Canvas will activate when Wine is ready.");
      track("boot_success", { boot_ms: Math.round(performance.now() - t0) });
      startHeartbeat();
      watchFirstFrame(t0, (outcome, ms) => {
        state.frameOutcome = outcome;
        setFetchStatusText("");
        log(`First frame: ${outcome} after ${ms} ms.`);
        if (rangeLazy) log(`Wine root pieces read on demand so far, beyond the boot preload: ${rangeLazy.length ? rangeLazy.join(",") : "none"}.`);
        if (byo) track("byo_result", Object.assign({ outcome, ttff_ms: ms }, byoParams()));
        else track("first_frame", { outcome, ttff_ms: ms });
      }, makeFrameWaitTicker());

      // The upstream shell (jit) persists its own writes in IndexedDB, keyed
      // per program (storageKey), so the overlay snapshots below are not
      // needed there.
      if (WINE_PERSIST_ON && activeVariant().shell !== "upstream") {
        // The overlays only exist once Wine has finished mounting, and how
        // long that takes depends on the connection and the machine. Four
        // seconds was a guess, and on a slow boot it fired into nothing —
        // silently, because there was no save to restore *yet*. Wait for the
        // condition instead of the clock.
        waitForOverlays()
          .then(ready => (ready ? restoreWineLayers() : 0))
          .catch(() => {});
        navigator.storage?.persist?.().catch(() => {});

        const flusher = window.SaveCore
          ? window.SaveCore.schedule({
              intervalMs: 30000,
              flush: (reason) => persistWineLayers(reason),
            })
          : null;
        if (!flusher) {
          setInterval(() => persistWineLayers("interval"), 30000);
          document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") persistWineLayers("hidden");
          });
          window.addEventListener("pagehide", () => persistWineLayers("pagehide"));
        }
        // Deliberately no `beforeunload` handler clearing the timer: on Safari
        // that could tear the flusher down before the pagehide write ran,
        // which is the one write that matters most.
      }
    } catch (err) {
      track("boot_error", { error_message: String(err.message).slice(0, 120) });
      if (byo) {
        track("byo_result", Object.assign(
          { outcome: "error", ttff_ms: Math.round(performance.now() - t0) }, byoParams()));
      }
      log("Boot failed: " + err.message, "error");
      setStatus(T("wineBootFailed", "Boot failed. See console."));
      setFetchStatusText("");
      els.bootBtn.disabled = false;
      els.runBtn.disabled = false;
      state.bootInFlight = false;
    }
  }

  // ─── wiring ────────────────────────────────────────────────────────────

  els.bootBtn.addEventListener("click", () => {
    // The "Boot Wine" button now just enables the loader section; actual boot
    // happens on Run (we need an EXE before we know what to launch). We lock
    // in the variant selection here so the dropdown can be disabled to make it
    // clear the choice is committed.
    const choice = els.wineVariant ? els.wineVariant.value : "default";

    // The experimental 64-bit variant is a SEPARATE, self-contained page
    // (Boxedwine64 / wine64 wasm64-mt build at /64/). It has its own loader,
    // rootfs (split same-origin parts), app launcher, and EXE upload — none of
    // the 32-bit shell wiring below applies. So hand off to it instead of
    // enabling the inline loader. ?chunked=1 tells the launcher to fetch the
    // rootfs via its part manifests up front (we ship only the <25 MB split
    // parts on Pages, not the whole 196 MB wine64.zip).
    if (choice === "x64") {
      window.location.href = "/64/?chunked=1";
      return;
    }

    state.selectedVariant = WINE_VARIANTS[choice] ? choice : "default";
    if (els.wineVariant) els.wineVariant.disabled = true;

    els.loaderSection.classList.remove("disabled");
    setStatus(T("winePickThenRun", "Pick an EXE, then click Run."));
    els.bootBtn.disabled = true;
    els.bootBtn.textContent = T("wineReadyLoad", "Wine ready — load an EXE");
    log("Wine ready to load (variant: " + state.selectedVariant + "). Drop an EXE below.");
  });

  els.pickBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.exeInput.click();
  });
  els.pickFolderBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.folderInput.click();
  });
  els.pickZipBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    els.zipInput.click();
  });
  els.exeInput.addEventListener("change", (e) => handleSingleExe(e.target.files[0]));
  els.folderInput.addEventListener("change", (e) => handleFolder(e.target.files));
  els.zipInput.addEventListener("change", (e) => handleZip(e.target.files[0]));
  els.entryPicker.addEventListener("change", (e) => {
    const f = state.candidateExes.find((c) => c.path === e.target.value);
    if (f) setEntry(f);
  });

  // Dropzone drop: route by file shape. A single .exe → exe handler; a single
  // .zip → zip handler; otherwise treat as a folder/files drop.
  els.dropzone.addEventListener("click", () => els.exeInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.exeInput.click();
    }
  });
  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("hover");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("hover"));
  els.dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("hover");
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;
    if (files.length === 1 && /\.exe$/i.test(files[0].name)) {
      handleSingleExe(files[0]);
    } else if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
      handleZip(files[0]);
    } else {
      // Browsers don't populate webkitRelativePath for dragged-in items unless
      // we walk e.dataTransfer.items (which we keep deferred). For now treat
      // dropped multi-file as flat list at zip root.
      clearStaged();
      for (const f of files) {
        const safe = sanitizeRelPath(f.name);
        if (!safe) continue;
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
        state.stagedFiles.push({ path: safe, bytes });
      }
      log(`Dropped ${state.stagedFiles.length} files (flat).`);
      state.entrySource = "files";
      refreshEntryPicker();
    }
  });

  els.runBtn.addEventListener("click", bootAndRun);

  // Sent here from the DOS player with a Windows program already chosen.
  if (location.hash === "#handoff" && window.ExeHandoff) {
    try { history.replaceState(null, "", location.pathname + location.search); } catch (_) { /* cosmetic */ }
    window.ExeHandoff.take().then((h) => {
      if (!h || !h.files || !h.files.length) return;
      clearStaged();
      for (const f of h.files) {
        const safe = sanitizeRelPath(f.path);
        if (safe) state.stagedFiles.push({ path: safe, bytes: f.bytes });
      }
      log(`Brought over ${state.stagedFiles.length} file(s) from the DOS player.`);
      showHandoffNotice(T("wineHandoffArrived", "Brought over from the DOS player — ready to run."));
      state.entrySource = "handoff";
      refreshEntryPicker();
      if (h.entry) window.ExeBrowser?.preferEntry(h.entry.split("/").pop());
      els.dropzone.scrollIntoView({ behavior: "smooth", block: "center" });
    }).catch(() => {});
  }
  els.saveStateBtn.addEventListener("click", downloadWritableLayer);

  // ─── programmatic API ────────────────────────────────────────────────────
  // Exposed so per-app instant-play pages (/run/<app>/) can drive the same
  // engine without the user hand-picking a file: stage a hosted, license-clean
  // app payload (a zip fetched over the network), pick the entry EXE, and boot —
  // all the real pipeline above, just fed programmatically. Returns helpers that
  // resolve once the launch is dispatched. Everything still runs client-side;
  // the only difference from a manual upload is where the bytes come from.
  async function stageHostedZip(url) {
    if (typeof JSZip === "undefined") {
      // JSZip is preloaded below; wait briefly if a fast click beats it.
      await new Promise((r) => setTimeout(r, 250));
      if (typeof JSZip === "undefined") throw new Error("JSZip not ready yet.");
    }
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
    const buf = await r.arrayBuffer();
    clearStaged();
    const zip = await loadZip(buf);
    const entries = listZipEntries(zip);
    for (const e of entries) {
      const safe = sanitizeRelPath(e.path);
      if (!safe) continue;
      const bytes = await readZipEntry(zip, e);
      if (/\.exe$/i.test(safe)) warnIfNotPe(safe, bytes);
      state.stagedFiles.push({ path: safe, bytes });
    }
    log(`Fetched hosted app: ${state.stagedFiles.length} files staged from ${url}.`);
    state.entrySource = "hosted";
    refreshEntryPicker();
  }

  // ?engine=jit runs the page on the JIT engine wherever it would have used
  // the default one, so a hosted /run/ title can be tried on it (and on Wine
  // 11) without a picker. Titles pinned to another engine (gecko, win3x,
  // r18) keep it.
  const ENGINE_OVERRIDE = new URLSearchParams(location.search).get("engine") === "jit" ? "jit" : null;
  if (ENGINE_OVERRIDE) {
    state.selectedVariant = ENGINE_OVERRIDE;
    if (els.wineVariant) els.wineVariant.value = ENGINE_OVERRIDE;
  }

  window.ExeBrowser = {
    // Lock in a Wine variant (e.g. "gecko" for Pinball) before boot.
    setVariant(name) {
      if (ENGINE_OVERRIDE && name === "default") name = ENGINE_OVERRIDE;
      if (WINE_VARIANTS[name]) {
        state.selectedVariant = name;
        // A deliberate choice outranks one the preflight made.
        state.autoSwitchedFrom = null;
        if (els.wineVariant) els.wineVariant.value = name;
      }
    },
    // Prefer a specific entry EXE by basename once files are staged (e.g.
    // "DOOM95.EXE"). Sanitizes the name the same way stageHostedZip does so
    // "notepad++.exe" correctly matches the staged "NOTEPAD_.EXE".
    preferEntry(basename) {
      const name = String(basename);
      // .bat files: match by exact name (case-insensitive), no sanitization
      if (/\.bat$/i.test(name)) {
        const hit = state.candidateExes.find(
          (f) => f.path.split("/").pop().toUpperCase() === name.toUpperCase()
        );
        if (hit) { setEntry(hit); return; }
      }
      // .exe files: sanitize to 8.3 DOS name before comparing
      const sanitized = sanitizeExeName(name);
      const hit = state.candidateExes.find(
        (f) => f.path.split("/").pop().toUpperCase() === sanitized
      );
      if (hit) setEntry(hit);
    },
    // Fetch a hosted, license-clean app zip and stage it (no user upload).
    stageHostedZip,
    // Boot the engine and run the staged entry EXE. Same path as the Run button.
    run: bootAndRun,
    saveFiles: () => persistWineLayers("manual"),
    // Hand the staged upload to the experimental 64-bit page via the handoff
    // mailbox — used by the preflight banner's x64 link and by embed.js's
    // variant <select> when x64 is picked proactively.
    handoffToX64,
    // Introspection for the embed UI.
    isReady: () => !!state.pickedExe,
    isBooting: () => state.bootInFlight,
  };
  document.dispatchEvent(new Event("exebrowser:ready"));

  log("ExeBrowser ready. Click 'Boot Wine' to begin.");

  // Preload JSZip from the default runtime so the zip-upload path works before
  // Wine boots. JSZip is the same across all our variant runtimes.
  loadScript("/boxedwine/build/default/jszip.min.js").catch((e) => {
    log("Warning: failed to preload JSZip — zip uploads will wait until boot.", "warn");
  });

  // The 32-bit Boxedwine build is single-threaded and never touches
  // SharedArrayBuffer, so no cross-origin-isolation check is needed here.
  // (The experimental /64/ pthreads runtime does need it — its page keeps
  // COOP/COEP headers and ships a coi-serviceworker fallback.)
})();
