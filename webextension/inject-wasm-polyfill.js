if (typeof browser === 'undefined') {
  var browser = chrome
}
if (typeof window.WebAssembly === 'undefined') {
  var script = document.createElement('script')
  script.src = (browser || chrome).extension.getURL('wasm-polyfill.min.js');
  (document.head || document.documentElement).appendChild(script)
  script.remove()
}
