/**
 * A Promise that will reject, if not resolved after [timeout] ms.
 * @param timeout
 * @param timeoutMessage
 * @param {Object} options - options of promise
 * @param {Boolean} options.resolveOnTimeout - if true promise will resolve null after timeout, instead of reject.
 * @param {function | undefined} options.onTimeoutResult - if promise timed out, output of this method will return instead of null.
 * @param {any | undefined} options.data - if promise timed out, id will pass to onTimeoutResult.
 * @constructor
 */
function TimeoutPromise(timeout, timeoutMessage, options={}) {
  var self = this;
  this.isFulfilled = false;
  this.options = options;
  this.promise = new Promise(function(resolve, reject) {
    self._reject = reject
    self._resolve = resolve
  })
  this.resolve = function resolve() {
    this.isFulfilled = true;
    this._resolve(...arguments)
  }
  this.reject = function () {
    this.isFulfilled = true;
    if(this.options.resolveOnTimeout) {
      if(this.options.onTimeoutResult)
        this._resolve(this.options.onTimeoutResult(this.options.data))
      else
        this._resolve(null)
    } else
      this._reject(...arguments)
  }

  this.waitToFulfill = function(){
    return this.promise;
  }

  if(timeout) {
    setTimeout(() => {
      if(!self.isFulfilled) {
        self.reject({message: timeoutMessage || 'Promise timed out'})
      }
    }, timeout)
  }
}

module.exports = TimeoutPromise;