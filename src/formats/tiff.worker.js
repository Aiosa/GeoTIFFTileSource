/* eslint-disable no-restricted-globals */
/**
 * RawTIFF worker for OpenSeadragon converter plugin.
 *
 * Responsibilities:
 *  - decodeRaster: raw TIFF bytes -> multi-band raster payload (transferable band buffers)
 *  - decodeAndRenderImageBitmap: raw TIFF bytes -> ImageBitmap (preferred) or RGBA8 fallback
 *  - decodeAndPackGpuTextureSet: raw TIFF bytes -> GPU-packed texture set (RGBA8 or RGBA16F)
 *  - rasterToGpuTextureSet: raster payload -> GPU-packed texture set (RGBA8 or RGBA16F)
 *
 * The "format" override is provided externally and must arrive via:
 *   payload.hints.formatResolved (preferred) OR payload.hints.format
 */

import { fromArrayBuffer } from "geotiff";
import { Converters } from "../utils/Converters.js";
import {
  PHOTOMETRIC,
  SAMPLE_ENCODING_VERSION,
  SAMPLE_FORMAT,
  channelEncodingAt,
  inferInterpretation,
  isDisplayReadyChannel,
  readSampleRangeTags,
  resolveSampleEncoding,
  sampleToByte,
  sampleToUnit,
} from "../utils/tiffEncoding.js";

// Tests in node have no self.
const workerRef = self || globalThis;

function workerWarn(code, message) {
  workerRef.postMessage({
    kind: "warn",
    code,
    message,
  });
}

// Photometric interpretation constants (matching TIFF spec / geotiff.js)
const PI = PHOTOMETRIC;

function errorToPlain(err) {
  try {
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    return err.message || JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function normalizeRasters(rasters) {
  if (Array.isArray(rasters)) return rasters;
  return [rasters];
}

function getPhotometric(fileDirectory) {
  return fileDirectory && typeof fileDirectory.PhotometricInterpretation === "number"
    ? fileDirectory.PhotometricInterpretation
    : undefined;
}

function getColorMap(fileDirectory) {
  return fileDirectory ? (fileDirectory.ColorMap || null) : null;
}

function getBitsPerSample(img) {
  try {
    if (typeof img.getBitsPerSample === "function") return img.getBitsPerSample();
  } catch { /* noop */ }
  return (img && img.fileDirectory && img.fileDirectory.BitsPerSample) || [8];
}

function getSamplesPerPixel(img) {
  try {
    if (typeof img.getSamplesPerPixel === "function") return img.getSamplesPerPixel();
  } catch { /* noop */ }
  return (img && img.fileDirectory && img.fileDirectory.SamplesPerPixel) || 1;
}

function getSampleFormat(img) {
  const fd = img && img.fileDirectory;
  return fd && fd.SampleFormat ? fd.SampleFormat : null;
}

function reviveBands(descs) {
  return descs.map((b) => {
    const Ctor = (typeof b.ctor === "string" && workerRef[b.ctor]) ? workerRef[b.ctor] : Uint8Array;
    return new Ctor(b.buffer, b.byteOffset || 0, b.length);
  });
}

/**
 * Declared sample encoding of a raster, resolved once and cached on the raster copy.
 * @param {Object} raster
 * @returns {import("../utils/tiffEncoding.js").SampleEncoding}
 */
function rasterEncoding(raster) {
  if (raster.__encoding) return raster.__encoding;

  const { sMinSampleValue, sMaxSampleValue } = readSampleRangeTags(raster.fileDirectory);
  const encoding = resolveSampleEncoding({
    bitsPerSample: raster.bitsPerSample,
    sampleFormat: raster.sampleFormat,
    sMinSampleValue,
    sMaxSampleValue,
    samplesPerPixel: Math.max(
      raster.samplesPerPixel || 0,
      raster.bands ? raster.bands.length : 0
    ),
  });
  raster.__encoding = encoding;
  return encoding;
}

/**
 * Image-vs-data classification. Delegates to the shared rule so the worker, the
 * main-thread renderer and the tile source cannot disagree about the same file.
 */
function inferFromTIFFTags(raster, format) {
  const selected = format && Array.isArray(format.channels) && format.channels.length
    ? format.channels
    : null;

  return inferInterpretation({
    photometricInterpretation: raster.photometricInterpretation,
    samplesPerPixel: raster.samplesPerPixel || (raster.bands ? raster.bands.length : 1),
    hasColorMap: !!raster.colorMap,
    encoding: rasterEncoding(raster),
  }, selected);
}

/**
 * Float32 -> IEEE-754 half-float bits (Uint16).
 * Produces correct HALF_FLOAT bit patterns suitable for WebGL upload.
 */
function f32ToF16Bits(val) {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);

  floatView[0] = val;
  const x = intView[0];

  const sign = (x >> 31) & 0x1;
  let exp = (x >> 23) & 0xFF;
  let mant = x & 0x7FFFFF;

  // NaN/Inf
  if (exp === 0xFF) {
    if (mant !== 0) return (sign << 15) | 0x7E00; // qNaN
    return (sign << 15) | 0x7C00; // Inf
  }

  // Denorm/Zero in f32
  if (exp === 0) {
    return (sign << 15); // flush subnormals to 0
  }

  // Normalize exponent from f32 bias (127) to f16 bias (15)
  exp = exp - 127 + 15;

  // Overflow -> Inf
  if (exp >= 0x1F) return (sign << 15) | 0x7C00;

  // Underflow -> 0 (flush)
  if (exp <= 0) return (sign << 15);

  // Mantissa: f32 has 23 bits, f16 has 10 bits
  mant = mant + 0x00001000; // rounding
  if (mant & 0x00800000) {
    mant = 0;
    exp += 1;
    if (exp >= 0x1F) return (sign << 15) | 0x7C00;
  }

  return (sign << 15) | (exp << 10) | (mant >> 13);
}

function resolveFormatFromHints(hints) {
  return (hints && (hints.formatResolved || hints.format)) || null;
}

/**
 * Image-mode RGBA8 renderer that respects:
 *  - photometricInterpretation
 *  - optional format.image.rgbaChannels override
 *  - optional hints.renderChannels override
 *
 * NOTE: This worker version is intentionally "display-oriented": every sample is mapped
 * to a display byte through the declared sample encoding, so a >8-bit plane forced down
 * this path is rescaled rather than truncated. Precision-focused packing happens after
 * this if RGBA16F is requested.
 */
function rasterToRGBA8_ImageMode(raster, hints, format) {
  const spp = raster.samplesPerPixel || (raster.bands ? raster.bands.length : 1);
  const photometric = raster.photometricInterpretation;
  const encoding = rasterEncoding(raster);

  // Display bytes for one band. 8-bit integer bands are passed through untouched.
  const bandBytes = (bandIndex) => {
    const band = raster.bands[bandIndex];
    if (!band) return null;
    const ch = channelEncodingAt(encoding, bandIndex);
    if (isDisplayReadyChannel(ch) &&
        (band instanceof Uint8Array || band instanceof Uint8ClampedArray)) {
      return band;
    }
    const out = new Uint8ClampedArray(band.length);
    for (let i = 0; i < band.length; i++) out[i] = sampleToByte(band[i], ch);
    return out;
  };

  // Channel override precedence:
  // format.image.rgbaChannels > hints.renderChannels > default behavior
  let channels = null;
  if (format && format.image && Array.isArray(format.image.rgbaChannels)) {
    channels = format.image.rgbaChannels.slice();
  } else if (hints && Array.isArray(hints.renderChannels)) {
    channels = hints.renderChannels.slice();
  }

  if (channels && channels.length > 4) {
    workerWarn(
      "renderChannels>4_to_RGBA_worker",
      `[tiff-worker] Requested ${channels.length} channels for RGBA output; only 4 can be represented. Extra channels will be dropped.`
    );
    channels.splice(4);
  }

  // Palette
  if (photometric === PI.Palette && raster.colorMap) {
    const indices = raster.bands[0];
    return Converters.RGBAfromPalette(indices, raster.colorMap);
  }

  // WhiteIsZero / BlackIsZero
  if ((photometric === PI.WhiteIsZero || photometric === PI.BlackIsZero) && spp >= 1) {
    const gray = bandBytes(0);
    if (photometric === PI.WhiteIsZero) return Converters.RGBAfromWhiteIsZero(gray, 255);
    return Converters.RGBAfromBlackIsZero(gray, 255);
  }

  // If explicit channel mapping exists, use it (planar -> interleaved -> RGBA)
  if (channels && channels.length >= 1) {
    const width = raster.width;
    const height = raster.height;
    const pixelCount = width * height;

    if (channels.length === 1) {
      // treat as black-is-zero for visualization
      return Converters.RGBAfromBlackIsZero(bandBytes(channels[0]), 255);
    }

    // build interleaved display bytes through the declared encoding
    const tmp = new Uint8ClampedArray(pixelCount * channels.length);
    const chEnc = channels.map((bi) => channelEncodingAt(encoding, bi));
    for (let i = 0; i < pixelCount; i++) {
      const base = i * channels.length;
      for (let c = 0; c < channels.length; c++) {
        const bi = channels[c];
        tmp[base + c] = (bi != null && bi >= 0 && bi < raster.bands.length)
          ? sampleToByte(raster.bands[bi][i], chEnc[c])
          : 0;
      }
    }

    // If we already built RGBA (4ch) and no special photometric, return directly.
    if (channels.length === 4 && photometric !== PI.YCbCr && photometric !== PI.CMYK && photometric !== PI.CIELab) {
      return tmp;
    }
    if (photometric === PI.YCbCr && channels.length >= 3) return Converters.RGBAfromYCbCr(tmp);
    if (photometric === PI.CMYK && channels.length >= 4) return Converters.RGBAfromCMYK(tmp);
    if (photometric === PI.CIELab && channels.length >= 3) return Converters.RGBAfromCIELab(tmp);
    if (channels.length === 3) return Converters.RGBAfromRGB(tmp);

    // fallback: force into RGBA
    const out = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
      const base = i * channels.length;
      out[j] = tmp[base] || 0;
      out[j + 1] = tmp[base + 1] || 0;
      out[j + 2] = tmp[base + 2] || 0;
      out[j + 3] = (channels.length >= 4) ? (tmp[base + 3] || 255) : 255;
    }
    return out;
  }

  // RGB / YCbCr / CMYK / Lab defaults. Bands are rescaled to display bytes first, so a
  // >8-bit plane forced down this path does not saturate in the Uint8ClampedArray copy.
  if (photometric === PI.RGB && spp >= 3) {
    return Converters.RGBAfromRGB(
      bandBytes(0), bandBytes(1), bandBytes(2), spp >= 4 ? bandBytes(3) : null
    );
  }

  if (photometric === PI.YCbCr && spp >= 3) {
    return Converters.RGBAfromYCbCr(bandBytes(0), bandBytes(1), bandBytes(2));
  }

  if (photometric === PI.CMYK && spp >= 4) {
    return Converters.RGBAfromCMYK(bandBytes(0), bandBytes(1), bandBytes(2), bandBytes(3));
  }

  if (photometric === PI.CIELab && spp >= 3) {
    return Converters.RGBAfromCIELab(bandBytes(0), bandBytes(1), bandBytes(2));
  }

  // Fallback grayscale
  return Converters.RGBAfromBlackIsZero(bandBytes(0), 255);
}

/** Encoding of a canonical display RGBA buffer: four 8-bit unsigned components. */
const CANONICAL_RGBA_ENCODING = {
  version: SAMPLE_ENCODING_VERSION,
  channels: [0, 1, 2, 3].map(() => ({
    scale: 255, offset: 0, signed: false, bits: 8, sampleFormat: 1,
  })),
};

function packCanonicalRGBA(rgba8, width, height, format) {
  const gpu = (format && format.gpu) || {};
  const preferRGBA8 = gpu.preferRGBA8 !== false;
  const forceRGBA16F = !!gpu.forceRGBA16F;

  // RGBA8 is the default for image-mode unless forced to 16F.
  // RGBA8 texels are normalized to [0,1] by the GPU on sample, so no work is needed here.
  if (preferRGBA8 && !forceRGBA16F) {
    const data = new Uint8Array(rgba8.buffer, rgba8.byteOffset, rgba8.byteLength);
    return {
      width,
      height,
      mode: "image",
      channelCount: 4,
      encodingVersion: SAMPLE_ENCODING_VERSION,
      encoding: CANONICAL_RGBA_ENCODING,
      packs: [{
        format: "RGBA8",
        data: {
          ctor: "Uint8Array",
          buffer: data.buffer,
          byteOffset: data.byteOffset,
          length: data.length,
        },
        channels: [0, 1, 2, 3],
        normalized: true,
        scale: [255, 255, 255, 255],
        offset: [0, 0, 0, 0],
      }],
    };
  }

  // RGBA16F image-mode: display bytes -> [0,1] half floats, same contract as the data path
  const px = width * height;
  const out = new Uint16Array(px * 4);
  for (let i = 0; i < out.length; i++) {
    out[i] = f32ToF16Bits(rgba8[i] / 255);
  }

  return {
    width,
    height,
    mode: "image",
    channelCount: 4,
    encodingVersion: SAMPLE_ENCODING_VERSION,
    encoding: CANONICAL_RGBA_ENCODING,
    packs: [{
      format: "RGBA16F",
      data: {
        ctor: "Uint16Array",
        buffer: out.buffer,
        byteOffset: 0,
        length: out.length,
      },
      channels: [0, 1, 2, 3],
      normalized: true,
      scale: [255, 255, 255, 255],
      offset: [0, 0, 0, 0],
    }],
  };
}

function packBandsAsData(raster, format) {
  const gpu = (format && format.gpu) || {};
  const preferRGBA8 = gpu.preferRGBA8 !== false;
  const forceRGBA16F = !!gpu.forceRGBA16F;
  const padAlpha = gpu.padAlpha == null ? 1 : gpu.padAlpha;

  const encoding = rasterEncoding(raster);
  const width = raster.width;
  const height = raster.height;
  const pixelCount = width * height;

  const bandCount = raster.bands ? raster.bands.length : 0;
  const channels = (format && Array.isArray(format.channels) && format.channels.length)
    ? format.channels.slice()
    : [...Array(bandCount).keys()];
  const channelCount = channels.filter((c) => c != null && c >= 0).length;

  // Decide RGBA8 vs RGBA16F. The channel must genuinely be 8-bit unsigned, not merely
  // arrive in a Uint8Array: geotiff.js unpacks 1/2/4-bit samples into one too, and a
  // texture the sampler divides by 255 would then contradict its declared scale.
  const allDisplayReady = channels.every((c) => {
    if (c == null || c < 0) return true; // padding lane, no constraint
    const ch = channelEncodingAt(encoding, c);
    const band = raster.bands[c];
    return ch.bits === 8 && ch.sampleFormat === SAMPLE_FORMAT.UINT &&
      (band instanceof Uint8Array || band instanceof Uint8ClampedArray);
  });
  const useRGBA8 = preferRGBA8 && !forceRGBA16F && allDisplayReady;

  const packs = [];
  for (let p = 0; p < channels.length; p += 4) {
    const packCh = [
      channels[p] ?? -1,
      channels[p + 1] ?? -1,
      channels[p + 2] ?? -1,
      channels[p + 3] ?? -1,
    ];

    // Unused lanes read as 0, except the alpha lane: a pack of fewer than 4 channels
    // would otherwise be fully transparent to any renderer that premultiplies by .a.
    const padValue = (k) => (k === 3 ? padAlpha : 0);

    if (useRGBA8) {
      const data = new Uint8Array(pixelCount * 4);
      for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
        for (let k = 0; k < 4; k++) {
          const bi = packCh[k];
          data[j + k] = (bi >= 0 && bi < raster.bands.length)
            ? raster.bands[bi][i]
            : Math.round(padValue(k) * 255);
        }
      }
      packs.push({
        format: "RGBA8",
        data: { ctor: "Uint8Array", buffer: data.buffer, byteOffset: 0, length: data.length },
        channels: packCh,
        normalized: true,
        scale: packCh.map((bi) => (bi >= 0 ? channelEncodingAt(encoding, bi).scale : 1)),
        offset: packCh.map((bi) => (bi >= 0 ? channelEncodingAt(encoding, bi).offset : 0)),
      });
      continue;
    }

    // RGBA16F packing. The declared encoding is applied unconditionally, so every
    // component reaching the GPU is in [0,1] -- or [-1,1] for signed sample formats.
    const data = new Uint16Array(pixelCount * 4);
    const scale = [1, 1, 1, 1];
    const offset = [0, 0, 0, 0];
    const packEnc = [null, null, null, null];

    for (let k = 0; k < 4; k++) {
      const bi = packCh[k];
      if (bi < 0 || bi >= raster.bands.length) continue;

      const ch = channelEncodingAt(encoding, bi);
      packEnc[k] = ch;
      scale[k] = ch.scale;
      offset[k] = ch.offset;
    }

    let clamped = false;
    for (let i = 0, j = 0; i < pixelCount; i++, j += 4) {
      for (let k = 0; k < 4; k++) {
        const bi = packCh[k];
        let v = (bi >= 0 && bi < raster.bands.length)
          ? sampleToUnit(raster.bands[bi][i], packEnc[k])
          : padValue(k);

        // clamp to half-float finite range; only reachable for out-of-declared-range floats
        if (v > 65504) { v = 65504; clamped = true; }
        else if (v < -65504) { v = -65504; clamped = true; }

        data[j + k] = f32ToF16Bits(v);
      }
    }

    if (clamped) {
      workerWarn(
        "gpuPack_f16_clamp_worker",
        "[tiff-worker] Some values exceeded RGBA16F finite range after normalization and were clamped. " +
        "Check SMinSampleValue/SMaxSampleValue on the file."
      );
    }

    packs.push({
      format: "RGBA16F",
      data: { ctor: "Uint16Array", buffer: data.buffer, byteOffset: 0, length: data.length },
      channels: packCh,
      normalized: true,
      scale,
      offset,
    });
  }

  return {
    width,
    height,
    mode: "data",
    channelCount,
    encodingVersion: SAMPLE_ENCODING_VERSION,
    encoding,
    packs,
  };
}

async function decodeRasterFromArrayBuffer(ab, hints) {
  const tiff = await fromArrayBuffer(ab);
  const count = await tiff.getImageCount();
  let imageIndex = hints && typeof hints.imageIndex === "number" ? hints.imageIndex : null;

  if (count !== 1) {
    if (imageIndex == null) {
      throw new Error(`[RawTiffPlugin] TIFF has ${count} images; provide rawTiff.hints.imageIndex to decode.`);
    }
    if (imageIndex < 0 || imageIndex >= count) {
      throw new Error(`[RawTiffPlugin] imageIndex ${imageIndex} out of range (0..${count - 1}).`);
    }
  } else {
    imageIndex = 0;
  }

  const img = await tiff.getImage(imageIndex);
  const width = img.getWidth();
  const height = img.getHeight();
  const fileDirectory = img.fileDirectory || {};
  const samplesPerPixel = getSamplesPerPixel(img);
  const bitsPerSample = getBitsPerSample(img);
  const sampleFormat = getSampleFormat(img);
  const photometricInterpretation = getPhotometric(fileDirectory);
  const colorMap = getColorMap(fileDirectory);

  // Fail loudly on SampleFormat 4/5/6 (undefined / complex) rather than rendering garbage.
  const { sMinSampleValue, sMaxSampleValue } = readSampleRangeTags(fileDirectory);
  resolveSampleEncoding({
    bitsPerSample,
    sampleFormat,
    sMinSampleValue,
    sMaxSampleValue,
    samplesPerPixel,
  });

  const decodeOpts = Object.assign({ interleave: false }, (hints && hints.decode) || {});
  const rasters = normalizeRasters(await img.readRasters({
    ...decodeOpts,
    pool: null, // already in worker, do not nest
  }));

  const bands = rasters.map((arr) => ({
    ctor: arr.constructor && arr.constructor.name ? arr.constructor.name : "Uint8Array",
    buffer: arr.buffer,
    byteOffset: arr.byteOffset,
    length: arr.length,
  }));

  return {
    width,
    height,
    bands,
    samplesPerPixel: Math.max(samplesPerPixel || 0, bands.length),
    bitsPerSample: Array.isArray(bitsPerSample) ? bitsPerSample : [bitsPerSample],
    sampleFormat: sampleFormat || null,
    photometricInterpretation,
    colorMap,
    fileDirectory,
  };
}

async function decodeAndRenderImageBitmapFromArrayBuffer(ab, hints) {
  const rasterPayload = await decodeRasterFromArrayBuffer(ab, hints);
  const raster = Object.assign({}, rasterPayload, { bands: reviveBands(rasterPayload.bands) });
  const format = resolveFormatFromHints(hints);

  // image-mode render only for ImageBitmap path
  const rgba = rasterToRGBA8_ImageMode(raster, hints, format);

  // Prefer OffscreenCanvas -> ImageBitmap if available in this worker.
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(raster.width, raster.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const imgData = new ImageData(rgba, raster.width, raster.height);
    ctx.putImageData(imgData, 0, 0);
    const bmp = canvas.transferToImageBitmap();
    return { kind: "imageBitmap", imageBitmap: bmp };
  }

  // Fallback: return RGBA bytes and let main thread create an ImageBitmap.
  return {
    kind: "rgba8",
    width: raster.width,
    height: raster.height,
    rgbaBuffer: rgba.buffer,
    rgbaByteOffset: rgba.byteOffset,
    rgbaLength: rgba.length,
  };
}

function rasterPayloadToTextureSet(rasterPayload, hints) {
  const raster = Object.assign({}, rasterPayload, { bands: reviveBands(rasterPayload.bands) });
  const format = resolveFormatFromHints(hints) || {};
  const interpretation = format.interpretation || "auto";
  const mode = (interpretation === "auto") ? inferFromTIFFTags(raster, format) : interpretation;

  if (mode === "image") {
    const rgba = rasterToRGBA8_ImageMode(raster, hints, format);
    return packCanonicalRGBA(rgba, raster.width, raster.height, format);
  }
  return packBandsAsData(raster, format);
}

async function decodeAndPackGpuTextureSetFromArrayBuffer(ab, hints) {
  const rasterPayload = await decodeRasterFromArrayBuffer(ab, hints);
  const texSet = rasterPayloadToTextureSet(rasterPayload, hints);
  return { rasterPayload, texSet };
}

function collectTransfersForRasterPayload(rasterPayload) {
  return rasterPayload.bands.map((b) => b.buffer);
}

function collectTransfersForTextureSet(texSet) {
  const transfers = [];
  for (const p of texSet.packs) {
    transfers.push(p.data.buffer);
  }
  return transfers;
}

workerRef.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  const op = msg.op;
  const payload = msg.payload || {};
  try {
    if (op === "decodeRaster") {
      const ab = payload.buffer;
      const hints = payload.hints || {};
      const result = await decodeRasterFromArrayBuffer(ab, hints);
      workerRef.postMessage({ id, ok: true, result }, collectTransfersForRasterPayload(result));
      return;
    }

    if (op === "decodeAndRenderImageBitmap") {
      const ab = payload.buffer;
      const hints = payload.hints || {};
      const result = await decodeAndRenderImageBitmapFromArrayBuffer(ab, hints);

      if (result.kind === "imageBitmap") {
        workerRef.postMessage({ id, ok: true, result }, [result.imageBitmap]);
      } else {
        workerRef.postMessage({ id, ok: true, result }, [result.rgbaBuffer]);
      }
      return;
    }

    if (op === "decodeAndPackGpuTextureSet") {
      const ab = payload.buffer;
      const hints = payload.hints || {};
      const result = await decodeAndPackGpuTextureSetFromArrayBuffer(ab, hints);

      const transfers = [
        ...collectTransfersForRasterPayload(result.rasterPayload),
        ...collectTransfersForTextureSet(result.texSet),
      ];
      workerRef.postMessage({ id, ok: true, result }, transfers);
      return;
    }

    if (op === "rasterToGpuTextureSet") {
      const raster = payload.raster;
      const hints = payload.hints || {};
      const texSet = rasterPayloadToTextureSet(raster, hints);
      workerRef.postMessage({ id, ok: true, result: texSet }, collectTransfersForTextureSet(texSet));
      return;
    }

    throw new Error(`[RawTiffPlugin] Unknown worker op: ${op}`);
  } catch (e) {
    workerRef.postMessage({ id, ok: false, error: errorToPlain(e) });
  }
};