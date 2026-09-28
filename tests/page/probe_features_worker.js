/* Companion of probe_features.html (stack-env probe, not part of the product). As a worker it answers one message with
   what it can see; loaded as a classic or module script in a window it only marks that it ran. */
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = function (e) {
    var r = { type: 'worker', origin: String(self.origin), coi: self.crossOriginIsolated, wasm: typeof WebAssembly, offscreen: typeof OffscreenCanvas, sab: typeof SharedArrayBuffer };
    try { r.offscreenWebgl2 = !!new OffscreenCanvas(4, 4).getContext('webgl2'); } catch (x) { r.offscreenWebgl2 = String(x); }
    self.postMessage(r);
  };
} else {
  self.__probeWorkerScriptRan = (self.__probeWorkerScriptRan || 0) + 1;
}
