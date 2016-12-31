
A highly-experimental, likely-pretty-slow polyfill for WebAssembly
==================================================================

I want to learn about the binary encoding and execution semantics of
WebAssembly, and trying to write a polyfill seemed like as good a way
to do that as any.  I make no promises about this ever being useful
for Real Work.  But it's fun!

In this repository we have:

* `wasm.js`:  the polyfill, the core of which is a hand-written parser for WASM
              that translates it into javascript for execution.

* `spec/`:  the https://github.com/WebAssembly/spec repo as a git submodule,
             to make it easy to run the tests.

* `Makefile`:  provides the following targets for your convenience:

  * `make test`:  run the full WebAssembly spec test suite
  * `make test TESTS=<pattern>`:  run specific tests from the suite


Theory of Operation
-------------------

The polyfill works [1] by parsing the WebAssembly binary format
and translating each function into semantically-equivalent javascript.

For example, given this simple WebAssembly implementation of factorial:

```
(module
  (func (export "fac-rec") (param i64) (result i64)
    (if i64 (i64.eq (get_local 0) (i64.const 0))
      (i64.const 1)
      (i64.mul (get_local 0) (call 0 (i64.sub (get_local 0) (i64.const 1))))
    )
  )
)
```

It will produce a JavaScript function that looks like:

```
function (imports,constants,stdlib) {
  
  //  WebAssembly stdlib and helper functions
  
  const Long = WebAssembly._Long
  const i64_eq = stdlib.i64_eq
  const i64_sub = stdlib.i64_sub
  const i64_mul = stdlib.i64_mul
  
  //  Function definitions
  
  function F0(ll0) {
      var sl0 = Long.ZERO
      var sl1 = Long.ZERO
      var si0 = 0|0
      var sl2 = Long.ZERO
      sl0 = ll0
      sl1 = new Long(0,0)
      si0 = i64_eq((sl0), (sl1))|0
      if (si0) { L1: do {
        sl0 = new Long(1,0)
      } while (0) } else { L1: do{
        sl0 = ll0
        sl1 = ll0
        sl2 = new Long(1,0)
        sl1 = i64_sub((sl1), (sl2))
        sl1 = F0(sl1)
        sl0 = i64_mul((sl0), (sl1))
        sl0 = sl0
      } while (0) }
      return sl0
  }
  F0._wasmTypeSigStr = 'l->l'
  F0._wasmJSWrapper = null
  
  
  //  Exports
  
  var exports = {}
  exports['fac-rec'] = F0
  return exports
}
```

Some things to note:

* The translation produces something that's structured similarly to asm.js,
  e.g. it makes a closure over the function definitions, it uses typed arrays
  for memory, and so-on.  But there are enough semantic differences between
  WASM and asm.js that we don't attempt a direct translation.  It would be
  interesting to make more parts of the output more asm.js-like over time.

* The WASM stack is simulated using local variables.  In the above we have
  "slX" for a long on the stack in position X, and "siX" for an int at
  position X.  This works but generates a lot of unnecessary variable
  shuffling, and there are probably lots of opportunities to elide stack
  variables.

* We simulate 64-bit integers using a `Long` class, to simplify the code
  generation logic.


[1] For sufficiently small values of "works"...


Notes and TODOs
---------------

Things that are awkward/weird/slow:

  * Preserving the specific bit pattern in a NaN appears to be
    quite difficult, particularly for 32-bit floats.  In some
    cases I've had to box them into a `Number` instance with
    additional properties.

  * WASM requires us to trap for various arithmetic operations
    that succeed in JS, so we need to emit code to check for
    the trapping conditions explicitly.

  * WASM requires that out-of-bounds memory accesses trap, so
    the generated code is full of bounds checks.  There's likely
    plenty of scope for doing clever lifting or merging or
    elision of these checks.

  * WASM requires that mis-aligned memory access succeed, so
    the generated code has to check for the expected alignment
    on every load.  I don't have any clever ideas for avoiding
    this, but perhaps it's possible to merge several of these
    checks together in some cases.

Things to do:

  * Enable soft-validation failures, for completeness.

  * Add rollup.js or similar to bundle for the web.
