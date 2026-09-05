(function exposeSubmitBridge(globalWindow) {
  "use strict";

  var maxPayloadBytes = 64 * 1024;

  function isJsonCompatible(value, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (var index = 0; index < value.length; index += 1) {
        if (!isJsonCompatible(value[index], seen)) return false;
      }
    } else {
      for (var key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key) && !isJsonCompatible(value[key], seen))
          return false;
      }
    }
    seen.delete(value);
    return true;
  }

  function submitToAgent(payload) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (typeof payload.kind !== "string" || payload.kind.trim() === "") return false;
    if (
      !isJsonCompatible(payload.data, new WeakSet()) ||
      !isJsonCompatible(payload.metadata, new WeakSet())
    )
      return false;
    var message = {
      type: "html-submit",
      payload: { kind: payload.kind, data: payload.data, metadata: payload.metadata },
    };
    var serialized;
    try {
      serialized = JSON.stringify(message);
    } catch (_error) {
      return false;
    }
    if (new TextEncoder().encode(serialized).length > maxPayloadBytes) return false;
    window.parent.postMessage(message, "*");
    return true;
  }

  globalWindow.submitToAgent = submitToAgent;
})(window);
