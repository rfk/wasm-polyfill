

import translate from "./translate"
import { dump, filename } from "./utils"

//
// Synchronously compile the given WASM bytes
// into runnable javascript.  This will likely
// block the JS event loop for a significant
// amount of time, so you should prefer to use
// the `compileAsync` function below.
//
export function compileSync(bufferSource) {
  var bytes = new Uint8Array(arrayBufferFromBufferSource(bufferSource))
  var r = translate(bytes)
  //dump((new Buffer(r.bytes)).toString())
  r.jsmodule = loadSync(r.bytes)
  return r
}

function loadSync(jsBytes) {
  var codeStr = "return "
  // Use TextDecoder if available in the browser,
  // use Buffer when we're in nodejs,
  // and fall back to a big ol' loop when in doubt.
  if (typeof TextDecoder !== "undefined") {
    codeStr += (new TextDecoder("utf-8").decode(jsBytes))
  } else if (typeof Buffer !== "undefined") {
    codeStr += (new Buffer(jsBytes)).toString()
  } else {
    for (var i = 0; i < jsBytes.length; i++) {
      codeStr += String.fromCharCode(jsBytes[i])
    }
  }
  return new Function(codeStr)()
}

//
// Asynchronously compile the given WASM bytes
// into runnable javascript.  This tries to launch
// a Worker to perform the translation, and to use
// the DOM to evaluabe the JS asynchronously.
// It will fall back to a synchronous implementation
// if either of the above fails.
//

var asyncCompileCounter = 0

export function compileAsync(bufferSource) {
  var canUseWorker =
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof Blob !== "undefined" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL && "undefined";
  // If Workers are not available, fall back to synchronous.
  // Note that we must compile bytes as they are when the
  // function is called, meaning we must do it before
  // yielding the event loop.
  if (! canUseWorker) {
    try {
      return Promise.resolve(compileSync(bufferSource))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  // Looks like we can compile in a worker.
  // We use an inline script to keep things self-contained.
  try {
    var bytes = new Uint8Array(arrayBufferFromBufferSource(bufferSource))
    var resolve, reject
    var p = new Promise(function(rslv, rjct) {
       resolve = rslv
       reject = rjct
    })
    var workerSrc = new Blob([
      "importScripts('" + filename() + "')\n",
      "\n" +
      "onmessage = function(e) {\n" +
      "  var bytes = e.data.bytes\n" +
      "  try {\n" +
      "    var r = WebAssembly._translate(bytes)\n" +
      "    // Non-copying transfer of buffer back to main code.\n" +
      "    postMessage({ result: r }, [r.buffer])\n" +
      "  } catch (err) {\n" +
      "    postMessage({ error: err })\n" +
      "  }\n" +
      "}"
    ])
    var workerURL = URL.createObjectURL(workerSrc)
    var worker = new Worker(workerURL)
    worker.onerror = function (err) {
      URL.revokeObjectURL(workerURL)
      reject(err)
    }
    worker.onmessage = function(evt) {
      worker.terminate()
      URL.revokeObjectURL(workerURL)
      if (evt.data.error) {
        reject(evt.data.error)
      } else {
        resolve(evt.data.result)
      }
    }
    // This copies the bytes into the worker.
    // It's important to do this before yielding the event loop,
    // because calling code is free to mutate the bytes after
    // this function returns.
    worker.postMessage({ bytes: bytes })
    return p.then(function(r) {
      // Now, can we load the JS asynchronously as well?
      // This may not be possible if we're e.g. running inside
      // one Worker and offloading translation to another.
      var canUseScriptTag =
        typeof document !== "undefined" &&
        typeof document.createElement !== "undefined" &&
        typeof document.body !== "undefined" &&
        typeof document.body.appendChild !== "undefined";
      if (! canUseScriptTag) {
        r.jsmodule = loadSync(r.bytes)
        return r
      }
      // Yes! Create a <script> tag with the compiled JS
      // and use a callback to let us know when it's loaded.
      return new Promise(function(resolve, reject) {
        var callbackName
        do {
          callbackName = "_onFinishCompileWASM_" + asyncCompileCounter++
        } while (window.hasOwnProperty(callbackName))
        var scriptSrc = new Blob([
          "window." + callbackName + "(",
          r.bytes,
          ")"
        ])
        var scriptURL = URL.createObjectURL(scriptSrc)
        var scriptTag = document.createElement('script')
        var cleanup = function cleanup() {
          delete window[callbackName]
          scriptTag.remove()
          URL.revokeObjectURL(scriptURL)
        }
        scriptTag.onerror = function (err) {
          cleanup()
          reject(err)
        }
        window[callbackName] = function(jsmodule) {
          cleanup()
          r.jsmodule = jsmodule
          resolve(r)
        }
        scriptTag.src = scriptURL
        document.body.appendChild(scriptTag)
      })
    })
  } catch (err) {
    return Promise.reject(err)
  }
}


function arrayBufferFromBufferSource(source) {
  if (source instanceof ArrayBuffer) {
    return source
  }
  const viewClasses = [
    Int8Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Uint8ClampedArray,
    Float32Array,
    Float64Array,
    DataView
  ]
  for (var i = 0; i < viewClasses.length; i++) {
    if (source instanceof viewClasses[i]) {
      return source.buffer
    }
  }
  return null
}
