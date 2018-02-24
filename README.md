
Status: Unmaintained
====================

[![No Maintenance Intended](http://unmaintained.tech/badge.svg)](http://unmaintained.tech/)

I am [no longer actively maintaining this project](https://rfk.id.au/blog/entry/archiving-open-source-projects/).


A highly-experimental, likely-pretty-slow polyfill for WebAssembly
==================================================================

I want to learn about the binary encoding and execution semantics of
WebAssembly, and trying to write a polyfill seemed like as good a way
to do that as any.  I make no promises about this ever being useful
for Real Work.  But it's fun!

In this repository we have:

* `src/*.js`: the polyfill, the core of which is a hand-written parser for
              WASM that translates it into javascript for execution.

* `spec/`:  the https://github.com/WebAssembly/spec repo as a git submodule,
            to make it easy to run the tests.

* `tests/`:  a little test harness to run the spec tests using the polyfill.

* `webextension/`:  a small webextension that injects the polyfill into
                    every webpage, so you can pretend that your browser has
                    native WebAssembly support.  It's useful for running
                    third-party content like the AngryBots demo.

* `Makefile`:  provides the following targets for your convenience:

  * `make`:  build a standaline minified polyfill file,
             and corresponding webexenstion bundle.
  * `make test`:  run the full WebAssembly spec test suite
  * `make test JS_ENGINE=/path/to/js`:  run tests with a specific JS engine,
                                        e.g. spidermonkey instead of node.



Current Status
--------------

It works, but it's pretty slow.

When run under node, the polyfill passes the full spec interpreter test
suite.  When run under spidermonkey it passes all but some float-related
tests, and I suspect that's because the tests need to be updated to account
for different handling of NaNs [1].

The code can also load and run the WASM
[AngryBots demo](http://webassembly.org/demo/).
It currently runs so slowly as to be nigh unplayable,
but there's still some low-hanging fruit to improve performance
of the generated JavaScript; see below for some ideas..

[1] https://github.com/WebAssembly/spec/issues/286


How to Use
----------

First, consider whether this highly-experimental code is right for
you.  If you're just looking to compile some code to the web and
have it run, you'll almost certainly be better served by the more
mature WebAssembly support in the emscripten toolchain:

  https://github.com/kripken/emscripten/wiki/WebAssembly

But if you're trying to do something unusual, like JIT to WASM at
runtime in the browser, them a full-blown polyfill may be necessary.

Next, make sure you've built it into a standalone JS file::

```
> make
```

Then you can load it into a webpage like this:

```xml
<script type="text/javascript" src="./wasm-polyfill.min.js"></script>
<script type="text/javascript">
// This uses the browser's builtin WebAssembly if present,
// and the polyfill if not.
var funcs = WebAssembly.instantiate("wasm code here")
</script>
```

Or load it as a module in node:

```javascript
var WebAssembly = require('wasm-polyfill.min.js')
var funcs = WebAssembly.instantiate("wasm code here")
```

Or if you're feel really adventurous, you can load
`./webextension/manifest.json` as a WebExtension
in [Firefox](https://developer.mozilla.org/en-US/Add-ons/WebExtensions/Temporary_Installation_in_Firefox)
or [Chrome](https://developer.chrome.com/extensions/getstarted#unpacked)
and have it available on all webpages.

I've used this trick to successfully load and run the
[AngryBots demo](http://webassembly.org/demo/), albeit slowly.


Theory of Operation
-------------------

The polyfill works by parsing the WebAssembly binary format and
translating each function into semantically-equivalent javascript.
The translation process prioritizes the following, in order:

1. The generated code must be *semantically correct*, even for various
   edge-cases where the semantics of WASM do not map cleanly onto the
   semantics of JavaScript.

2. The generated code should *run fast*.  We try to generate as close
   to valid asmjs as possible, and will spend CPU cycles during translation
   if they result in significantly improved code (such as eliminating
   lots of bounds checks).

3. The code generation should be done quickly, since we're running on the
   client.  This means we won't try to do a lot of micro-optimization of
   the generated code.

So far it does a good job of (1), but there's a lot of work remaining
on (2), and I haven't looked into (3) much at all.  But hey, it's early
days for this code! :-)

As a concrete example, given this simple WebAssembly implementation of a
32-bit factorial function:

```lisp
(module
  (func (export "fac-rec") (param i64) (result i64)
    (if i64 (i64.eq (get_local 0) (i64.const 0))
      (i64.const 1)
      (i64.mul (get_local 0) (call 0 (i64.sub (get_local 0) (i64.const 1))))
    )
  )
)
```

The polyfill will produce a JavaScript function that looks like:

```javascript
function (WebAssembly, asmlib, imports) {
  
  // Create and annotate the exported functions.
  var funcs = asmfuncs(asmlib, imports)

  funcs.F0._wasmTypeSigStr = 'i_i'
  funcs.F0._wasmJSWrapper = null

  var exports = {}
  exports['fac-rec'] = funcs.F0

  // An inner asmjs-style function containing all the code.
  // In this case we're able to generate valid asmjs, but
  // that's not always the case in general.

  function asmfuncs(stdlib, foreign, heap) {
    "use asm"

    var i32_mul = foreign.i32_mul 

    function F0(li0) {
      li0 = li0|0
      var ti0 = 0
      var ti1 = 0
      var ti2 = 0
      if ((((li0)|0)==((0)|0))|0) { L1: do {
        ti0 = (1)|0
      } while(0)} else { L1: do {
        ti1 = (li0)|0
        ti2 = (F0((((li0)|0)-((1)|0))|0))|0
        ti0 = (i32_mul((ti1)|0,(ti2)|0))|0
      } while(0) }
      return ti0
    }

    return {
      F0: F0
    }
  }

  // If there were initializers to run, they'd go here.

  return exports
}
```

For this simple function, we're able to generate something that's
valid asmjs and should run pretty fast.  That's not always the case
in general.  Some of the tricky parts, where WASM differs from asmjs
and makes a direct translation difficult, include:

* WASM has growable memory, while this feature was not successfully
  added to the asmjs spec.  In the general case we use a similar approach
  to emscripten's `ALLOW_MEMORY_GROWTH` option, with a callback that
  triggers us to take fresh references to the memory.

  However, if the WASM module declares a fixed memory size, we know
  that memory growth is not possible and can generate valid asmjs.

* WASM has native 64-bit integers, javascript does not.  For now
  we're just using a third-party `Long` class to handle them, which
  is likely pretty slow but gives the correct semantics.

  In the future it might be interesting to try to decompose them into
  pairs of 32-bit values, but that would significantly complicate the
  code generation logic.

* WASM requires that out-of-bounds memory accesses trap, while javascript
  allows them to succeed and return zero.  In the general case we have
  to emit bounds-checks before each memory access.

  I'm working towards doing some primitive range analysis to omit duplicate
  bounds checks, but it's not complete yet.

* WASM requires that mis-aligned memory accesses succeed, while asmjs will just
  read at the nearest aligned address.  In the general case we have to check
  alignment before each memory access and call out to a helper function if
  it's incorrect.

  I don't have a good idea for reducing the overhead of this check in practice;
  it would be nice if the mis-aligned access were allowed to trap rather than
  succeeding.

* WASM requires that memory be little-endian, but TypedArrays reflect the
  the endianness of the underlying platform.  We feature-detect endianness and
  fall back to doing unaligned reads via a DataView on big-endian platforms.

* WASM defines precise semantics for the bit patterns inside a NaN, and
  requires that e.g. abs() and neg() preserve them.  By contrast, JavaScript
  engines are allowed to ruthlessly canonicalize NaNs and many of them do.

  In the general case we work around this by boxing NaNs into `new Number()`
  instances, and attaching the precise bit-pattern as a property.  But we
  can avoid this overhead when it's possible to prove that the bit pattern
  will never be observed (e.g. because it's immediately passed to an operator
  that's allowed to canonicalize it).

* WASM function pointers share a single, mutable tablespace, so we currently
  do a bunch of runtime type checks when they're being invoked.  It's likely
  worth trying to internally segregate them by type signature in the same way
  that asmjs does, but I haven't yet tried to do so.

