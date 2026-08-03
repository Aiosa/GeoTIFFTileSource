// test/tiff-fixtures.js
// Minimal baseline TIFF writer (little-endian, uncompressed, strips).
// Good enough for geotiff.js to readRasters().

function u16(v) {
  return [v & 255, (v >> 8) & 255];
}
function u32(v) {
  return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255];
}
function asciiZ(str) {
  const bytes = Array.from(new TextEncoder().encode(str));
  bytes.push(0);
  return bytes;
}

const TYPE = {
  BYTE: 1,
  ASCII: 2,
  SHORT: 3,
  LONG: 4,
  RATIONAL: 5,
  FLOAT: 11,
  DOUBLE: 12,
};

function f32Bits(v) {
  const f = new Float32Array([v]);
  return new Uint32Array(f.buffer)[0];
}

function f32Bytes(values) {
  const f = new Float32Array(values);
  return Array.from(new Uint8Array(f.buffer));
}

function writeIFDEntry(tag, type, count, valueOrOffset) {
  return [
    ...u16(tag),
    ...u16(type),
    ...u32(count),
    ...u32(valueOrOffset),
  ];
}

function align4(buf) {
  while (buf.length % 4 !== 0) buf.push(0);
}

function buildTIFF({
                     width,
                     height,
                     samplesPerPixel,
                     bitsPerSampleArray,
                     photometric, // optional number
                     planarConfiguration = 1, // 1 chunky, 2 planar
                     pixelBytes, // Uint8Array of image data in the chosen layout
                     imageDescription = null,
                     sampleFormatArray = null, // optional tag 339
                     sMinSampleValue = null,   // optional tag 340 (float fixtures)
                     sMaxSampleValue = null,   // optional tag 341 (float fixtures)
                   }) {
  // Header (8 bytes):
  // II (little endian), 42, offset to first IFD (we'll place IFD right after header + pixel data)
  const header = [
    0x49, 0x49, // 'II'
    0x2A, 0x00, // 42
    ...u32(0),  // placeholder IFD offset
  ];

  const data = Array.from(pixelBytes);
  // place IFD after pixel data, aligned
  const ifdOffset = header.length + data.length;
  const buf = [...header, ...data];
  align4(buf);

  // patch IFD offset
  const ifdOffsetLe = u32(ifdOffset);
  buf[4] = ifdOffsetLe[0];
  buf[5] = ifdOffsetLe[1];
  buf[6] = ifdOffsetLe[2];
  buf[7] = ifdOffsetLe[3];

  // IFD entries
  // Tags we use:
  // 256 ImageWidth (LONG)
  // 257 ImageLength (LONG)
  // 258 BitsPerSample (SHORT) count=spp (or 1)
  // 259 Compression (SHORT) = 1
  // 262 PhotometricInterpretation (SHORT) optional
  // 270 ImageDescription (ASCII) optional
  // 273 StripOffsets (LONG) count=1 (chunky) or spp (planar)
  // 277 SamplesPerPixel (SHORT)
  // 278 RowsPerStrip (LONG)
  // 279 StripByteCounts (LONG) count=1 (chunky) or spp (planar)
  // 284 PlanarConfiguration (SHORT)
  // (We keep it minimal.)

  const entries = [];

  // ImageWidth/Length
  entries.push(writeIFDEntry(256, TYPE.LONG, 1, width));
  entries.push(writeIFDEntry(257, TYPE.LONG, 1, height));

  // BitsPerSample may need an offset if count > 2 (since value field is 4 bytes)
  // A SHORT array of 1 or 2 values fits in the 4-byte value field and MUST be stored
  // inline -- readers decide inline-vs-offset from the size, not from the content.
  const shortArrayEntry = (tag, values) => {
    if (values.length === 1) return writeIFDEntry(tag, TYPE.SHORT, 1, values[0]);
    if (values.length === 2) {
      return writeIFDEntry(tag, TYPE.SHORT, 2, (values[0] & 0xffff) | ((values[1] & 0xffff) << 16));
    }
    return writeIFDEntry(tag, TYPE.SHORT, values.length, 0); // offset patched below
  };

  entries.push(shortArrayEntry(258, bitsPerSampleArray));

  // Compression = 1
  entries.push(writeIFDEntry(259, TYPE.SHORT, 1, 1));

  // PhotometricInterpretation (optional)
  if (typeof photometric === "number") {
    entries.push(writeIFDEntry(262, TYPE.SHORT, 1, photometric));
  }

  // ImageDescription (optional)
  let descOffset = 0;
  let descBytes = null;
  if (imageDescription) {
    descBytes = asciiZ(imageDescription);
    entries.push(writeIFDEntry(270, TYPE.ASCII, descBytes.length, 0)); // offset later
  }

  // Strip offsets / byte counts
  const pixelOffset = 8; // right after header
  if (planarConfiguration === 1) {
    entries.push(writeIFDEntry(273, TYPE.LONG, 1, pixelOffset));
    entries.push(writeIFDEntry(279, TYPE.LONG, 1, pixelBytes.length));
  } else {
    // planar: store spp strips back-to-back: plane0, plane1, ...
    const planeSize = (width * height * (bitsPerSampleArray[0] / 8));
    const offsets = [];
    const counts = [];
    for (let s = 0; s < samplesPerPixel; s++) {
      offsets.push(pixelOffset + s * planeSize);
      counts.push(planeSize);
    }
    // Need offsets array and counts array stored out-of-line
    entries.push(writeIFDEntry(273, TYPE.LONG, offsets.length, 0)); // offset later
    entries.push(writeIFDEntry(279, TYPE.LONG, counts.length, 0));  // offset later
  }

  // SamplesPerPixel
  entries.push(writeIFDEntry(277, TYPE.SHORT, 1, samplesPerPixel));

  // RowsPerStrip
  entries.push(writeIFDEntry(278, TYPE.LONG, 1, height));

  // PlanarConfiguration
  entries.push(writeIFDEntry(284, TYPE.SHORT, 1, planarConfiguration));

  // SampleFormat (339)
  if (sampleFormatArray) {
    entries.push(shortArrayEntry(339, sampleFormatArray));
  }

  // SMinSampleValue / SMaxSampleValue (340/341), written as FLOAT
  const floatArrayEntry = (tag, values) => (values.length === 1
    ? writeIFDEntry(tag, TYPE.FLOAT, 1, f32Bits(values[0]))
    : writeIFDEntry(tag, TYPE.FLOAT, values.length, 0)); // offset patched below

  if (sMinSampleValue) entries.push(floatArrayEntry(340, sMinSampleValue));
  if (sMaxSampleValue) entries.push(floatArrayEntry(341, sMaxSampleValue));

  // Build IFD block
  const ifdStart = buf.length;
  const numEntries = entries.length;
  buf.push(...u16(numEntries));

  // Placeholder where we will later place out-of-line data (BitsPerSample arrays, desc, strip arrays)
  const entryStart = buf.length;
  for (const e of entries) buf.push(...e);

  // NextIFD = 0
  buf.push(...u32(0));

  // Now append out-of-line values and patch offsets
  const patchShortArray = (tag, values) => {
    if (!values || values.length <= 2) return;
    align4(buf);
    const offset = buf.length;
    for (const v of values) buf.push(...u16(v));
    align4(buf);
    patchIFDValue(buf, ifdStart, numEntries, tag, offset);
  };

  const patchFloatArray = (tag, values) => {
    if (!values || values.length <= 1) return;
    align4(buf);
    const offset = buf.length;
    buf.push(...f32Bytes(values));
    align4(buf);
    patchIFDValue(buf, ifdStart, numEntries, tag, offset);
  };

  patchShortArray(258, bitsPerSampleArray);
  patchShortArray(339, sampleFormatArray);
  patchFloatArray(340, sMinSampleValue);
  patchFloatArray(341, sMaxSampleValue);

  // Patch ImageDescription
  if (descBytes) {
    align4(buf);
    descOffset = buf.length;
    buf.push(...descBytes);
    align4(buf);
    patchIFDValue(buf, ifdStart, numEntries, 270, descOffset);
  }

  // Patch planar strip arrays if needed
  if (planarConfiguration === 2) {
    const planeSize = (width * height * (bitsPerSampleArray[0] / 8));
    const offsets = [];
    const counts = [];
    for (let s = 0; s < samplesPerPixel; s++) {
      offsets.push(8 + s * planeSize);
      counts.push(planeSize);
    }

    align4(buf);
    const offsetsOffset = buf.length;
    for (const o of offsets) buf.push(...u32(o));
    align4(buf);

    align4(buf);
    const countsOffset = buf.length;
    for (const c of counts) buf.push(...u32(c));
    align4(buf);

    patchIFDValue(buf, ifdStart, numEntries, 273, offsetsOffset);
    patchIFDValue(buf, ifdStart, numEntries, 279, countsOffset);
  }

  return new Uint8Array(buf).buffer;
}

function patchIFDValue(buf, ifdStart, numEntries, tag, newValueOffset) {
  // IFD layout:
  // u16 count
  // entries: 12 bytes each
  // u32 nextIFD
  let p = ifdStart + 2;
  for (let i = 0; i < numEntries; i++) {
    const t = buf[p] | (buf[p + 1] << 8);
    if (t === tag) {
      // value/offset is at p+8 .. p+11
      const v = u32(newValueOffset);
      buf[p + 8] = v[0];
      buf[p + 9] = v[1];
      buf[p + 10] = v[2];
      buf[p + 11] = v[3];
      return;
    }
    p += 12;
  }
  throw new Error(`Failed to patch IFD tag ${tag}`);
}

function makePattern(width, height, spp, layout) {
  // deterministic tiny values:
  // v = (x + 10*y + 50*c) % 256
  const n = width * height;
  if (layout === "chunky") {
    const out = new Uint8Array(n * spp);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        for (let c = 0; c < spp; c++) {
          out[i * spp + c] = (x + 10 * y + 50 * c) & 255;
        }
      }
    }
    return out;
  }

  // planar: planes back-to-back
  const out = new Uint8Array(n * spp);
  for (let c = 0; c < spp; c++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        out[c * n + i] = (x + 10 * y + 50 * c) & 255;
      }
    }
  }
  return out;
}

export function fixtureGray8({ width = 16, height = 16 } = {}) {
  const pixelBytes = makePattern(width, height, 1, "chunky"); // one band
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 1,
    bitsPerSampleArray: [8],
    photometric: 1, // BlackIsZero
    planarConfiguration: 1,
    pixelBytes,
    imageDescription: "fixture: gray8",
  });
}

export function fixtureRGB8Chunky({ width = 16, height = 16 } = {}) {
  const pixelBytes = makePattern(width, height, 3, "chunky");
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 3,
    bitsPerSampleArray: [8, 8, 8],
    photometric: 2, // RGB
    planarConfiguration: 1,
    pixelBytes,
    imageDescription: "fixture: rgb8 chunky",
  });
}

export function fixtureRGB8Planar({ width = 16, height = 16 } = {}) {
  const pixelBytes = makePattern(width, height, 3, "planar");
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 3,
    bitsPerSampleArray: [8, 8, 8],
    photometric: 2, // RGB
    planarConfiguration: 2, // planar
    pixelBytes,
    imageDescription: "fixture: rgb8 planar",
  });
}

// 4 channels, no PhotometricInterpretation tag => ambiguous; should infer "data" in auto,
// but can be forced to "image" via external format.
export function fixtureData4Ambiguous({ width = 16, height = 16 } = {}) {
  const pixelBytes = makePattern(width, height, 4, "chunky");
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 4,
    bitsPerSampleArray: [8, 8, 8, 8],
    photometric: undefined, // omitted on purpose
    planarConfiguration: 1,
    pixelBytes,
    imageDescription: "fixture: data4 ambiguous",
  });
}

/**
 * The 8-bit pattern value of a pixel: the base every deep fixture is derived from,
 * so an expectation can be written as a function of it.
 */
export function patternByte(x, y, c) {
  return (x + 10 * y + 50 * c) & 255;
}

/** Deep-sample pattern, chunky layout, little endian. `mapValue(byte) -> sample`. */
function makeTypedPattern(width, height, spp, Ctor, mapValue) {
  const out = new Ctor(width * height * spp);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      for (let c = 0; c < spp; c++) {
        out[i * spp + c] = mapValue(patternByte(x, y, c));
      }
    }
  }
  return new Uint8Array(out.buffer);
}

// 16-bit unsigned grayscale. sample = byte * 257, i.e. the 8-bit pattern stretched over
// the full 16-bit range, so the expected unit value is exactly byte / 255.
export function fixtureGray16({ width = 16, height = 16 } = {}) {
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 1,
    bitsPerSampleArray: [16],
    sampleFormatArray: [1],
    photometric: 1, // BlackIsZero
    planarConfiguration: 1,
    pixelBytes: makeTypedPattern(width, height, 1, Uint16Array, (b) => b * 257),
    imageDescription: "fixture: gray16",
  });
}

// 16-bit unsigned RGB -- the file the image path saturates to white today.
export function fixtureRGB16Chunky({ width = 16, height = 16 } = {}) {
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 3,
    bitsPerSampleArray: [16, 16, 16],
    sampleFormatArray: [1, 1, 1],
    photometric: 2, // RGB
    planarConfiguration: 1,
    pixelBytes: makeTypedPattern(width, height, 3, Uint16Array, (b) => b * 257),
    imageDescription: "fixture: rgb16 chunky",
  });
}

// 16-bit signed grayscale. sample = (byte - 128) * 256, so unit = sample / 32767.
export function fixtureGrayInt16({ width = 16, height = 16 } = {}) {
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 1,
    bitsPerSampleArray: [16],
    sampleFormatArray: [2], // signed int
    photometric: 1,
    planarConfiguration: 1,
    pixelBytes: makeTypedPattern(width, height, 1, Int16Array, (b) => (b - 128) * 256),
    imageDescription: "fixture: int16 gray",
  });
}

// float32 grayscale in [0,1] with no SMin/SMax -- the file the image path renders black today.
export function fixtureGrayFloat32({ width = 16, height = 16 } = {}) {
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 1,
    bitsPerSampleArray: [32],
    sampleFormatArray: [3], // float
    photometric: 1,
    planarConfiguration: 1,
    pixelBytes: makeTypedPattern(width, height, 1, Float32Array, (b) => b / 255),
    imageDescription: "fixture: float32 gray",
  });
}

// float32 grayscale measured over [-1, 3], declared via SMinSampleValue/SMaxSampleValue.
export function fixtureGrayFloat32Ranged({ width = 16, height = 16 } = {}) {
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 1,
    bitsPerSampleArray: [32],
    sampleFormatArray: [3],
    sMinSampleValue: [-1],
    sMaxSampleValue: [3],
    photometric: 1,
    planarConfiguration: 1,
    pixelBytes: makeTypedPattern(width, height, 1, Float32Array, (b) => (b / 255) * 4 - 1),
    imageDescription: "fixture: float32 gray ranged",
  });
}

// SampleFormat 4 (undefined data) -- must be rejected rather than silently mis-rendered.
export function fixtureGrayUndefinedFormat({ width = 16, height = 16 } = {}) {
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 1,
    bitsPerSampleArray: [8],
    sampleFormatArray: [4],
    photometric: 1,
    planarConfiguration: 1,
    pixelBytes: makePattern(width, height, 1, "chunky"),
    imageDescription: "fixture: undefined sample format",
  });
}

export function fixtureData6({ width = 16, height = 16 } = {}) {
  const pixelBytes = makePattern(width, height, 6, "chunky");
  return buildTIFF({
    width,
    height,
    samplesPerPixel: 6,
    bitsPerSampleArray: [8, 8, 8, 8, 8, 8],
    photometric: undefined, // omitted => data
    planarConfiguration: 1,
    pixelBytes,
    imageDescription: "fixture: data6",
  });
}