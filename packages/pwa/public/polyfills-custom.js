// Manual polyfills for WHATWG/platform APIs core-js doesn't cover (it only
// polyfills ECMAScript language builtins, not Web Platform APIs).
// Needed for old Tizen WebKit (Tizen 5.5, ~2019) webviews.
(function () {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
    AbortSignal.timeout = function (ms) {
      var ctrl = new AbortController();
      setTimeout(function () { ctrl.abort(new DOMException('TimeoutError', 'TimeoutError')); }, ms);
      return ctrl.signal;
    };
  }
})();
