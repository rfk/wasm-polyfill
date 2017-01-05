//
// Ahead-of-time translate a .wasm file to JS.
// The JS can't run by itself without all of the
// other runtime support stuff provided by this
// module, but it's handy for testing/debugging.
// 
// Usage:  node ./bin/translate.js filename.wasm
//


fs = require('fs')
var WebAssembly = require('../wasm-polyfill.min.js')

var buf = fs.readFileSync(process.argv[2])
var data = new Uint8Array(buf)
var r = WebAssembly._translate(data)

process.stdout.write(new Buffer(r.bytes))
