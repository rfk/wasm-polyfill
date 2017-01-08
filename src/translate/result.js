//
// A helper class for accumulating the output of a translation.
//

import { CompileError } from "../errors"

export default function TranslationResult(bufferSize) {
  this.buffer = new ArrayBuffer(bufferSize)
  this.bytes = new Uint8Array(this.buffer)
  this.idx = 0
  this.lastSection = 0
  this.types = []
  this.imports = []
  this.exports = []
  this.functions = []
  this.globals = []
  this.tables = []
  this.memories = []
  this.elements = []
  this.datas = []
  this.start = null
  this.numImportedFunctions = 0
  this.numImportedGlobals = 0
  this.numExportedFunctions = 0
  this.numExportedGlobals = 0
  this.numExportedTables = 0
  this.numExportedMemories = 0
  this.hasRenderedOuterJSHeader = false
  this.hasRenderedOuterJSFooter = false
  this.hasRenderedAsmFuncCreation = false
  this.hasRenderedAsmFuncHeader = false
  this.hasRenderedAsmFuncFooter = false
}

TranslationResult.prototype.putc = function putc(c) {
  if (this.idx >= this.buffer.byteLength) {
    var newSize = this.buffer.byteLength * 2
    var newBuffer = new ArrayBuffer(newSize)
    var newBytes = new Uint8Array(newBuffer)
    newBytes.set(this.bytes)
    this.buffer = newBuffer
    this.bytes = newBytes
  } 
  this.bytes[this.idx++] = c
}

TranslationResult.prototype.putstr = function putstr(s) {
  //s = s.trim()
  for (var i = 0; i < s.length; i++) {
    this.putc(s.charCodeAt(i))
  }
}

TranslationResult.prototype.putln = function putln() {
  this.putstr(Array.from(arguments).join(""))
  this.putc('\n'.charCodeAt(0))
}

TranslationResult.prototype.finalize = function finalize() {
  this.bytes = this.bytes.subarray(0, this.idx)
}

TranslationResult.prototype.getGlobalTypeByIndex = function(index) {
  if (index >= this.globals.length) {
    throw new CompileError("no such global: " + index)
  }
  return this.globals[index].type.content_type
}

TranslationResult.prototype.getGlobalMutabilityByIndex = function(index) {
  if (index >= this.globals.length) {
    throw new CompileError("no such global: " + index)
  }
  return this.globals[index].type.mutability
}

TranslationResult.prototype.getTableTypeByIndex = function(index) {
  if (index >= this.tables.length) {
    throw new CompileError("no such table: " + index)
  }
  return this.tables[index]
}

TranslationResult.prototype.getMemoryTypeByIndex = function(index) {
  if (index >= this.memories.length) {
    throw new CompileError("no such memory: " + index)
  }
  return this.memories[index]
}

TranslationResult.prototype.getFunctionTypeSignatureByIndex = function(index) {
  if (index >= this.functions.length) {
    throw new CompileError("Invalid function index: " + index)
  }
  return this.getTypeSignatureByIndex(this.functions[index].type)
}

TranslationResult.prototype.getTypeSignatureByIndex = function(index) {
  if (index >= this.types.length) {
    throw new CompileError("Invalid type index: " + index)
  }
  return this.types[index]
}
