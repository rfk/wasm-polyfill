//
// Custom error subclasses.
// Nothing too unusual here.
//

export function CompileError(message) {
  this.message = message || ""
  if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CompileError);
  }
}
CompileError.prototype = new Error()
CompileError.prototype.constructor = CompileError


export function LinkError(message) {
  this.message = message || ""
  if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LinkError);
  }
}
LinkError.prototype = new Error()
LinkError.prototype.constructor = LinkError


export function RuntimeError(message) {
  this.message = message || ""
  if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RuntimeError);
  }
}
RuntimeError.prototype = new Error()
RuntimeError.prototype.constructor = RuntimeError
