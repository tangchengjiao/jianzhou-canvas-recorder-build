type MapWithInsertionHelpers<K, V> = Map<K, V> & {
  getOrInsert?: (key: K, defaultValue: V) => V;
  getOrInsertComputed?: (key: K, callback: (key: K) => V) => V;
};

// Excalidraw otherwise falls back to esm.sh for optional drawing fonts.
// Set the path before App/Excalidraw evaluates so Web and Tauri stay offline.
Reflect.set(
  globalThis,
  "EXCALIDRAW_ASSET_PATH",
  `${globalThis.location.origin}/excalidraw-assets/`,
);

const mapPrototype = Map.prototype as MapWithInsertionHelpers<unknown, unknown>;

// PDF.js 6 uses the new Map upsert helpers. They are available in recent
// Chromium releases but not in every locally installed Edge version that can
// otherwise run this app. Keep the tiny standards-compatible fallback local
// so PDF import remains fully offline and we do not need a broad polyfill.
if (typeof mapPrototype.getOrInsert !== "function") {
  Object.defineProperty(mapPrototype, "getOrInsert", {
    configurable: true,
    writable: true,
    value(this: Map<unknown, unknown>, key: unknown, defaultValue: unknown) {
      if (this.has(key)) return this.get(key);
      this.set(key, defaultValue);
      return defaultValue;
    },
  });
}

if (typeof mapPrototype.getOrInsertComputed !== "function") {
  Object.defineProperty(mapPrototype, "getOrInsertComputed", {
    configurable: true,
    writable: true,
    value(
      this: Map<unknown, unknown>,
      key: unknown,
      callback: (key: unknown) => unknown,
    ) {
      if (this.has(key)) return this.get(key);
      const value = callback(key);
      this.set(key, value);
      return value;
    },
  });
}
