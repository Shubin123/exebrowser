// Pages Function: /api/bwfs/<file> -> one of boxedwine.org's versioned web
// file systems, for the jit engine (app.js WINE_VARIANTS.jit), which reads its
// ~100 MB Wine 11 root by Range request as the emulator asks.
//
// Same job /api/fs/ does for the default engine's root, without the Worker in
// between: boxedwine.org already answers Range requests, and this fetch runs
// server-side, so CORS doesn't apply. Only listed files are proxied, each at a
// pinned version path, so a new upstream release can't change what boots.

const FILES = {
  "TinyCore15Wine11.0-web.zip": "https://boxedwine.org/v2/23/TinyCore15Wine11.0-web.zip",
};

export async function onRequest(context) {
  const { request, params } = context;
  const url = FILES[params.file];
  if (!url) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  for (const name of ["Range", "If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(url, {
    method: request.method,
    headers,
    cf: { cacheTtl: 86400, cacheEverything: true },
  });

  // As in /api/fs/: _headers applies COOP/COEP/CORP uniformly, and a second
  // copy from upstream makes Chrome reject the policy.
  const out = new Headers(upstream.headers);
  for (const name of ["Cross-Origin-Resource-Policy", "Cross-Origin-Embedder-Policy",
    "Cross-Origin-Opener-Policy", "Access-Control-Allow-Origin", "Vary", "Set-Cookie"]) {
    out.delete(name);
  }
  out.set("Cache-Control", "public, max-age=86400");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
