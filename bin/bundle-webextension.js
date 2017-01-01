
fs = require("fs")
var src = fs.readFileSync("wasm-polyfill.min.js")
fs.writeFileSync("webextension/inject-wasm-polyfill.js",
  "var src = '" + src.toString("base64") + "'\n" +
  "\n" +
  "if (typeof window.wrappedJSObject.WebAssembly === 'undefined') {\n" +
  "  window.wrappedJSObject.eval(atob(src))\n" +
  "}"
)

