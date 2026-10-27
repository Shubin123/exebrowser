# Ren'Py 8.5.3 (web runtime)

`renpy.js`, `renpy.wasm`, `renpy.data` and `renpy-pre.js` are Ren'Py's web
platform files, unchanged, from
[renpy-8.5.3-web.zip](https://www.renpy.org/dl/8.5.3/renpy-8.5.3-web.zip)
(sha256 `954db897e65f51ea63cb2fb7b203d02be0447f4e22069514020bbe6c6691fdfc`,
as published in renpy.org's `checksums.txt`). `scripts/build-renpy-web.mjs`
fetches them. `index.html` is Ren'Py's web `index.html` with the manifest,
icons and service worker removed, and with `game.zip` taken from the loader
that opens it.

Most of Ren'Py is under the MIT license. Its binaries include code under
other licenses, some of it the GNU LGPL; see
[Ren'Py's license page](https://www.renpy.org/doc/html/license.html). The
source for these files is
[renpy-8.5.3-source.tar.bz2](https://www.renpy.org/dl/8.5.3/renpy-8.5.3-source.tar.bz2),
built with [renpy-build](https://github.com/renpy/renpy-build).

No game ships here: the loader runs the game the visitor picks, from their
own disk.
