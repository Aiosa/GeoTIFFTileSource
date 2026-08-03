// test/encoding.browser.test.js
// The declared sample-encoding contract: every component reaching the GPU is in [0,1]
// (or [-1,1] when signed), interpretation is bit-depth aware, and the tile source
// describes both before the first tile.
import { describe, it, expect, beforeAll } from "vitest";
import OpenSeadragon from "openseadragon";

import { enableGeoTIFFTileSource } from "../src/main.js";
import { installRawTiffPlugin } from "../src/formats/tiff.js";
import {
  SAMPLE_ENCODING_VERSION,
  resolveSampleEncoding,
} from "../src/utils/tiffEncoding.js";

import {
  fixtureGray8,
  fixtureGray16,
  fixtureGrayFloat32,
  fixtureGrayFloat32Ranged,
  fixtureGrayInt16,
  fixtureGrayUndefinedFormat,
  fixtureRGB8Chunky,
  fixtureRGB16Chunky,
  patternByte,
} from "./data/tiff-fixtures.js";

enableGeoTIFFTileSource(OpenSeadragon);

/** IEEE-754 half-float bits -> Number. */
function f16ToF32(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits & 0x7c00) >> 10;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (mantissa / 1024);
  if (exponent === 0x1f) return mantissa ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + mantissa / 1024);
}

function wrapRaw(ab, hints = {}) {
  return OpenSeadragon.RawTiffPlugin.wrap(ab, { hints });
}

/** Component `c` of pixel (x,y) in pack 0, decoded back to a Number. */
function componentAt(tex, x, y, c) {
  const pack = tex.packs[0];
  const index = (y * tex.width + x) * 4 + c;
  return pack.format === "RGBA16F" ? f16ToF32(pack.data[index]) : pack.data[index] / 255;
}

describe("resolveSampleEncoding", () => {
  it("derives scale/offset per SampleFormat", () => {
    const uint16 = resolveSampleEncoding({ bitsPerSample: [16], sampleFormat: [1] });
    expect(uint16.version).toBe(SAMPLE_ENCODING_VERSION);
    expect(uint16.channels[0]).toMatchObject({ scale: 65535, offset: 0, signed: false });

    // The odd bit depths that reach the shader as raw counts today.
    for (const bits of [10, 12, 14]) {
      const enc = resolveSampleEncoding({ bitsPerSample: [bits], sampleFormat: [1] });
      expect(enc.channels[0].scale).toBe(Math.pow(2, bits) - 1);
    }

    const int16 = resolveSampleEncoding({ bitsPerSample: [16], sampleFormat: [2] });
    expect(int16.channels[0]).toMatchObject({ scale: 32767, offset: 0, signed: true });

    // A missing SampleFormat tag means unsigned integer.
    const untagged = resolveSampleEncoding({ bitsPerSample: [8], sampleFormat: null });
    expect(untagged.channels[0]).toMatchObject({ scale: 255, offset: 0, signed: false });
  });

  it("uses SMin/SMax for float samples and falls back to identity without them", () => {
    const ranged = resolveSampleEncoding({
      bitsPerSample: [32],
      sampleFormat: [3],
      sMinSampleValue: [-1],
      sMaxSampleValue: [3],
    });
    expect(ranged.channels[0]).toMatchObject({ scale: 4, offset: -1, signed: true });

    const plain = resolveSampleEncoding({ bitsPerSample: [32], sampleFormat: [3] });
    expect(plain.channels[0]).toMatchObject({ scale: 1, offset: 0 });
  });

  it("resolves per channel, not per file", () => {
    const enc = resolveSampleEncoding({
      bitsPerSample: [8, 16, 32],
      sampleFormat: [1, 2, 3],
      samplesPerPixel: 3,
    });
    expect(enc.channels.map((c) => c.scale)).toEqual([255, 32767, 1]);
    expect(enc.channels.map((c) => c.signed)).toEqual([false, true, true]);
  });

  it("rejects SampleFormat 4/5/6", () => {
    for (const sampleFormat of [4, 5, 6]) {
      expect(() => resolveSampleEncoding({ bitsPerSample: [8], sampleFormat: [sampleFormat] }))
        .toThrow(/Unsupported SampleFormat/);
    }
  });
});

describe("bit-depth-aware interpretation", () => {
  /** @type {*} */
  let api;
  beforeAll(() => { api = OpenSeadragon.RawTiffPlugin; });

  const auto = (ab) => api.convert({}, wrapRaw(ab, { format: { interpretation: "auto" } }), "gpuTextureSet");

  it("keeps 8-bit pictures on the image path", async () => {
    expect((await auto(fixtureGray8())).mode).toBe("image");
    expect((await auto(fixtureRGB8Chunky())).mode).toBe("image");
  });

  it("sends 16-bit RGB down the data path (the image path would saturate it to white)", async () => {
    expect((await auto(fixtureRGB16Chunky())).mode).toBe("data");
  });

  it("sends float32 grayscale down the data path (the image path would render it black)", async () => {
    expect((await auto(fixtureGrayFloat32())).mode).toBe("data");
    expect((await auto(fixtureGray16())).mode).toBe("data");
  });

  it("rejects a file with SampleFormat 4 instead of mis-rendering it", async () => {
    await expect(auto(fixtureGrayUndefinedFormat())).rejects.toThrow(/Unsupported SampleFormat/);
  });
});

describe("declared encoding of GPU packs", () => {
  /** @type {*} */
  let api;
  beforeAll(() => {
    api = OpenSeadragon.RawTiffPlugin;
    // These assertions are only meaningful if packing really happens in the worker.
    expect(api.getWorkerPool()).toBeTruthy();
  });

  const pack = (ab) => api.convert({}, wrapRaw(ab, { format: { interpretation: "auto" } }), "gpuTextureSet");

  it("stamps the encoding version and descriptor", async () => {
    const tex = await pack(fixtureGray16());
    expect(tex.encodingVersion).toBe(SAMPLE_ENCODING_VERSION);
    expect(tex.encoding.channels[0]).toMatchObject({ scale: 65535, offset: 0, bits: 16 });
    expect(tex.packs[0].normalized).toBe(true);
    expect(tex.packs[0].scale[0]).toBe(65535);
  });

  it("normalizes uint16 to [0,1]", async () => {
    const tex = await pack(fixtureGray16());
    expect(tex.packs[0].format).toBe("RGBA16F");

    for (const [x, y] of [[0, 0], [3, 2], [15, 15]]) {
      // sample = patternByte * 257, scale = 65535 => unit = patternByte / 255
      expect(componentAt(tex, x, y, 0)).toBeCloseTo(patternByte(x, y, 0) / 255, 3);
    }
  });

  it("normalizes uint16 RGB to [0,1] on every channel", async () => {
    const tex = await pack(fixtureRGB16Chunky());
    for (let c = 0; c < 3; c++) {
      expect(componentAt(tex, 4, 1, c)).toBeCloseTo(patternByte(4, 1, c) / 255, 3);
    }
    // the padding lane is opaque, not transparent
    expect(componentAt(tex, 4, 1, 3)).toBe(1);
  });

  it("normalizes int16 to [-1,1] using the signed rule", async () => {
    const tex = await pack(fixtureGrayInt16());
    expect(tex.encoding.channels[0].signed).toBe(true);

    for (const [x, y] of [[0, 0], [7, 5]]) {
      const raw = (patternByte(x, y, 0) - 128) * 256;
      const value = componentAt(tex, x, y, 0);
      expect(value).toBeCloseTo(raw / 32767, 3);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("normalizes float32 through SMinSampleValue/SMaxSampleValue", async () => {
    const plain = await pack(fixtureGrayFloat32());
    expect(plain.encoding.channels[0]).toMatchObject({ scale: 1, offset: 0 });
    expect(componentAt(plain, 3, 2, 0)).toBeCloseTo(patternByte(3, 2, 0) / 255, 3);

    const ranged = await pack(fixtureGrayFloat32Ranged());
    expect(ranged.encoding.channels[0]).toMatchObject({ scale: 4, offset: -1 });
    // raw = byte/255*4 - 1, so (raw - offset) / scale == byte / 255
    for (const [x, y] of [[0, 0], [9, 4], [15, 15]]) {
      const value = componentAt(ranged, x, y, 0);
      expect(value).toBeCloseTo(patternByte(x, y, 0) / 255, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("keeps image-mode packs in [0,1] under forceRGBA16F", async () => {
    const tex = await api.convert(
      {},
      wrapRaw(fixtureRGB8Chunky(), { format: { gpu: { forceRGBA16F: true } } }),
      "gpuTextureSet"
    );
    expect(tex.mode).toBe("image");
    expect(tex.packs[0].format).toBe("RGBA16F");
    expect(tex.encodingVersion).toBe(SAMPLE_ENCODING_VERSION);
    for (let c = 0; c < 3; c++) {
      const value = componentAt(tex, 4, 1, c);
      expect(value).toBeLessThanOrEqual(1);
      expect(value).toBeCloseTo(patternByte(4, 1, c) / 255, 2);
    }
  });
});

describe("pack lanes and RGBA8 selection", () => {
  /** @type {*} */
  let api;
  beforeAll(() => {
    api = OpenSeadragon.RawTiffPlugin;
    expect(api.getWorkerPool()).toBeTruthy();
  });

  /**
   * Build a raster with arbitrary tags. Conversion transfers the band buffers, so this
   * must produce a fresh raster per call.
   */
  const raster = ({ bands, bitsPerSample = [8], sampleFormat = null, photometric, colorMap = null, format }) =>
    new api.TiffRaster({
      width: 4,
      height: 1,
      bands,
      samplesPerPixel: bands.length,
      bitsPerSample,
      sampleFormat,
      photometricInterpretation: photometric,
      colorMap,
      fileDirectory: {},
      hints: format ? { format } : {},
    });

  const packRaster = (params) => api.convert({}, raster(params), "gpuTextureSet", "tiffRaster");

  const band = (values) => Uint8Array.from(values);

  it("packs sub-byte samples as RGBA16F, not RGBA8", async () => {
    // geotiff.js unpacks 4-bit samples into a Uint8Array; picking RGBA8 on array type
    // alone would stamp scale = 15 on a texture the sampler divides by 255.
    const tex = await packRaster({ bands: [band([0, 5, 10, 15])], bitsPerSample: [4] });

    expect(tex.packs[0].format).toBe("RGBA16F");
    expect(tex.encoding.channels[0].scale).toBe(15);
    expect(componentAt(tex, 0, 0, 0)).toBeCloseTo(0, 5);
    expect(componentAt(tex, 3, 0, 0)).toBeCloseTo(1, 3);
    expect(componentAt(tex, 1, 0, 0)).toBeCloseTo(5 / 15, 3);
  });

  it("keeps genuine 8-bit unsigned samples on the RGBA8 fast path", async () => {
    const tex = await packRaster({ bands: [band([0, 1, 2, 3])], bitsPerSample: [8], sampleFormat: [1] });
    expect(tex.packs[0].format).toBe("RGBA8");
    expect(tex.packs[0].scale[0]).toBe(255);
  });

  it("fills the alpha lane of a short pack with opaque", async () => {
    const bands = [band([1, 2, 3, 4]), band([5, 6, 7, 8]), band([9, 10, 11, 12])];
    const tex = await packRaster({ bands, bitsPerSample: [8, 8, 8], sampleFormat: [1, 1, 1] });

    expect(tex.packs[0].channels).toEqual([0, 1, 2, -1]);
    // Without this a renderer that premultiplies by .a draws nothing at all.
    expect(componentAt(tex, 0, 0, 3)).toBe(1);
  });

  it("honours format.gpu.padAlpha", async () => {
    const bands = () => [band([1, 2, 3, 4]), band([5, 6, 7, 8]), band([9, 10, 11, 12])];
    const opaque = await packRaster({ bands: bands(), format: { gpu: { padAlpha: 1 } } });
    const transparent = await packRaster({ bands: bands(), format: { gpu: { padAlpha: 0 } } });

    expect(componentAt(opaque, 0, 0, 3)).toBe(1);
    expect(componentAt(transparent, 0, 0, 3)).toBe(0);
  });

  it("pads only the alpha lane, not the other spare lanes", async () => {
    const bands = [0, 1, 2, 3, 4, 5].map((c) => band([c, c, c, c]));
    const tex = await packRaster({ bands, bitsPerSample: [8, 8, 8, 8, 8, 8] });

    expect(tex.packs.length).toBe(2);
    expect(tex.packs[1].channels).toEqual([4, 5, -1, -1]);

    const pack1 = tex.packs[1].data;
    expect(pack1[2]).toBe(0);    // spare colour lane
    expect(pack1[3]).toBe(255);  // alpha lane
  });

  it("classifies palette by whether a LUT is actually present", async () => {
    // A ColorMap is indexed by the raw sample at any bit depth, so palette is exempt
    // from the 8-bit test -- but only when the LUT exists.
    const withLut = await packRaster({
      bands: [band([0, 1, 2, 3])],
      photometric: 3,
      colorMap: new Uint16Array(768),
    });
    expect(withLut.mode).toBe("image");

    const withoutLut = await packRaster({
      bands: [Uint16Array.from([0, 4096, 32768, 65535])],
      bitsPerSample: [16],
      sampleFormat: [1],
      photometric: 3,
      colorMap: null,
    });
    expect(withoutLut.mode).toBe("data");
    expect(withoutLut.packs[0].format).toBe("RGBA16F");
    expect(componentAt(withoutLut, 3, 0, 0)).toBeCloseTo(1, 3);
  });
});

describe("plugin defaults", () => {
  it("merges defaults.format instead of replacing it", () => {
    const stub = {
      converter: { learn() {} },
      console: { warn() {}, error() {} },
      supportsAsync: true,
    };
    const api = installRawTiffPlugin(stub, {
      defaults: { format: { interpretation: "data" } },
      workerPool: { enabled: false },
    });

    expect(api.defaults.format.interpretation).toBe("data");
    // everything the caller did not restate must survive
    expect(api.defaults.format.gpu.preferRGBA8).toBe(true);
    expect(api.defaults.format.gpu.padAlpha).toBe(1);
    expect(api.defaults.format.hints.layout.pyramid).toBe("auto");
  });
});

describe("main-thread CPU renderer", () => {
  /** @type {*} */
  let api;
  beforeAll(() => { api = OpenSeadragon.RawTiffPlugin; });

  it("rescales a 16-bit plane instead of truncating it", async () => {
    const raster = await api.convert({}, wrapRaw(fixtureGray16()), "tiffRaster");
    const rgba = api.rasterToRGBA8(raster);

    // Uint8ClampedArray truncation would put everything at 255 for byte >= 1.
    const at = (x, y) => rgba[(y * 16 + x) * 4];
    expect(at(0, 0)).toBe(0);
    expect(at(3, 2)).toBeLessThan(50);
    expect(at(3, 2)).toBeCloseTo(patternByte(3, 2, 0), -1);
  });

  it("agrees with the worker image path on an 8-bit file", async () => {
    const ab = fixtureRGB8Chunky();
    const raster = await api.convert({}, wrapRaw(ab), "tiffRaster");
    const cpu = api.rasterToRGBA8(raster);

    const bitmap = await api.convert({}, wrapRaw(ab), "imageBitmap");
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const worker = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;

    expect(worker.length).toBe(cpu.length);
    for (let i = 0; i < cpu.length; i++) {
      expect(Math.abs(worker[i] - cpu[i])).toBeLessThanOrEqual(1);
    }
  });
});

describe("GeoTIFFTileSource surface", () => {
  const asFile = (ab, name = "fixture.tif") => new File([ab], name);

  it("is not ready until the header is parsed", async () => {
    const events = [];
    const source = new OpenSeadragon.GeoTIFFTileSource(asFile(fixtureGray16()));
    source.addHandler("ready", (e) => events.push({
      width: e.tileSource.width,
      dimensions: e.tileSource.dimensions,
    }));

    // The defect this guards: 'ready' raised from inside super(), before anything is known.
    expect(source.ready).toBe(false);
    expect(events.length).toBe(0);

    await source.promises.ready.promise;

    expect(source.ready).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0].width).toBe(16);
    expect(Number.isNaN(events[0].dimensions.x)).toBe(false);
    // TiledImage computes normHeight from this exactly once; NaN there is unrecoverable.
    expect(Number.isFinite(source.dimensions.y / source.dimensions.x)).toBe(true);
    // the base handler must not leave a zero behind after setupLevels()
    expect(source._tileWidth).toBeGreaterThan(0);
    expect(source._tileHeight).toBeGreaterThan(0);
  });

  it("describes the source before the first tile", async () => {
    const source = new OpenSeadragon.GeoTIFFTileSource(asFile(fixtureGray16()));
    await source.promises.ready.promise;

    const descriptor = source.getTiffDescriptor();
    expect(descriptor).toMatchObject({
      width: 16,
      height: 16,
      samplesPerPixel: 1,
      photometricInterpretation: 1,
      hasColorMap: false,
      interpretationResolved: "data",
    });
    expect(descriptor.bitsPerSample).toEqual([16]);
    expect(descriptor.sampleFormat).toEqual([1]);
    expect(descriptor.channels).toEqual([0]);

    expect(source.getSampleEncoding()).toEqual(descriptor.encoding);
    expect(source.getSampleEncoding().channels[0]).toMatchObject({ scale: 65535, bits: 16 });
  });

  it("reports an 8-bit RGB source as image-interpreted", async () => {
    const source = new OpenSeadragon.GeoTIFFTileSource(asFile(fixtureRGB8Chunky()));
    await source.promises.ready.promise;
    expect(source.getTiffDescriptor().interpretationResolved).toBe("image");
  });

  it("matches TIFF urls and magic bytes for autodetection", () => {
    const supports = OpenSeadragon.GeoTIFFTileSource.prototype.supports;
    expect(supports.call(null, "https://example.org/slide.tif")).toBe(true);
    expect(supports.call(null, { url: "https://example.org/slide.ome.tiff" })).toBe(true);
    expect(supports.call(null, { type: "geotiff" })).toBe(true);
    expect(supports.call(null, fixtureGray8())).toBe(true);
    expect(supports.call(null, "https://example.org/info.dzi")).toBe(false);
    expect(supports.call(null, { some: "config" })).toBe(false);

    expect(OpenSeadragon.TileSource.determineType(null, { url: "x.tif" }, null))
      .toBe(OpenSeadragon.GeoTIFFTileSource);
  });

  it("exposes the adapter-aware loader", async () => {
    expect(typeof OpenSeadragon.GeoTIFFTileSource.openGeoTIFF).toBe("function");
    const tiff = await OpenSeadragon.GeoTIFFTileSource.openGeoTIFF(asFile(fixtureGray16()));
    const image = await tiff.getImage(0);
    expect(image.getWidth()).toBe(16);
  });
});
