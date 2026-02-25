export async function loadOpenSeadragon(url) {
  const mod = await import(new URL(url, import.meta.url).href);

  // Case 1: default export
  if (mod?.default) return mod.default;

  // Case 2: module namespace itself is OSD
  // (some bundlers export functions directly)
  if (mod?.Viewer || mod?.Point || mod?.convertor || mod?.Converter) return mod;

  // Case 3: global attachment
  if (globalThis.OpenSeadragon) return globalThis.OpenSeadragon;

  throw new Error("Failed to load OpenSeadragon from demo/openseadragon.js (no default export and no global OpenSeadragon).");
}