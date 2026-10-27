# Boxedwine (jit engine)

Built by `scripts/build-boxedwine-jit.sh` from
[https://github.com/danoon2/Boxedwine](https://github.com/danoon2/Boxedwine/tree/8ab37e7b79737467674b40fe0675396b3d90a469) at commit `8ab37e7b79737467674b40fe0675396b3d90a469`,
`make jit` (single-threaded, x86-to-WebAssembly JIT), with emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 6.0.13-git.

Boxedwine is GPL-2.0; the source for these files is that commit.
`boxedwine-shell.js` is upstream's, unmodified: exebrowser's changes to its
behaviour are made from app.js (runUpstreamShell).
