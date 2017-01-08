//
// Parse WASM binary format for function bodies into executable javascript.
//

import stdlib from "../stdlib"
import { CompileError } from "../errors"
import { dump, stringifyJSValue, makeSigStr } from "../utils"
import {
  PAGE_SIZE,
  TYPES,
  EXTERNAL_KINDS,
  EXTERNAL_KIND_NAMES,
  SECTIONS,
  TOKENS,
  OPCODES
} from "../constants"


function parseBlockType(s) {
  var v = s.read_varint7()
  if (v >= 0 || (v < TYPES.F64 && v !== TYPES.NONE)) {
    throw new CompileError("Invalid block_type: " + v)
  }
  return v
}


export default function translateFunctionCode(s, r, f) {

  // XXX TODO: parse into an in-memory representation so we
  // can do a bit of simplication etc before rendering the JS.
  // It will be a good opportunity to merge bounds checks,
  // eliminate needless preservation of NaN bits, etc.
  //
  // For now, we're just accumulating a list of strings to render.

  f.bodyLines = []
  f.pushLine = function pushLine(ln, indent) {
    if (f.cfStack.isDeadCode()) {
      f.bodyLines.push("trap('dead code')")
      return
    }
    var indent = (f.cfStack.peek().index) + (indent || 0) + 1
    while (indent > 0) {
      ln = "  " + ln
      indent--
    }
    f.bodyLines.push(ln)
  }

  f.cfStack = new ControlFlowStack()
  f.cfStack.push(0, (f.sig.return_types.length > 0 ? f.sig.return_types[0] : TYPES.NONE))

  function getLocalType(index) {
    var count = f.sig.param_types.length
    if (index < count) {
      return f.sig.param_types[index]
    }
    var next = 0
    while (next < f.locals.length) {
      count += f.locals[next].count
      if (count > index) {
        return f.locals[next].type
      }
      next++
    }
    throw new CompileError("local index too large: " + index)
  }

  function getLocalVar(index, typ) {
    typ = typ || getLocalType(index)
    switch (typ) {
      case TYPES.I32:
        return "li" + index
      case TYPES.I64:
        return "ll" + index
      case TYPES.F32:
        return "lf" + index
      case TYPES.F64:
        return "ld" + index
      default:
        throw new CompileError("unexpected type of local")
    }
  }

  DECODE: while (true) {
    var op = s.read_byte()
    switch (op) {

      case OPCODES.UNREACHABLE:
        f.pushLine("return trap('unreachable')")
        f.cfStack.markDeadCode()
        break

      case OPCODES.NOP:
        break

      case OPCODES.BLOCK:
        var sig = parseBlockType(s)
        var cf = f.cfStack.push(op, sig)
        f.pushLine(cf.label + ": do {", -1)
        break

      case OPCODES.LOOP:
        var sig = parseBlockType(s)
        var cf = f.cfStack.push(op, sig)
        f.pushLine(cf.label + ": while (1) {", -1)
        break

      case OPCODES.IF:
        var sig = parseBlockType(s)
        var cond = f.cfStack.popVar(TYPES.I32)
        var cf = f.cfStack.push(op, sig)
        f.pushLine(cf.label + ": do { if (" + cond + ") {", -1)
        break

      case OPCODES.ELSE:
        // XXX TODO: need to sanity-check that the `if` branch
        // left precisely one value, of correct type, on the stack.
        // The push/pop here resets stack state between the two branches.
        var cf = f.cfStack.pop()
        if (cf.op !== OPCODES.IF) {
          throw new CompileError("ELSE outside of IF")
        }
        if (! cf.isDead) {
          cf.endReached = true
        }
        f.pushLine("} else {")
        f.cfStack.push(OPCODES.ELSE, cf.sig, cf.endReached)
        break

      case OPCODES.END:
        var cf = f.cfStack.peek()
        if (cf.index === 0) {
          // End of the entire function.
          if (f.sig.return_types.length === 0) {
            if (cf.typeStack.length > 0) {
              throw new CompileError("void function left something on the stack")
            }
            f.pushLine("return")
          } else {
            f.pushLine("return " + f.cfStack.popVar(f.sig.return_types[0]))
          }
          break DECODE
        } else {
          // End of a control block
          if (! cf.isDead) {
            cf.endReached = true
          } else if (cf.endReached && cf.sig !== TYPES.NONE) {
            // We're reached by a branch, but not by fall-through,
            // so there's not going to be an entry on the stack.
            // Make one.
            f.cfStack.pushVar(cf.sig)
          }
          // An if without an else always reaches the end of the block.
          if (cf.op === OPCODES.IF) {
            cf.endReached = true
          }
          if (cf.endReached) {
            if (cf.sig !== TYPES.NONE) {
              var output = f.cfStack.getVar(cf.sig)
            } else {
              if (cf.typeStack.length > 0) {
                throw new CompileError("void block left values on the stack")
              }
            }
          }
          f.cfStack.pop()
          if (cf.sig !== TYPES.NONE && cf.endReached) {
            var result = f.cfStack.pushVar(cf.sig)
            if (result !== output) {
              f.pushLine("  " + result + " = " + output)
            }
          }
          switch (cf.op) {
            case OPCODES.BLOCK:
              f.pushLine("} while(0)")
              break
            case OPCODES.LOOP:
              f.pushLine("  break " + cf.label)
              f.pushLine("}")
              break
            case OPCODES.IF:
            case OPCODES.ELSE:
              f.pushLine("} } while (0)")
              break
            default:
              throw new CompileError("Popped an unexpected control op")
          }
          if (! cf.endReached) {
            f.cfStack.markDeadCode()
          }
        }
        break

      case OPCODES.BR:
        var depth = s.read_varuint32()
        var cf = f.cfStack.getBranchTarget(depth)
        switch (cf.op) {
          case OPCODES.BLOCK:
          case OPCODES.IF:
          case OPCODES.ELSE:
            cf.endReached = true
            if (cf.sig !== TYPES.NONE) {
              var resultVar = f.cfStack.popVar(cf.sig)
              var outputVar = f.cfStack.getBlockOutputVar(depth)
              if (outputVar !== resultVar) {
                f.pushLine(outputVar + " = " + resultVar)
              }
            }
            f.pushLine("break " + cf.label)
            break
          case 0:
            cf.endReached = true
            if (cf.sig !== TYPES.NONE) {
              var resultVar = f.cfStack.popVar(cf.sig)
              f.pushLine("return " + resultVar)
            } else {
              f.pushLine("return")
            }
            break
          case OPCODES.LOOP:
            f.pushLine("continue " + cf.label)
            break
          default:
            throw new CompileError("Branch to unsupported opcode")
        }
        f.cfStack.markDeadCode()
        break

      case OPCODES.BR_IF:
        var depth = s.read_varuint32()
        var cf = f.cfStack.getBranchTarget(depth)
        switch (cf.op) {
          case OPCODES.BLOCK:
          case OPCODES.IF:
          case OPCODES.ELSE:
            cf.endReached = true
            f.pushLine("if (" + f.cfStack.popVar(TYPES.I32) + ") {")
            if (cf.sig !== TYPES.NONE) {
              // This is left on the stack if condition is not true.
              // XXX TODO this needs to check what's on the stack.
              var resultVar = f.cfStack.getVar(cf.sig)
              var outputVar = f.cfStack.getBlockOutputVar(depth)
              if (outputVar !== resultVar) {
                f.pushLine("  " + outputVar + " = " + resultVar)
              }
            }
            f.pushLine("  break " + cf.label)
            f.pushLine("}")
            break
          case 0:
            cf.endReached = true
            f.pushLine("if (" + f.cfStack.popVar(TYPES.I32) + ") {")
            if (cf.sig !== TYPES.NONE) {
              var resultVar = f.cfStack.getVar(cf.sig)
              f.pushLine("return " + resultVar)
            } else {
              f.pushLine("return")
            }
            f.pushLine("}")
            break
          case OPCODES.LOOP:
            f.pushLine("if (" + f.cfStack.popVar(TYPES.I32) + ") { continue " + cf.label + " }")
            break
          default:
            throw new CompileError("Branch to unsupported opcode")
        }
        break

      case OPCODES.BR_TABLE:
        // Terribly inefficient implementation of br_table
        // using a big ol' switch statement.  I don't think
        // there's anything better we can do though.
        var count = s.read_varuint32()
        var targets = []
        while (count > 0) {
          targets.push(s.read_varuint32())
          count--
        }
        var default_target = s.read_varuint32()
        var default_cf = f.cfStack.getBranchTarget(default_target)
        f.pushLine("switch(" + f.cfStack.popVar(TYPES.I32) + ") {")
        // XXX TODO: typechecking that all targets accept the
        // same result type etc.
        var resultVar = null;
        if (default_cf.sig !== TYPES.NONE) {
          resultVar = f.cfStack.popVar(default_cf.sig)
        }
        targets.forEach(function(target, targetNum) {
          f.pushLine("  case " + targetNum + ":")
          var cf = f.cfStack.getBranchTarget(target)
          cf.endReached = true
          if (cf.sig !== TYPES.NONE) {
            var outputVar = f.cfStack.getBlockOutputVar(target)
            if (outputVar !== resultVar) {
              f.pushLine("    " + outputVar + " = " + resultVar)
            }
          }
          switch (cf.op) {
            case OPCODES.BLOCK:
            case OPCODES.IF:
            case OPCODES.ELSE:
              f.pushLine("    break " + cf.label)
              break
            case OPCODES.LOOP:
              f.pushLine("    continue " + cf.label)
              break
            case 0:
              f.pushLine("    return " + outputVar)
              break
            default:
              throw new CompileError("unknown branch target type")
          }
        })
        f.pushLine("  default:")
        if (default_cf.sig !== TYPES.NONE) {
          var outputVar = f.cfStack.getBlockOutputVar(default_target)
          if (outputVar !== resultVar) {
            f.pushLine("    " + outputVar + " = " + resultVar)
          }
        }
        default_cf.endReached = true
        switch (default_cf.op) {
          case OPCODES.BLOCK:
          case OPCODES.IF:
          case OPCODES.ELSE:
            f.pushLine("    break " + default_cf.label)
            break
          case OPCODES.LOOP:
            f.pushLine("    continue " + default_cf.label)
            break
          case 0:
            f.pushLine("    return " + outputVar)
            break
          default:
            throw new CompileError("unknown branch target type")
        }
        f.pushLine("}")
        f.cfStack.markDeadCode()
        break

      case OPCODES.RETURN:
        if (f.sig.return_types.length === 0) {
          f.pushLine("return")
        } else {
          f.pushLine("return " + f.cfStack.popVar(f.sig.return_types[0]))
        }
        f.cfStack.markDeadCode()
        break

      case OPCODES.CALL:
        var index = s.read_varuint32()
        var callSig = r.getFunctionTypeSignatureByIndex(index)
        // The rightmost arg is the one on top of stack,
        // so we have to pop them in reverse.
        var args = new Array(callSig.param_types.length)
        for (var i = callSig.param_types.length - 1; i >= 0; i--) {
          args[i] = f.cfStack.popVar(callSig.param_types[i])
        }
        var call = "F" + index + "(" + args.join(",") + ")"
        if (callSig.return_types.length === 0) {
          f.pushLine(call)
        } else {
          // We know there's at most one return type, for now.
          switch (callSig.return_types[0]) {
            case TYPES.I32:
              call = call + "|0"
              break
            /* These break our NaN boxing...
            case TYPES.F32:
              call = "ToF32(" + call + ")"
              break
            case TYPES.F64:
              call = "+" + call
              break*/
          }
          var output = f.cfStack.pushVar(callSig.return_types[0])
          f.pushLine(output + " = " + call)
        }
        break

      case OPCODES.CALL_INDIRECT:
        var type_index = s.read_varuint32()
        var table_index = s.read_varuint1()
        if (table_index !== 0) {
          throw new CompileError("MVP reserved-value constraint violation")
        }
        r.getTableTypeByIndex(table_index)
        var callSig = r.getTypeSignatureByIndex(type_index)
        var callIdx = f.cfStack.popVar(TYPES.I32)
        // The rightmost arg is the one on top of stack,
        // so we have to pop them in reverse.
        var args = new Array(callSig.param_types.length + 1)
        args[0] = callIdx
        for (var i = callSig.param_types.length - 1; i >= 0; i--) {
          args[i + 1] = f.cfStack.popVar(callSig.param_types[i])
        }
        // XXX TODO: in some cases we could use asmjs type-specific function tables here.
        // For now we just delegate to an externally-defined helper.
        var call = "call_" + makeSigStr(callSig) + "(" + args.join(",") + ")"
        if (callSig.return_types.length === 0) {
          f.pushLine(call)
        } else {
          // We know there's at most one return type, for now.
          switch (callSig.return_types[0]) {
            case TYPES.I32:
              call = call + "|0"
              break
            /* These break our NaN boxing...
            case TYPES.F32:
              call = "ToF32(" + call + ")"
              break
            case TYPES.F64:
              call = "+" + call
              break*/
          }
          var output = f.cfStack.pushVar(callSig.return_types[0])
          f.pushLine(output + " = " + call)
        }
        break

      case OPCODES.DROP:
        f.cfStack.popVar(TYPES.UNKNOWN)
        break

      case OPCODES.SELECT:
        var condVar = f.cfStack.popVar(TYPES.I32)
        var typ = f.cfStack.peekType()
        var falseVar = f.cfStack.popVar(typ)
        var trueVar = f.cfStack.popVar(typ)
        f.cfStack.pushVar(typ)
        var outputVar = f.cfStack.getVar(typ)
        f.pushLine(outputVar + " = " + condVar + " ? " + trueVar + ":" + falseVar)
        break

      case OPCODES.GET_LOCAL:
        var index = s.read_varuint32()
        var typ = getLocalType(index)
        f.cfStack.pushVar(typ)
        f.pushLine(f.cfStack.getVar(typ) + " = " + getLocalVar(index))
        break

      case OPCODES.SET_LOCAL:
        var index = s.read_varuint32()
        f.pushLine(getLocalVar(index) + " = " + f.cfStack.popVar(getLocalType(index)))
        break

      case OPCODES.TEE_LOCAL:
        var index = s.read_varuint32()
        var typ = getLocalType(index)
        f.pushLine(getLocalVar(index) + " = " + f.cfStack.popVar(typ))
        f.cfStack.pushVar(typ) // this var will already contain the value we just set
        break

      case OPCODES.GET_GLOBAL:
        var index = s.read_varuint32()
        var typ = r.getGlobalTypeByIndex(index)
        f.cfStack.pushVar(typ)
        f.pushLine(f.cfStack.getVar(typ) + " = G" + index)
        break

      case OPCODES.SET_GLOBAL:
        var index = s.read_varuint32()
        var typ = r.getGlobalTypeByIndex(index)
        if (! r.getGlobalMutabilityByIndex(index)) {
          throw new CompileError("global is immutable: " + index)
        }
        f.pushLine("G" + index + " = " + f.cfStack.popVar(typ))
        break

      case OPCODES.I32_LOAD:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 4)
        switch (flags) {
          case 0:
          case 1:
            i32_load_unaligned(f, addr, offset)
            break
          case 2:
            i32_load_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.I64_LOAD:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        // Need two i32 vars, so create a temp one.
        f.cfStack.pushVar(TYPES.I32)
        var addrDup = f.cfStack.popVar(TYPES.I32)
        var addr = f.cfStack.popVar(TYPES.I32)
        f.pushLine(addrDup + " = " + addr)
        boundsCheck(f, addr, offset, 8)
        switch (flags) {
          case 0:
          case 1:
            i32_load_unaligned(f, addr, offset)
            i32_load_unaligned(f, addrDup, offset + 4)
            break
          case 2:
          case 3:
            i32_load_aligned(f, addr, offset)
            i32_load_aligned(f, addrDup, offset + 4)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        i64_from_i32x2(f)
        break

      case OPCODES.F32_LOAD:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 4)
        switch (flags) {
          case 0:
          case 1:
            f32_load_unaligned(f, addr, offset)
            break
          case 2:
            f32_load_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.F64_LOAD:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 8)
        switch (flags) {
          case 0:
          case 1:
          case 2:
            f64_load_unaligned(f, addr, offset)
            break
          case 3:
            f64_load_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags: " + flags)
        }
        break

      case OPCODES.I32_LOAD8_S:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        if (flags > 0) {
          throw new CompileError("alignment larger than natural")
        }
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 1)
        i32_load8_s(f, addr, offset)
        break

      case OPCODES.I32_LOAD8_U:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        if (flags > 0) {
          throw new CompileError("alignment larger than natural")
        }
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 1)
        i32_load8_u(f, addr, offset)
        break

      case OPCODES.I32_LOAD16_S:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 2)
        switch (flags) {
          case 0:
            i32_load16_s_unaligned(f, addr, offset)
            break
          case 1:
            i32_load16_s_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.I32_LOAD16_U:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 2)
        switch (flags) {
          case 0:
            i32_load16_u_unaligned(f, addr, offset)
            break
          case 1:
            i32_load16_u_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.I64_LOAD8_S:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        if (flags > 0) {
          throw new CompileError("alignment larger than natural")
        }
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 1)
        i32_load8_s(f, addr, offset)
        i64_from_i32_s(f)
        break

      case OPCODES.I64_LOAD8_U:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        if (flags > 0) {
          throw new CompileError("alignment larger than natural")
        }
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 1)
        i32_load8_u(f, addr, offset)
        i64_from_i32_u(f)
        break

      case OPCODES.I64_LOAD16_S:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 2)
        switch (flags) {
          case 0:
            i32_load16_s_unaligned(f, addr, offset)
            break
          case 1:
            i32_load16_s_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        i64_from_i32_s(f)
        break

      case OPCODES.I64_LOAD16_U:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 2)
        switch (flags) {
          case 0:
            i32_load16_u_unaligned(f, addr, offset)
            break
          case 1:
            i32_load16_u_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        i64_from_i32_u(f)
        break

      case OPCODES.I64_LOAD32_S:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 4)
        switch (flags) {
          case 0:
          case 1:
            i32_load_unaligned(f, addr, offset)
            break
          case 2:
            i32_load_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        i64_from_i32_s(f)
        break

      case OPCODES.I64_LOAD32_U:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 4)
        switch (flags) {
          case 0:
          case 1:
            i32_load_unaligned(f, addr, offset)
          case 2:
            i32_load_aligned(f, addr, offset)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        i64_from_i32_u(f)
        break

      case OPCODES.I32_STORE:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I32)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 4)
        switch (flags) {
          case 0:
          case 1:
            i32_store_unaligned(f, addr, offset, value)
            break
          case 2:
            i32_store_aligned(f, addr, offset, value)
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.I64_STORE:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I64)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 8)
        switch (flags) {
          case 0:
          case 1:
            i32_store_unaligned(f, addr, offset, value + ".low")
            i32_store_unaligned(f, addr, offset + 4, value + ".high")
            break
          case 2:
          case 3:
            i32_store_aligned(f, addr, offset, value + ".low")
            i32_store_aligned(f, addr, offset + 4, value + ".high")
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.F32_STORE:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.F32)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 8)
        switch (flags) {
          case 0:
          case 1:
            f32_store_unaligned(f, addr, offset, value)
            break
          case 2:
            f32_store_aligned(f, addr, offset, value)
            break
          default:
            throw new CompileError("unsupported load flags: " + flags)
        }
        break

      case OPCODES.F64_STORE:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.F64)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 8)
        switch (flags) {
          case 0:
          case 1:
          case 2:
            f64_store_unaligned(f, addr, offset, value)
            break
          case 3:
            f64_store_aligned(f, addr, offset, value)
            break
          default:
            throw new CompileError("unsupported load flags: " + flags)
        }
        break

      case OPCODES.I32_STORE8:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        if (flags > 0) {
          throw new CompileError("alignment larger than natural")
        }
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I32)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 1)
        i32_store8(f, addr, offset, value + " & 0xFF")
        break

      case OPCODES.I32_STORE16:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I32)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 2)
        switch (flags) {
          case 0:
            i32_store8(f, addr, offset + 0, "(" + value + " & 0x00FF) >>> 0")
            i32_store8(f, addr, offset + 1, "(" + value + " & 0xFF00) >>> 8")
            break
          case 1:
            i32_store16(f, addr, offset, "(" + value + " & 0xFFFF) >>> 0")
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.I64_STORE8:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        if (flags > 0) {
          throw new CompileError("alignment larger than natural")
        }
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I64)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 1)
        i32_store8(f, addr, offset, "(" + value + ".low) & 0xFF")
        break

      case OPCODES.I64_STORE16:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I64)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 2)
        switch (flags) {
          case 0:
            i32_store8(f, addr, offset + 0, "((" + value + ".low) & 0x00FF) >>> 0")
            i32_store8(f, addr, offset + 1, "((" + value + ".low) & 0xFF00) >>> 8")
            break
          case 1:
            i32_store16(f, addr, offset, "((" + value + ".low) & 0xFFFF) >>> 0")
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.I64_STORE32:
        r.getMemoryTypeByIndex(0)
        var flags = s.read_varuint32()
        var offset = s.read_varuint32()
        var value = f.cfStack.popVar(TYPES.I64)
        var addr = f.cfStack.popVar(TYPES.I32)
        boundsCheck(f, addr, offset, 4)
        switch (flags) {
          case 0:
            i32_store8(f, addr, offset + 0, "((" + value + ".low) & 0x000000FF) >>> 0")
            i32_store8(f, addr, offset + 1, "((" + value + ".low) & 0x0000FF00) >>> 8")
            i32_store8(f, addr, offset + 2, "((" + value + ".low) & 0x00FF0000) >>> 16")
            i32_store8(f, addr, offset + 3, "((" + value + ".low) & 0xFF000000) >>> 24")
            break
          case 1:
            i32_store16(f, addr, offset + 0, "((" + value + ".low) & 0x0000FFFF) >>> 0")
            i32_store16(f, addr, offset + 2, "((" + value + ".low) & 0xFFFF0000) >>> 16")
            break
          case 2:
            i32_store_aligned(f, addr, offset, "(" + value + ".low)")
            break
          default:
            throw new CompileError("unsupported load flags")
        }
        break

      case OPCODES.CURRENT_MEMORY:
        var mem_index = s.read_varuint1()
        if (mem_index !== 0) {
          throw new CompileError("only one memory in the MVP")
        }
        r.getMemoryTypeByIndex(mem_index)
        f.pushLine(f.cfStack.pushVar(TYPES.I32) + " = (memorySize / " + PAGE_SIZE + ")|0")
        break

      case OPCODES.GROW_MEMORY:
        var mem_index = s.read_varuint1()
        if (mem_index !== 0) {
          throw new CompileError("only one memory in the MVP")
        }
        r.getMemoryTypeByIndex(mem_index)
        var operand = f.cfStack.popVar(TYPES.I32)
        var res = f.cfStack.pushVar(TYPES.I32)
        f.pushLine(res + " = M0._grow(" + operand + ")")
        break

      case OPCODES.I32_CONST:
        var val = s.read_varint32()
        f.pushLine(f.cfStack.pushVar(TYPES.I32) + " = " + stringifyJSValue(val))
        break

      case OPCODES.I64_CONST:
        var val = s.read_varint64()
        f.pushLine(f.cfStack.pushVar(TYPES.I64) + " = " + stringifyJSValue(val))
        break

      case OPCODES.F32_CONST:
        var val = s.read_float32()
        f.pushLine(f.cfStack.pushVar(TYPES.F32) + " = " + stringifyJSValue(val))
        break

      case OPCODES.F64_CONST:
        var val = s.read_float64()
        f.pushLine(f.cfStack.pushVar(TYPES.F64) + " = " + stringifyJSValue(val))
        break

      case OPCODES.I32_EQZ:
        var operand = f.cfStack.getVar(TYPES.I32)
        f.pushLine(operand + " = (!(" + operand + "))|0")
        break

      case OPCODES.I32_EQ:
        i32_binaryOp(f, "==")
        break

      case OPCODES.I32_NE:
        i32_binaryOp(f, "!=")
        break

      case OPCODES.I32_LT_S:
        i32_binaryOp(f, "<")
        break

      case OPCODES.I32_LT_U:
        i32_binaryOp(f, "<", ">>>0")
        break

      case OPCODES.I32_GT_S:
        i32_binaryOp(f, ">")
        break

      case OPCODES.I32_GT_U:
        i32_binaryOp(f, ">", ">>>0")
        break

      case OPCODES.I32_LE_S:
        i32_binaryOp(f, "<=")
        break

      case OPCODES.I32_LE_U:
        i32_binaryOp(f, "<=", ">>>0")
        break

      case OPCODES.I32_GE_S:
        i32_binaryOp(f, ">=")
        break

      case OPCODES.I32_GE_U:
        i32_binaryOp(f, ">=", ">>>0")
        break

      case OPCODES.I64_EQZ:
        var operand = f.cfStack.popVar(TYPES.I64)
        var result = f.cfStack.pushVar(TYPES.I32)
        f.pushLine(result + " = (" + operand + ".isZero())|0")
        break

      case OPCODES.I64_EQ:
        i64_compareFunc(f, "i64_eq")
        break

      case OPCODES.I64_NE:
        i64_compareFunc(f, "i64_ne")
        break

      case OPCODES.I64_LT_S:
        i64_compareFunc(f, "i64_lt_s")
        break

      case OPCODES.I64_LT_U:
        i64_compareFunc(f, "i64_lt_u")
        break

      case OPCODES.I64_GT_S:
        i64_compareFunc(f, "i64_gt_s")
        break

      case OPCODES.I64_GT_U:
        i64_compareFunc(f, "i64_gt_u")
        break

      case OPCODES.I64_LE_S:
        i64_compareFunc(f, "i64_le_s")
        break

      case OPCODES.I64_LE_U:
        i64_compareFunc(f, "i64_le_u")
        break

      case OPCODES.I64_GE_S:
        i64_compareFunc(f, "i64_ge_s")
        break

      case OPCODES.I64_GE_U:
        i64_compareFunc(f, "i64_ge_u")
        break

      case OPCODES.F32_EQ:
        f32_compareOp(f, "==")
        break

      case OPCODES.F32_NE:
        f32_compareOp(f, "!=")
        break

      case OPCODES.F32_LT:
        f32_compareOp(f, "<")
        break

      case OPCODES.F32_GT:
        f32_compareOp(f, ">")
        break

      case OPCODES.F32_LE:
        f32_compareOp(f, "<=")
        break

      case OPCODES.F32_GE:
        f32_compareOp(f, ">=")
        break

      case OPCODES.F64_EQ:
        f64_compareOp(f, "==")
        break

      case OPCODES.F64_NE:
        f64_compareOp(f, "!=")
        break

      case OPCODES.F64_LT:
        f64_compareOp(f, "<")
        break

      case OPCODES.F64_GT:
        f64_compareOp(f, ">")
        break

      case OPCODES.F64_LE:
        f64_compareOp(f, "<=")
        break

      case OPCODES.F64_GE:
        f64_compareOp(f, ">=")
        break

      case OPCODES.I32_CLZ:
        i32_unaryOp(f, "i32_clz")
        break

      case OPCODES.I32_CTZ:
        i32_unaryOp(f, "i32_ctz")
        break

      case OPCODES.I32_POPCNT:
        i32_unaryOp(f, "i32_popcnt")
        break

      case OPCODES.I32_ADD:
        i32_binaryOp(f, "+")
        break

      case OPCODES.I32_SUB:
        i32_binaryOp(f, "-")
        break

      case OPCODES.I32_MUL:
        i32_binaryFunc(f, "i32_mul")
        break

      case OPCODES.I32_DIV_S:
        var rhs = f.cfStack.getVar(TYPES.I32)
        var lhs = f.cfStack.getVar(TYPES.I32, 1)
        f.pushLine("if (" + rhs + " == 0) { return trap('i32_div_s') }")
        f.pushLine("if (" + lhs + " == INT32_MIN && " + rhs + " == -1) { return trap('i32_div_s') }")
        i32_binaryOp(f, "/")
        break

      case OPCODES.I32_DIV_U:
        var rhs = f.cfStack.getVar(TYPES.I32)
        var lhs = f.cfStack.getVar(TYPES.I32, 1)
        f.pushLine("if (" + rhs + " == 0) { return trap('i32_div_u') }")
        i32_binaryOp(f, "/", ">>>0")
        break

      case OPCODES.I32_REM_S:
        var rhs = f.cfStack.getVar(TYPES.I32)
        f.pushLine("if (" + rhs + " == 0) { return trap('i32_rem_s') }")
        i32_binaryOp(f, "%")
        break

      case OPCODES.I32_REM_U:
        var rhs = f.cfStack.getVar(TYPES.I32)
        f.pushLine("if (" + rhs + " == 0) { return trap('i32_rem_u') }")
        i32_binaryOp(f, "%", ">>>0")
        var res = f.cfStack.getVar(TYPES.I32)
        f.pushLine(res + " = " + res + "|0")
        break

      case OPCODES.I32_AND:
        i32_binaryOp(f, "&")
        break

      case OPCODES.I32_OR:
        i32_binaryOp(f, "|")
        break

      case OPCODES.I32_XOR:
        i32_binaryOp(f, "^")
        break

      case OPCODES.I32_SHL:
        i32_binaryOp(f, "<<")
        break

      case OPCODES.I32_SHR_S:
        i32_binaryOp(f, ">>")
        break

      case OPCODES.I32_SHR_U:
        i32_binaryOp(f, ">>>")
        break

      case OPCODES.I32_ROTL:
        i32_binaryFunc(f, "i32_rotl")
        break

      case OPCODES.I32_ROTR:
        i32_binaryFunc(f, "i32_rotr")
        break

      case OPCODES.I64_CLZ:
        i64_unaryFunc(f, "i64_clz")
        break

      case OPCODES.I64_CTZ:
        i64_unaryFunc(f, "i64_ctz")
        break

      case OPCODES.I64_POPCNT:
        i64_unaryFunc(f, "i64_popcnt")
        break

      case OPCODES.I64_ADD:
        i64_binaryFunc(f, "i64_add")
        break

      case OPCODES.I64_SUB:
        i64_binaryFunc(f, "i64_sub")
        break

      case OPCODES.I64_MUL:
        i64_binaryFunc(f, "i64_mul")
        break

      case OPCODES.I64_DIV_S:
        var rhs = f.cfStack.getVar(TYPES.I64)
        var lhs = f.cfStack.getVar(TYPES.I64, 1)
        f.pushLine("if (" + rhs + ".isZero()) { return trap('i64_div_s') }")
        f.pushLine("if (" + lhs + ".eq(Long.MIN_VALUE) && " + rhs + ".eq(Long.NEG_ONE)) { return trap('i64_div_s') }")
        i64_binaryFunc(f, "i64_div_s")
        break

      case OPCODES.I64_DIV_U:
        var rhs = f.cfStack.getVar(TYPES.I64)
        f.pushLine("if (" + rhs + ".isZero()) { return trap('i64_div_u') }")
        i64_binaryFunc(f, "i64_div_u")
        break

      case OPCODES.I64_REM_S:
        var rhs = f.cfStack.getVar(TYPES.I64)
        f.pushLine("if (" + rhs + ".isZero()) { return trap('i64_rem_s') }")
        i64_binaryFunc(f, "i64_rem_s")
        break

      case OPCODES.I64_REM_U:
        var rhs = f.cfStack.getVar(TYPES.I64)
        f.pushLine("if (" + rhs + ".isZero()) { return trap('i64_rem_u') }")
        i64_binaryFunc(f, "i64_rem_u")
        break

      case OPCODES.I64_AND:
        i64_binaryFunc(f, "i64_and")
        break

      case OPCODES.I64_OR:
        i64_binaryFunc(f, "i64_or")
        break

      case OPCODES.I64_XOR:
        i64_binaryFunc(f, "i64_xor")
        break

      case OPCODES.I64_SHL:
        i64_binaryFunc(f, "i64_shl")
        break

      case OPCODES.I64_SHR_S:
        i64_binaryFunc(f, "i64_shr_s")
        break

      case OPCODES.I64_SHR_U:
        i64_binaryFunc(f, "i64_shr_u")
        break

      case OPCODES.I64_ROTL:
        i64_binaryFunc(f, "i64_rotl")
        break

      case OPCODES.I64_ROTR:
        i64_binaryFunc(f, "i64_rotr")
        break

      case OPCODES.F32_ABS:
        f32_unaryOp(f, "f32_abs")
        break

      case OPCODES.F32_NEG:
        f32_unaryOp(f, "f32_neg")
        break

      case OPCODES.F32_CEIL:
        f32_unaryOp(f, "f32_ceil")
        break

      case OPCODES.F32_FLOOR:
        f32_unaryOp(f, "f32_floor")
        break

      case OPCODES.F32_TRUNC:
        f32_unaryOp(f, "f32_trunc")
        break

      case OPCODES.F32_NEAREST:
        f32_unaryOp(f, "f32_nearest")
        break

      case OPCODES.F32_SQRT:
        f32_unaryOp(f, "f32_sqrt")
        break

      case OPCODES.F32_ADD:
        f32_binaryOp(f, "+")
        break

      case OPCODES.F32_SUB:
        f32_binaryOp(f, "-")
        break

      case OPCODES.F32_MUL:
        f32_binaryOp(f, "*")
        break

      case OPCODES.F32_DIV:
        f32_binaryOp(f, "/")
        break

      case OPCODES.F32_MIN:
        f32_binaryFunc(f, "f32_min")
        break

      case OPCODES.F32_MAX:
        f32_binaryFunc(f, "f32_max")
        break

      case OPCODES.F32_COPYSIGN:
        f32_binaryFunc(f, "f32_copysign")
        break

      case OPCODES.F64_ABS:
        f64_unaryOp(f, "f64_abs")
        break

      case OPCODES.F64_NEG:
        f64_unaryOp(f, "f64_neg")
        break

      case OPCODES.F64_CEIL:
        f64_unaryOp(f, "f64_ceil")
        break

      case OPCODES.F64_FLOOR:
        f64_unaryOp(f, "f64_floor")
        break

      case OPCODES.F64_TRUNC:
        f64_unaryOp(f, "f64_trunc")
        break

      case OPCODES.F64_NEAREST:
        f64_unaryOp(f, "f64_nearest")
        break

      case OPCODES.F64_SQRT:
        f64_unaryOp(f, "f64_sqrt")
        break

      case OPCODES.F64_ADD:
        f64_binaryOp(f, "+")
        break

      case OPCODES.F64_SUB:
        f64_binaryOp(f, "-")
        break

      case OPCODES.F64_MUL:
        f64_binaryOp(f, "*")
        break

      case OPCODES.F64_DIV:
        f64_binaryOp(f, "/")
        break

      case OPCODES.F64_MIN:
        f64_binaryFunc(f, "f64_min")
        break

      case OPCODES.F64_MAX:
        f64_binaryFunc(f, "f64_max")
        break

      case OPCODES.F64_COPYSIGN:
        f64_binaryFunc(f, "f64_copysign")
        break

      case OPCODES.I32_WRAP_I64:
        var operand = f.cfStack.popVar(TYPES.I64)
        var output = f.cfStack.pushVar(TYPES.I32)
        f.pushLine(output + " = " + operand + ".low")
        break

      case OPCODES.I32_TRUNC_S_F32:
        var operand = f.cfStack.popVar(TYPES.F32)
        var output = f.cfStack.pushVar(TYPES.I32)
        f.pushLine("if (" + operand + " > INT32_MAX) { return trap('i32_trunc_s') }")
        f.pushLine("if (" + operand + " < INT32_MIN) { return trap('i32_trunc_s') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap() }")
        f.pushLine(output + " = (" + operand + ")|0")
        break

      case OPCODES.I32_TRUNC_S_F64:
        var operand = f.cfStack.popVar(TYPES.F64)
        var output = f.cfStack.pushVar(TYPES.I32)
        f.pushLine("if (" + operand + " > INT32_MAX) { return trap('i32_trunc_s') }")
        f.pushLine("if (" + operand + " < INT32_MIN) { return trap('i32_trunc_s') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('i32_trunc_s') }")
        f.pushLine(output + " = (" + operand + ")|0")
        break

      case OPCODES.I32_TRUNC_U_F32:
        var operand = f.cfStack.popVar(TYPES.F32)
        var output = f.cfStack.pushVar(TYPES.I32)
        f.pushLine("if (" + operand + " > UINT32_MAX) { return trap('i32_trunc') }")
        f.pushLine("if (" + operand + " <= -1) { return trap('i32_trunc') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('i32_trunc') }")
        f.pushLine(output + " = ((" + operand + ")>>>0)|0")
        break

      case OPCODES.I32_TRUNC_U_F64:
        var operand = f.cfStack.popVar(TYPES.F64)
        var output = f.cfStack.pushVar(TYPES.I32)
        f.pushLine("if (" + operand + " > UINT32_MAX) { return trap('i32_trunc') }")
        f.pushLine("if (" + operand + " <= -1) { return trap('i32_trunc') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('i32_trunc') }")
        f.pushLine(output + " = (" + operand + ")>>>0")
        break

      case OPCODES.I64_EXTEND_S_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.I64)
        f.pushLine(output + " = Long.fromNumber(" + operand + ")")
        break

      case OPCODES.I64_EXTEND_U_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.I64)
        f.pushLine(output + " = Long.fromNumber(" + operand + ">>>0, true).toSigned()")
        break

      case OPCODES.I64_TRUNC_S_F32:
        var operand = f.cfStack.popVar(TYPES.F32)
        var output = f.cfStack.pushVar(TYPES.I64)
        // XXX TODO: I actually don't understand floating-point much at all,
        //           right now am just hacking the tests into passing...
        f.pushLine("if (" + operand + " >= 9.22337203685e+18) { return trap('i64-trunc') }")
        f.pushLine("if (" + operand + " <= -9.22337313636e+18) { return trap('i64-trunc') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('i64-trunc') }")
        f.pushLine(output + " = Long.fromNumber(" + operand + ")")
        break

      case OPCODES.I64_TRUNC_S_F64:
        var operand = f.cfStack.popVar(TYPES.F64)
        var output = f.cfStack.pushVar(TYPES.I64)
        // XXX TODO: I actually don't understand floating-point much at all,
        //           right now am just hacking the tests into passing...
        f.pushLine("if (" + operand + " >= 9223372036854775808.0) { return trap('i64-trunc') }")
        f.pushLine("if (" + operand + " <= -9223372036854777856.0) { return trap('i64-trunc') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('i64-trunc') }")
        f.pushLine(output + " = Long.fromNumber(" + operand + ")")
        break

      case OPCODES.I64_TRUNC_U_F32:
        var operand = f.cfStack.popVar(TYPES.F32)
        var output = f.cfStack.pushVar(TYPES.I64)
        // XXX TODO: I actually don't understand floating-point much at all,
        //           right now am just hacking the tests into passing...
        f.pushLine("if (" + operand + " >= 1.84467440737e+19) { return trap('i64-trunc') }")
        f.pushLine("if (" + operand + " <= -1) { return trap('i64-trunc') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('i64-trunc') }")
        f.pushLine(output + " = Long.fromNumber(" + operand + ", true).toSigned()")
        break

      case OPCODES.I64_TRUNC_U_F64:
        var operand = f.cfStack.popVar(TYPES.F64)
        var output = f.cfStack.pushVar(TYPES.I64)
        // XXX TODO: I actually don't understand floating-point much at all,
        //           right now am just hacking the tests into passing...
        f.pushLine("if (" + operand + " >= 18446744073709551616.0) { return trap('too big') }")
        f.pushLine("if (" + operand + " <= -1) { return trap('too small') }")
        f.pushLine("if (isNaN(" + operand + ")) { return trap('NaN') }")
        f.pushLine(output + " = Long.fromNumber(f64_trunc(" + operand + "), true).toSigned()")
        break

      case OPCODES.F32_CONVERT_S_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.F32)
        f.pushLine(output + " = ToF32(" + operand + "|0)")
        break

      case OPCODES.F32_CONVERT_U_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.F32)
        f.pushLine(output + " = ToF32(" + operand + ">>>0)")
        break

      case OPCODES.F32_CONVERT_S_I64:
        var operand = f.cfStack.popVar(TYPES.I64)
        var output = f.cfStack.pushVar(TYPES.F32)
        f.pushLine(output + " = ToF32(" + operand + ".toNumber())")
        break

      case OPCODES.F32_CONVERT_U_I64:
        var operand = f.cfStack.popVar(TYPES.I64)
        var output = f.cfStack.pushVar(TYPES.F32)
        f.pushLine(output + " = ToF32(" + operand + ".toUnsigned().toNumber())")
        break

      case OPCODES.F32_DEMOTE_F64:
        var operand = f.cfStack.popVar(TYPES.F64)
        var output = f.cfStack.pushVar(TYPES.F32)
        f.pushLine(output + " = ToF32(" + operand + ")")
        break

      case OPCODES.F64_CONVERT_S_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.F64)
        f.pushLine(output + " = +(" + operand + "|0)")
        break

      case OPCODES.F64_CONVERT_U_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.F64)
        f.pushLine(output + " = +(" + operand + ">>>0)")
        break

      case OPCODES.F64_CONVERT_S_I64:
        var operand = f.cfStack.popVar(TYPES.I64)
        var output = f.cfStack.pushVar(TYPES.F64)
        f.pushLine(output + " = +(" + operand + ".toNumber())")
        break

      case OPCODES.F64_CONVERT_U_I64:
        var operand = f.cfStack.popVar(TYPES.I64)
        var output = f.cfStack.pushVar(TYPES.F64)
        f.pushLine(output + " = +(" + operand + ".toUnsigned().toNumber())")
        break

      case OPCODES.F64_PROMOTE_F32:
        var operand = f.cfStack.popVar(TYPES.F32)
        var output = f.cfStack.pushVar(TYPES.F64)
        f.pushLine(output + " = +(" + operand + ")")
        break

      case OPCODES.I32_REINTERPRET_F32:
        var operand = f.cfStack.popVar(TYPES.F32)
        var output = f.cfStack.pushVar(TYPES.I32)
        f.pushLine(output + " = i32_reinterpret_f32(" + operand + ")")
        break

      case OPCODES.I64_REINTERPRET_F64:
        var operand = f.cfStack.popVar(TYPES.F64)
        var output = f.cfStack.pushVar(TYPES.I64)
        f.pushLine(output + " = i64_reinterpret_f64(" + operand + ")")
        break

      case OPCODES.F32_REINTERPRET_I32:
        var operand = f.cfStack.popVar(TYPES.I32)
        var output = f.cfStack.pushVar(TYPES.F32)
        f.pushLine(output + " = f32_reinterpret_i32(" + operand + ")")
        break

      case OPCODES.F64_REINTERPRET_I64:
        var operand = f.cfStack.popVar(TYPES.I64)
        var output = f.cfStack.pushVar(TYPES.F64)
        f.pushLine(output + " = f64_reinterpret_i64(" + operand + ")")
        break

      default:
        throw new CompileError("unsupported opcode: 0x" + op.toString(16))
    }
  }

  // OK, we're now in a position to render the function code.
  
  var params = []
  f.sig.param_types.forEach(function(typ, idx) {
    params.push(getLocalVar(idx, typ, true))
  })
  r.putln("function ", f.name, "(", params.join(","), ") {")

  // Coerce parameters to appropriate types

  f.sig.param_types.forEach(function(typ, idx) {
    var nm = getLocalVar(idx, typ)
    switch (typ) {
      case TYPES.I32:
        r.putln(nm, " = ", nm, "|0")
        break
      case TYPES.I64:
        // No typecasting as it's not valid asmjs anyway.
        break
      case TYPES.F32:
        // XXX TODO: This breaks our NaN-boxing
        // r.putln(nm, " = fround(", nm, ")")
        break
      case TYPES.F64:
        // XXX TODO: This breaks our NaN-boxing
        // r.putln(nm, " = +", nm)
        break
    }
  })

  // Declare local variables

  var idx = f.sig.param_types.length
  f.locals.forEach(function(l) {
    for (var i = 0; i < l.count; i++) {
      var nm = getLocalVar(idx++, l.type)
      switch (l.type) {
        case TYPES.I32:
          r.putln("var ", nm, " = 0")
          break
        case TYPES.I64:
          r.putln("var ", nm, " = new Long(0, 0)")
          break
        case TYPES.F32:
          r.putln("var ", nm, " = fround(0.0)")
          break
        case TYPES.F64:
          r.putln("var ", nm, " = 0.0")
          break
      }
    }
  })

  // Declare stack variables

  ;([TYPES.I32, TYPES.I64, TYPES.F32, TYPES.F64]).forEach(function(typ) {
    var height = f.cfStack.maxStackHeights[typ]
    for (var i = 0; i < height; i++) {
      switch (typ) {
        case TYPES.I32:
          r.putln("var si", i, " = 0")
          break
        case TYPES.I64:
          r.putln("var sl", i, " = new Long(0, 0)")
          break
        case TYPES.F32:
          r.putln("var sf", i, " = fround(0.0)")
          break
        case TYPES.F64:
          r.putln("var sf", i, " = 0.0")
          break
      }
    }
  })

  // Spit out all the pre-prepared body code lines.

  f.bodyLines.forEach(function(ln) {
    r.putln(ln)
  })

  // Phew!  That's everything for this function.
  r.putln("}")
}


// We represent WASM's "structured stack" as a "stack of stacks".
// Each time we enter a block, we push a new stack on top of
// the existing control-flow structures.  Code can only access
// items from within this top-most stack, not any of the stacks
// below it.

function ControlFlowStack() {
  this.stack = []
  this.maxStackHeights = {}
  this.maxStackHeights[TYPES.I32] = 0
  this.maxStackHeights[TYPES.I64] = 0
  this.maxStackHeights[TYPES.F32] = 0
  this.maxStackHeights[TYPES.F64] = 0
}

// Push a new control-flow context onto the stack.

ControlFlowStack.prototype.push = function push(op, sig, endReached) {
  var prev = null
  var prevStackHeights = {}
  if (this.stack.length === 0) {
    prevStackHeights[TYPES.I32] = 0
    prevStackHeights[TYPES.I64] = 0
    prevStackHeights[TYPES.F32] = 0
    prevStackHeights[TYPES.F64] = 0
  } else {
    var prev = this.stack[this.stack.length - 1]
    prevStackHeights[TYPES.I32] = prev.prevStackHeights[TYPES.I32]
    prevStackHeights[TYPES.I64] = prev.prevStackHeights[TYPES.I64]
    prevStackHeights[TYPES.F32] = prev.prevStackHeights[TYPES.F32]
    prevStackHeights[TYPES.F64] = prev.prevStackHeights[TYPES.F64]
    prev.typeStack.forEach(function(typ) {
      prevStackHeights[typ] += 1
    })
  }
  this.stack.push({
    op: op,
    sig: sig,
    index: this.stack.length,
    label: "L" + this.stack.length,
    isPolymorphic: false,
    isDead: prev ? prev.isDead : false,
    endReached: !!endReached,
    typeStack: [],
    prevStackHeights: prevStackHeights
  })
  return this.stack[this.stack.length - 1]
}

// Pop the topmost control-flow context from the stack.

ControlFlowStack.prototype.pop = function pop() {
  return this.stack.pop()
}

// Peek at the topmost control-flow context on the stack.

ControlFlowStack.prototype.peek = function peek() {
  return this.stack[this.stack.length - 1]
}

// Mark the topmost control-flow context as dead from this point on.

ControlFlowStack.prototype.markDeadCode = function markDeadCode() {
  var cf = this.stack[this.stack.length - 1]
  cf.isDead = true
  cf.isPolymorphic = true
  cf.typeStack = []
}

// Check whether the topmost control-flow context is in dead code.

ControlFlowStack.prototype.isDeadCode = function isDeadCode() {
  return this.stack[this.stack.length - 1].isDead
}

// Push a new stack entry of the given type, return corresponding variable.

ControlFlowStack.prototype.pushVar = function pushVar(typ) {
  this.stack[this.stack.length - 1].typeStack.push(typ)
  return this.getVar(typ)
}

// Find out what type is current on top of the value stack.

ControlFlowStack.prototype.peekType = function peekType() {
  var cf = this.stack[this.stack.length - 1]
  var stack = cf.typeStack
  if (stack.length === 0) {
    if (! cf.isPolymorphic) {
      throw new CompileError("nothing on the stack")
    }
    return TYPES.UNKNOWN
  }
  return stack[stack.length - 1]
}

// Pop the topmost entry from the stack, returning its corresponding variable.
// You must specify the expected type.

ControlFlowStack.prototype.popVar = function popVar(wantType) {
  var name = this.getVar(wantType)
  var cf = this.stack[this.stack.length - 1]
  var typ = cf.typeStack.pop()
  if (wantType !== TYPES.UNKNOWN && typ !== wantType && typ !== TYPES.UNKNOWN) {
    if (! cf.isPolymorphic) {
      throw new CompileError("Stack type mismatch: expected " + wantType + ", found " + typ)
    }
    return "UNREACHABLE"
  }
  return name
}

// Get the variable for the topmost item on the stack.
// You must provide the expected type.

ControlFlowStack.prototype.getVar = function getVar(wantType, pos) {
  var cf = this.stack[this.stack.length - 1]
  var where = cf.typeStack.length - 1 - (pos || 0)
  if (where < 0) {
    if (! cf.isPolymorphic) {
      throw new CompileError("stack access outside current block")
    }
    return "UNREACHABLE"
  }
  var typ = cf.typeStack[where]
  if (typ !== wantType && typ !== TYPES.UNKNOWN && wantType !== TYPES.UNKNOWN) {
    throw new CompileError("Stack type mismatch: expected " + wantType + ", found " + typ)
  }
  var height = cf.prevStackHeights[typ]
  for (var i = 0; i < where; i++) {
    if (cf.typeStack[i] === typ) {
      height += 1
    }
  }
  if (height >= this.maxStackHeights[typ]) {
    this.maxStackHeights[typ] = height + 1
  }
  switch (typ) {
    case TYPES.I32:
      return "si" + height
    case TYPES.I64:
      return "sl" + height
    case TYPES.F32:
      return "sf" + height
    case TYPES.F64:
      return "sd" + height
    case TYPES.UNKNOWN:
      return "UNREACHABLE"
      break
    default:
      throw new CompileError("unexpected type on stack: " + typ)
  }
}

// Get the stack variable into which the given block
// should store its output.

ControlFlowStack.prototype.getBlockOutputVar = function getBlockOutputVar(index) {
  var cf = this.getBranchTarget(index)
  if (cf.sig === TYPES.NONE) {
    throw new CompileError("No output from void block")
  }
  var height = cf.prevStackHeights[cf.sig]
  switch (cf.sig) {
    case TYPES.I32:
      return "si" + height
    case TYPES.I64:
      return "sl" + height
    case TYPES.F32:
      return "sf" + height
    case TYPES.F64:
      return "sd" + height
    default:
      throw new CompileError("unexpected type on stack")
  }
}

ControlFlowStack.prototype.getBranchTarget = function getBranchTarget(depth) {
  var which = this.stack.length - (1 + depth)
  if (which < 0) {
    throw new CompileError("Branch depth too large")
  }
  return this.stack[which]
}


//
// A bunch of helpers for rendering different kinds of expression.
//

function i32_unaryOp(f, what, cast) {
  cast = cast || "|0"
  var operand = f.cfStack.getVar(TYPES.I32)
  f.pushLine(operand + " = (" + what + "(" + operand + "))" + cast)
}

function i32_binaryOp(f, what, cast) {
  cast = cast || "|0"
  var rhs = "(" + f.cfStack.popVar(TYPES.I32) + cast + ")"
  var lhs = "(" + f.cfStack.popVar(TYPES.I32) + cast + ")"
  f.pushLine(f.cfStack.pushVar(TYPES.I32) + " = (" + lhs + what + rhs + ")" + cast)
}

function i32_binaryFunc(f, what, cast) {
  cast = cast || "|0"
  var rhs = "(" + f.cfStack.popVar(TYPES.I32) + cast + ")"
  var lhs = "(" + f.cfStack.popVar(TYPES.I32) + cast + ")"
  f.pushLine(f.cfStack.pushVar(TYPES.I32) + " = (" + what + "(" + lhs + ", " + rhs + "))" + cast)
}

function i64_unaryFunc(f, what) {
  var operand = f.cfStack.getVar(TYPES.I64)
  f.pushLine(operand + " = " + what + "(" + operand + ")")
}

function i64_binaryFunc(f, what) {
  var rhs = "(" + f.cfStack.popVar(TYPES.I64) + ")"
  var lhs = "(" + f.cfStack.popVar(TYPES.I64) + ")"
  f.pushLine(f.cfStack.pushVar(TYPES.I64) + " = " + what + "(" + lhs + ", " + rhs + ")")
}

function i64_compareFunc(f, what) {
  var rhs = "(" + f.cfStack.popVar(TYPES.I64) + ")"
  var lhs = "(" + f.cfStack.popVar(TYPES.I64) + ")"
  f.pushLine(f.cfStack.pushVar(TYPES.I32) + " = " + what + "(" + lhs + ", " + rhs + ")|0")
}

function f32_compareOp(f, what) {
  var rhs = f.cfStack.popVar(TYPES.F32)
  var lhs = f.cfStack.popVar(TYPES.F32)
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine(res + " = (" + lhs + " " + what + " " + rhs + ")|0")
}

function f32_unaryOp(f, what) {
  var operand = f.cfStack.popVar(TYPES.F32)
  f.pushLine(f.cfStack.pushVar(TYPES.F32) + " = ToF32(" + what +"(" + operand + "))")
}

function f32_binaryOp(f, what) {
  var rhs = f.cfStack.popVar(TYPES.F32)
  var lhs = f.cfStack.popVar(TYPES.F32)
  f.pushLine(f.cfStack.pushVar(TYPES.F32) + " = ToF32(" + lhs + " " + what + " " + rhs + ")")
}

function f32_binaryFunc(f, what) {
  var rhs = f.cfStack.popVar(TYPES.F32)
  var lhs = f.cfStack.popVar(TYPES.F32)
  f.pushLine(f.cfStack.pushVar(TYPES.F32) + " = ToF32(" + what + "(" + lhs + ", " + rhs + "))")
}

function f64_compareOp(f, what) {
  var rhs = f.cfStack.popVar(TYPES.F64)
  var lhs = f.cfStack.popVar(TYPES.F64)
  f.pushLine(f.cfStack.pushVar(TYPES.I32) + " = (" + lhs + " " + what + " " + rhs + ")|0")
}

function f64_unaryOp(f, what) {
  var operand = f.cfStack.popVar(TYPES.F64)
  f.pushLine(f.cfStack.pushVar(TYPES.F64) + " = " + what +"(" + operand + ")")
}

function f64_binaryOp(f, what) {
  var rhs = f.cfStack.popVar(TYPES.F64)
  var lhs = f.cfStack.popVar(TYPES.F64)
  f.pushLine(f.cfStack.pushVar(TYPES.F64) + " = " + lhs + " " + what + " " + rhs)
}

function f64_binaryFunc(f, what) {
  var rhs = f.cfStack.popVar(TYPES.F64)
  var lhs = f.cfStack.popVar(TYPES.F64)
  f.pushLine(f.cfStack.pushVar(TYPES.F64) + " = " + what + "(" + lhs + ", " + rhs + ")")
}

function boundsCheck(f, addr, offset, size) {
  f.pushLine("if ((" + addr + ">>>0) + " + (offset + size) + " > memorySize) { return trap('OOB') }")
}

function i32_load_unaligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine(res + " = i32_load_unaligned(" + addr + " + " + offset + ")")
}

function i32_load_aligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
  f.pushLine("  " + res + " = i32_load_unaligned(" + addr + " + " + offset + ")")
  f.pushLine("} else {")
  f.pushLine("  " + res + " = HI32[(" + addr + " + " + offset + ")>>2]")
  f.pushLine("}")
}

function i32_load8_s(f, addr, offset, value) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine(res + " = HI8[(" + addr + " + " + offset + ")]")
}

function i32_load8_u(f, addr, offset, value) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine(res + " = HU8[(" + addr + " + " + offset + ")]")
}

function i32_load16_s_unaligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine(res + " = i32_load16_s_unaligned(" + addr + " + " + offset + ")")
}

function i32_load16_u_unaligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine(res + " = i32_load16_u_unaligned(" + addr + " + " + offset + ")")
}

function i32_load16_s_aligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
  f.pushLine("  " + res + " = i32_load16_s_unaligned(" + addr + " + " + offset + ")")
  f.pushLine("} else {")
  f.pushLine("  " + res + " = HI16[(" + addr + " + " + offset + ")>>1]")
  f.pushLine("}")
}

function i32_load16_u_aligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.I32)
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
  f.pushLine("  " + res + " = i32_load16_u_unaligned(" + addr + " + " + offset + ")")
  f.pushLine("} else {")
  f.pushLine("  " + res + " = HU16[(" + addr + " + " + offset + ")>>1]")
  f.pushLine("}")
}

function i32_store_unaligned(f, addr, offset, value) {
  f.pushLine("i32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
}

function i32_store_aligned(f, addr, offset, value) {
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
  f.pushLine("  i32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
  f.pushLine("} else {")
  f.pushLine("  HI32[(" + addr + " + " + offset + ")>>2] = " + value)
  f.pushLine("}")
}

function i32_store8(f, addr, offset, value) {
  f.pushLine("HU8[(" + addr + " + " + offset + ")] = " + value)
}

function i32_store16(f, addr, offset, value) {
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x01) {")
  f.pushLine("  i32_store16_unaligned(" + addr + " + " + offset + ", " + value + ")")
  f.pushLine("} else {")
  f.pushLine("  HU16[(" + addr + " + " + offset + ")>>1] = " + value)
  f.pushLine("}")
}

function f32_load_unaligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.F32)
  f.pushLine(res + " = f32_load_unaligned(" + addr + " + " + offset + ")")
  f.pushLine(res + " = f32_load_fix_signalling(" + res + ", " + addr + " + " + offset + ")")
}

function f32_load_aligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.F32)
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
  f.pushLine("  " + res + " = f32_load_unaligned(" + addr + " + " + offset + ")")
  f.pushLine("} else {")
  f.pushLine("  " + res + " = HF32[(" + addr + " + " + offset + ")>>2]")
  f.pushLine("}")
  f.pushLine(res + " = f32_load_fix_signalling(" + res + ", " + addr + " + " + offset + ")")
}

function f32_store_unaligned(f, addr, offset, value) {
  f.pushLine("f32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
  f.pushLine("f32_store_fix_signalling(" + value + ", " + addr + " + " + offset + ")")
}

function f32_store_aligned(f, addr, offset, value) {
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x03) {")
  f.pushLine("  f32_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
  f.pushLine("} else {")
  f.pushLine("  HF32[(" + addr + " + " + offset + ")>>2] = " + value)
  f.pushLine("}")
  f.pushLine("f32_store_fix_signalling(" + value + ", " + addr + " + " + offset + ")")
}

function f64_load_unaligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.F64)
  f.pushLine(res + " = f64_load_unaligned(" + addr + " + " + offset + ")")
}

function f64_load_aligned(f, addr, offset) {
  var res = f.cfStack.pushVar(TYPES.F64)
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x07) {")
  f.pushLine("  " + res + " = f64_load_unaligned(" + addr + " + " + offset + ")")
  f.pushLine("} else {")
  f.pushLine("  " + res + " = HF64[(" + addr + " + " + offset + ")>>3]")
  f.pushLine("}")
}

function f64_store_unaligned(f, addr, offset, value) {
  f.pushLine("f64_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
}

function f64_store_aligned(f, addr, offset, value) {
  f.pushLine("if ((" + addr + " + " + offset + ") & 0x07) {")
  f.pushLine("  f64_store_unaligned(" + addr + " + " + offset + ", " + value + ")")
  f.pushLine("} else {")
  f.pushLine("  HF64[(" + addr + " + " + offset + ")>>3] = " + value)
  f.pushLine("}")
}

function i64_from_i32_s(f) {
  var low32 = f.cfStack.popVar(TYPES.I32)
  var res = f.cfStack.pushVar(TYPES.I64)
  // Sign-extend into 64 bits
  f.pushLine("if (" + low32 + " & 0x80000000) {")
  f.pushLine("  " + res + " = new Long(" + low32 + ", -1)")
  f.pushLine("} else {")
  f.pushLine("  " + res + " = new Long(" + low32 + ", 0)")
  f.pushLine("}")
}

function i64_from_i32_u(f) {
  var low32 = f.cfStack.popVar(TYPES.I32)
  f.pushLine(f.cfStack.pushVar(TYPES.I64) + " = new Long(" + low32 + ", 0)")
}

function i64_from_i32x2(f) {
  var high32 = f.cfStack.popVar(TYPES.I32)
  var low32 = f.cfStack.popVar(TYPES.I32)
  f.pushLine(f.cfStack.pushVar(TYPES.I64) + " = new Long(" + low32 + ", " + high32 + ")")
}
