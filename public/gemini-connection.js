'use strict';
(function (root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.JtgGeminiConnection = value;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const DEVICE_KEY = 'jtg-gemini-device-key-v1';
  const LEGACY_KEY = 'jtg-gemini-tab-key-v1';
  function create({ device, session, validate }) {
    function stored() {
      try { const value = device().getItem(DEVICE_KEY); return value ? validate(value) : ''; }
      catch { return ''; }
    }
    function restore() {
      const key = stored();
      if (key) return { key, remembered: true };
      // Keep an old tab connection usable, but never silently make it durable.
      try { const value = session().getItem(LEGACY_KEY); return { key: value ? validate(value) : '', remembered: false }; }
      catch { return { key: '', remembered: false }; }
    }
    function save(value, remember) {
      const key = validate(value);
      try {
        if (remember) device().setItem(DEVICE_KEY, key);
        else device().removeItem(DEVICE_KEY);
        session().removeItem(LEGACY_KEY);
        return { ok: true, remembered: remember };
      } catch {
        // Never report successful persistence/clearing when storage is blocked.
        return { ok: false, remembered: stored() === key };
      }
    }
    function clear() {
      let ok = true;
      for (const [storage, name] of [[device, DEVICE_KEY], [session, LEGACY_KEY]]) {
        try { storage().removeItem(name); } catch { ok = false; }
      }
      return ok;
    }
    return { stored, restore, save, clear };
  }
  return { DEVICE_KEY, LEGACY_KEY, create };
});
