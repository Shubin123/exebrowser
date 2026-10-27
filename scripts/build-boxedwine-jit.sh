#!/usr/bin/env bash
# Build the "jit" Wine engine in public/boxedwine/build/jit/ from upstream
# Boxedwine at a pinned commit: a CPU core that compiles hot x86 blocks to
# WebAssembly instead of interpreting every instruction.
#
# It boots upstream's own web root, TinyCore15Wine11.0-web.zip (Wine 11,
# served by functions/api/bwfs/), not the default engine's Wine 1.7.55 one.
# This runtime does boot fullWine1.7.55-v8: console programs run, about
# 3.7x faster than the same commit built without the JIT. But several of its
# Wine processes then die on "Unhandled page fault on read access to
# 0xffffffff at address 0xc0dd8382", and no window is ever drawn. The
# interpreter build of the same commit fails the same way, so the JIT is not
# the cause. The fault went away when the boot was slowed down by syscall
# logging, which points at a race. Making the JIT the default engine needs
# that fixed, or the hosted catalogue retested on Wine 11.
#
#   ./scripts/build-boxedwine-jit.sh            # clone into assets-too-big-for-pages/
#   BOXEDWINE_SRC=~/src/Boxedwine ./scripts/build-boxedwine-jit.sh
#
# Needs emcc (built and tested with 6.0.13). The output is small enough to
# commit (~4.6 MB); NOTICE.md records the commit and compiler, which is what
# GPL-2.0 asks of a binary we ship.
#
# The single-threaded "jit" target, not "multiThreadedJit": threads need
# SharedArrayBuffer, which needs COOP/COEP, which this site only sends on
# /64/ because COEP blocks the ad iframes everywhere else (see _headers).

set -euo pipefail

REPO="https://github.com/danoon2/Boxedwine"
COMMIT="8ab37e7b79737467674b40fe0675396b3d90a469"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${BOXEDWINE_SRC:-$ROOT/assets-too-big-for-pages/boxedwine-src}"
OUT="$ROOT/public/boxedwine/build/jit"

command -v emcc >/dev/null || { echo "emcc not found (install emscripten)" >&2; exit 1; }

if [ ! -d "$SRC/.git" ]; then
  git clone --filter=blob:none "$REPO" "$SRC"
fi
git -C "$SRC" cat-file -e "$COMMIT^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet origin
git -C "$SRC" checkout --quiet --detach "$COMMIT"

# The runtime embeds __DATE__; pin it to the commit so rebuilds are byte-stable.
EPOCH="$(git -C "$SRC" log -1 --format=%ct)"
# The jit target's EXPORTED_RUNTIME_METHODS replaces the makefile's base list,
# and emcc 6.0.13 then strips IDBFS as unused although -lidbfs.js is linked.
# The shell mounts IDBFS by name for the per-program save storage, so without
# this the boot dies on "IDBFS is not defined". JIT_CCALL_EXPORTS is the tail
# of the jit target's own list, so overriding it only adds names.
( cd "$SRC/project/emscripten" && SOURCE_DATE_EPOCH="$EPOCH" \
    make jit JIT_CCALL_EXPORTS=,ccall,FS,IDBFS )

mkdir -p "$OUT"
B="$SRC/project/emscripten/Build/Jit"
cp "$B/boxedwine.js" "$B/boxedwine.wasm" "$B/boxedwine-shell.js" "$OUT/"
chmod 644 "$OUT/boxedwine.js" "$OUT/boxedwine.wasm" "$OUT/boxedwine-shell.js"

EMCC="$(emcc --version | head -1)"
cat > "$OUT/NOTICE.md" <<EOF
# Boxedwine (jit engine)

Built by \`scripts/build-boxedwine-jit.sh\` from
[$REPO]($REPO/tree/$COMMIT) at commit \`$COMMIT\`,
\`make jit\` (single-threaded, x86-to-WebAssembly JIT), with $EMCC.

Boxedwine is GPL-2.0; the source for these files is that commit.
\`boxedwine-shell.js\` is upstream's, unmodified: exebrowser's changes to its
behaviour are made from app.js (runUpstreamShell).
EOF

for f in boxedwine.js boxedwine.wasm boxedwine-shell.js; do
  printf "  %-20s %s bytes\n" "$f" "$(wc -c < "$OUT/$f")"
done
