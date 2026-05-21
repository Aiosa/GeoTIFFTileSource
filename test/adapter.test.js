import { describe, expect, it } from "vitest";
import OpenSeadragon from "openseadragon";
import { enableGeoTIFFTileSource } from "../src/main.js";
import { fixtureGray8 } from "./data/tiff-fixtures.js";

function parseRange(headerValue) {
  const m = /bytes=(\d+)-(\d+)/.exec(headerValue || "");
  if (!m) return null;
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
}

describe("httpAdapter injection", () => {
  it("routes all geotiff range requests through the supplied adapter", async () => {
    const tiffBuffer = fixtureGray8({ width: 32, height: 32 });
    const bytes = new Uint8Array(tiffBuffer);
    const calls = [];

    const httpAdapter = {
      async fetch(url, init) {
        const headers = init?.headers ?? {};
        const range = parseRange(headers.Range);
        calls.push({ url, range, signal: init?.signal ?? null });

        if (!range) {
          return new Response(bytes.slice(), {
            status: 200,
            headers: { "Content-Type": "image/tiff" },
          });
        }

        const start = Math.min(range.start, bytes.length);
        const end = Math.min(range.end + 1, bytes.length);
        const slice = bytes.slice(start, end);
        return new Response(slice, {
          status: 206,
          headers: {
            "Content-Type": "image/tiff",
            "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`,
          },
        });
      },
    };

    const OSD = Object.assign(Object.create(OpenSeadragon), OpenSeadragon);
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const url = "https://adapter-test.invalid/sample.tif";
    const tileSource = new OSD.GeoTIFFTileSource(url, {
      GeoTIFFOptions: {},
    });

    const tiff = await tileSource.promises.GeoTIFF;
    expect(tiff).toBeTruthy();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === url)).toBe(true);
    expect(calls.some((c) => c.range !== null)).toBe(true);
  });

  it("falls back to fromUrl when no adapter is provided (default fetch path)", () => {
    const OSD = Object.assign(Object.create(OpenSeadragon), OpenSeadragon);
    enableGeoTIFFTileSource(OSD);
    expect(OSD.GeoTIFFTileSource).toBeDefined();
  });
});
