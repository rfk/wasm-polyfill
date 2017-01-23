
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

var SPECDIR = path.resolve(__dirname, '..', 'spec')
var SPECTESTDIR = path.resolve(__dirname, '..', 'spec', 'test', 'core')
var CODEFILE = path.resolve(__dirname, '..', 'wasm-polyfill.min.js')

describe('The WebAssembly polyfill', function() {
  var TEST_FILES = fs.readdirSync(SPECTESTDIR)
  TEST_FILES.forEach((function(filename) {
    if (filename === 'soft-fail.wast') {
      return
    }
    if (path.extname(filename) === '.wast' && filename.indexOf('.fail.') === -1) {
      it('should pass the "' + path.basename(filename) + '" test suite',
        mkSpecTestRunner(filename)
      )
    }
  }).bind(this))
})

function mkSpecTestRunner(filename) {
  return function(done) {
    // Use the spec interpreter to generate JS for the test.
    var testFile = path.join('/tmp', path.basename(filename) + '.js')
    var makeTestFile = ([
       path.join(SPECDIR, 'interpreter', 'wasm'),
       '-d', path.join(SPECTESTDIR, filename),
       '-o', testFile
    ]).join(' ')
    cp.exec(makeTestFile, function(err) {
      if (err) { return done(err) }

      // Fix up some ES6-isms in the generated code,
      // to ensure we can actually run it.
      var testCode = fs.readFileSync(testFile).toString()
      testCode = testCode.replace("print: print || ((...xs) => console.log(...xs))", "print: _print")
      testCode = testCode.replace(
        "function instance(bytes, imports = registry) {",
        "function instance(bytes, imports) {\n" +
        "  if (typeof imports === 'undefined') { imports = registry }"
      )
      testCode = testCode.replace(
        "function module(bytes, valid = true) {",
        "function module(bytes, valid) {\n" +
        "  if (typeof valid === 'undefined') { valid = true }"
      )

      // Add hooks to make it correctly call the polyfill.
      testCode = testCode.replace("soft_validate = true", "soft_validate = false")
      testCode = "'use strict';\n" +
                 "if (typeof require !== 'undefined') {\n" +
                 "  var WebAssembly = require('" + CODEFILE + "')\n" +
                 "} else if (typeof load !== 'undefined') {\n" +
                 "  load('" + CODEFILE + "')\n" +
                 "}\n" +
                 "var _print = function() { print.apply(this, arguments); }\n" +
                 "if (typeof module !== 'undefined') {" +
                 "  _print = function() {\n" +
                 "    for (var i = 0; i < arguments.length; i++) {\n" +
                 "      console.log(arguments[i])\n" +
                 "    }\n" +
                 "  }\n" +
                 "}\n" +
                 testCode
      fs.writeFileSync(testFile, testCode)

      // Run it with a subprocess, capturing output.
      var output = ""
      var js_engine = process.env.JS_ENGINE || 'node'
      var proc = cp.spawn(js_engine, [testFile], { stdio: [process.stdin, 'pipe', process.stderr] })
      proc.stdout.on('data', function(chunk) {
        output += chunk.toString()
      })
      proc.on('exit', function(code, signal) {
        if (code || signal) { return done(code || signal) }
        var expectedOutput = null
        var expectedOutputFile = path.join(SPECTESTDIR, 'expected-output', filename + '.log')
        if (fs.existsSync(expectedOutputFile)) {
          expectedOutput = fs.readFileSync(expectedOutputFile).toString()
        }
        if (! output) {
          if (expectedOutput) {
            return done(new Error('failed to produce expected output'))
          }
        } else {
          if (! expectedOutput) {
            return done(new Error('produced unexpected output'))
          }
          outputLines = output.split("\n").slice(0, -1)
          expectedOutputLines = expectedOutput.split("\n").slice(0, -1)
          if (outputLines.length !== expectedOutputLines.length) {
            return done(new Error('produced incorrect number of output lines'))
          }
          // We don't print the output in the same format as the spec interpreter expects.
          // Each line is a number and a type, so just check that the leading numbers match.
          for (var i = 0; i < outputLines.length; i++) {
            var match = /^[0-9]+/.exec(outputLines[i])
            var expectedMatch = /^[0-9]+/.exec(expectedOutputLines[i])
            if (! match || ! expectedMatch || match[0] !== expectedMatch[0]) {
              return done(new Error('produced incorrect output'))
            }
          }
        }
        fs.unlink(testFile)
        done()
      })
    })

  }
}

