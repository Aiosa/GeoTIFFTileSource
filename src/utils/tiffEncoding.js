/**
 * Sample encoding: the single, declared contract for what the numbers handed to a
 * consumer (GPU pack or RGBA8 byte) actually mean.
 *
 * Every component produced by this library is normalized to [0,1] (or [-1,1] for
 * signed sample formats) using a per-channel `scale`/`offset` derived only from
 * TIFF tags. Nothing is lost by always normalizing: binary16 carries ~11 significant
 * bits regardless of magnitude, and normalizing is what makes the RGBA8 fallback
 * banded-but-correct instead of clamped-to-white.
 *
 * This module is imported by the worker, by the RawTiffPlugin main-thread path and
 * by the tile source, so decoder and client cannot disagree about the same file.
 */

/** Version stamped on every produced texture set. Bump only on a contract change. */
export const SAMPLE_ENCODING_VERSION = 1;

/** Photometric interpretation constants (TIFF spec / geotiff.js). */
export const PHOTOMETRIC = {
  WhiteIsZero: 0,
  BlackIsZero: 1,
  RGB: 2,
  Palette: 3,
  TransparencyMask: 4,
  CMYK: 5,
  YCbCr: 6,
  CIELab: 8,
};

/** SampleFormat tag (339) values. */
export const SAMPLE_FORMAT = {
  UINT: 1,
  INT: 2,
  FLOAT: 3,
  UNDEFINED: 4,
  COMPLEX_INT: 5,
  COMPLEX_FLOAT: 6,
};

/**
 * Read `value[index]`, falling back to `value[0]` for short arrays and accepting scalars.
 * TIFF readers hand these tags back as arrays, single numbers or not at all.
 */
function pickTagValue(value, index, fallback) {
  if (value === null || value === undefined) return fallback;
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length === 0) return fallback;
    const v = index < value.length ? value[index] : value[0];
    return v === null || v === undefined ? fallback : v;
  }
  return value;
}

/**
 * Extract the SMinSampleValue / SMaxSampleValue tags (340/341) from a file directory.
 *
 * @param {Object} [fileDirectory]
 * @returns {{sMinSampleValue: (number[]|null), sMaxSampleValue: (number[]|null)}}
 */
export function readSampleRangeTags(fileDirectory) {
  const fd = fileDirectory || {};
  const toArray = (v) => {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.length ? v : null;
    if (ArrayBuffer.isView(v)) return v.length ? Array.from(v) : null;
    return [v];
  };
  return {
    sMinSampleValue: toArray(fd.SMinSampleValue),
    sMaxSampleValue: toArray(fd.SMaxSampleValue),
  };
}

/**
 * Declared range of a channel, or null when the tags are absent or unusable.
 *
 * The tags are validated rather than trusted: a wrong SMax must not be able to produce a
 * worse render than no SMax at all. Rejected are a non-finite pair, an empty or inverted
 * range, a single tag on its own (one bound says nothing about a range), and -- for
 * integers -- a range reaching outside what the declared bit depth can hold. Each of
 * those means the writer disagreed with itself, and the container range is then the safer
 * of the two answers.
 *
 * Acceptance is all-or-nothing: a partially applied range would shift a plane without
 * rescaling it, which is worse than either alternative.
 *
 * @param {Object} d descriptor passed to {@link resolveSampleEncoding}
 * @param {number} index channel index
 * @param {number|null} limitLow lowest value the container can hold, null for float
 * @param {number|null} limitHigh highest value the container can hold, null for float
 * @returns {{min: number, max: number}|null}
 */
function declaredRange(d, index, limitLow, limitHigh) {
  const min = pickTagValue(d.sMinSampleValue, index, null);
  const max = pickTagValue(d.sMaxSampleValue, index, null);
  if (min === null || max === null) return null;

  const lo = Number(min);
  const hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null;

  if (limitLow !== null && (lo < limitLow || hi > limitHigh)) return null;

  return { min: lo, max: hi };
}

/** Container bounds of an integer channel, which its declared range must fit inside. */
function integerLimits(bits, isSigned) {
  return isSigned
    ? [-Math.pow(2, bits - 1), Math.pow(2, bits - 1) - 1]
    : [0, Math.pow(2, bits) - 1];
}

/**
 * @typedef {Object} ChannelEncoding
 * @property {number} scale   Divisor applied to the raw sample.
 * @property {number} offset  Subtracted from the raw sample before dividing.
 * @property {boolean} signed Whether the normalized range is [-1,1] rather than [0,1].
 * @property {number} bits    BitsPerSample for this channel.
 * @property {number} sampleFormat SampleFormat for this channel.
 */

/**
 * @typedef {Object} SampleEncoding
 * @property {number} version
 * @property {ChannelEncoding[]} channels
 */

/**
 * Resolve the declared encoding of every channel of a TIFF plane.
 *
 * A usable SMinSampleValue/SMaxSampleValue pair always wins, whatever the sample format:
 *
 *   any format, valid SMin/SMax -> scale = SMax - SMin,  offset = SMin
 *   SampleFormat 1 (uint)       -> scale = 2^b - 1,      offset = 0
 *   SampleFormat 2 (int)        -> scale = 2^(b-1) - 1,  offset = 0, signed
 *   SampleFormat 3 (float)      -> identity, signed
 *   SampleFormat 4/5/6          -> throws
 *
 * Honouring those tags on the INTEGER branches is what makes sub-container depths render:
 * 10/12/14-bit sensors are stored as `BitsPerSample=16`, which is how essentially every
 * scientific and clinical camera writes them, and normalizing such a plane against 65535
 * renders it at a sixteenth of its intended brightness. See {@link declaredRange} for
 * what makes a pair usable.
 *
 * `signed` reports whether the NORMALIZED range is [-1,1] rather than [0,1], so a
 * declared range always clears it: mapping through [SMin, SMax] lands in [0,1] no matter
 * how the samples were stored.
 *
 * What this deliberately does NOT do is look at pixels. A file that merely *happens* to
 * use little of its declared range is indistinguishable from a dim scene, and guessing
 * from samples would make `scale` depend on which tiles decoded first, bake that guess
 * into the tile cache, and destroy the one property this module promises: that a
 * normalized value means the same thing everywhere in the pyramid. Recovering those
 * files is a display-side concern (window/level), not a decode-side one.
 *
 * @param {Object} desc
 * @param {number[]|number} [desc.bitsPerSample]
 * @param {number[]|number|null} [desc.sampleFormat]
 * @param {number[]|null} [desc.sMinSampleValue]
 * @param {number[]|null} [desc.sMaxSampleValue]
 * @param {number} [desc.samplesPerPixel]
 * @returns {SampleEncoding}
 */
export function resolveSampleEncoding(desc) {
  const d = desc || {};
  const bitsPerSample = d.bitsPerSample;
  const sampleFormat = d.sampleFormat;

  let count = d.samplesPerPixel;
  if (!(count > 0)) {
    count = Array.isArray(bitsPerSample) || ArrayBuffer.isView(bitsPerSample)
      ? bitsPerSample.length
      : 1;
  }
  count = Math.max(1, count | 0);

  const channels = [];
  for (let i = 0; i < count; i++) {
    const bits = pickTagValue(bitsPerSample, i, 8) || 8;
    // A missing or zero SampleFormat means "unsigned integer" per the TIFF spec.
    const sampleFormatValue = pickTagValue(sampleFormat, i, SAMPLE_FORMAT.UINT) || SAMPLE_FORMAT.UINT;

    let scale;
    let offset = 0;
    let signed = false;

    switch (sampleFormatValue) {
      case SAMPLE_FORMAT.UINT: {
        const declared = declaredRange(d, i, ...integerLimits(bits, false));
        if (declared) {
          scale = declared.max - declared.min;
          offset = declared.min;
        } else {
          scale = Math.pow(2, bits) - 1;
        }
        break;
      }
      case SAMPLE_FORMAT.INT: {
        const declared = declaredRange(d, i, ...integerLimits(bits, true));
        if (declared) {
          // A declared range maps onto [0,1], so the plane is no longer bipolar and
          // `signed` must say so -- it describes the *normalized* range, not the
          // storage type.
          scale = declared.max - declared.min;
          offset = declared.min;
        } else {
          scale = Math.pow(2, bits - 1) - 1;
          signed = true;
        }
        break;
      }
      case SAMPLE_FORMAT.FLOAT: {
        // Same rule as the integer branches, minus the container bounds -- a float has
        // none. Without a usable range the file is taken at its word: identity transform,
        // and the values may be negative.
        const declared = declaredRange(d, i, null, null);
        if (declared) {
          scale = declared.max - declared.min;
          offset = declared.min;
        } else {
          scale = 1;
          signed = true;
        }
        break;
      }
      default:
        throw new Error(
          `[RawTiffPlugin] Unsupported SampleFormat ${sampleFormatValue} on channel ${i}; ` +
          "only 1 (unsigned int), 2 (signed int) and 3 (float) are supported."
        );
    }

    if (!(scale > 0)) scale = 1;
    channels.push({ scale, offset, signed, bits, sampleFormat: sampleFormatValue });
  }

  return { version: SAMPLE_ENCODING_VERSION, channels };
}

/** Encoding of a channel, falling back to the first one for short descriptors. */
export function channelEncodingAt(encoding, index) {
  const channels = (encoding && encoding.channels) || [];
  if (!channels.length) return { scale: 1, offset: 0, signed: false, bits: 8, sampleFormat: 1 };
  return channels[index] != null ? channels[index] : channels[0];
}

/**
 * Raw sample -> declared unit range: [0,1] unsigned, [-1,1] signed.
 * @param {number} value
 * @param {ChannelEncoding} ch
 * @returns {number}
 */
export function sampleToUnit(value, ch) {
  if (value === null || value === undefined) return 0;
  const v = Number(value);
  if (Number.isNaN(v)) return 0;
  return (v - ch.offset) / ch.scale;
}

/**
 * Raw sample -> display byte. The shared definition of "tone mapping" for both the
 * worker image path and the main-thread CPU renderer.
 * @param {number} value
 * @param {ChannelEncoding} ch
 * @returns {number}
 */
export function sampleToByte(value, ch) {
  const unit = sampleToUnit(value, ch);
  if (unit <= 0) return 0;
  if (unit >= 1) return 255;
  return Math.round(unit * 255);
}

/** True when the channel is a plain 8-bit integer, i.e. already display-ready. */
export function isDisplayReadyChannel(ch) {
  return ch.bits === 8 &&
    (ch.sampleFormat === SAMPLE_FORMAT.UINT || ch.sampleFormat === SAMPLE_FORMAT.INT);
}

/**
 * Decide whether a plane is a picture or measurements.
 *
 * "image" requires BOTH a photometric interpretation that implies a picture AND every
 * selected band being 8-bit integer -- the image path builds an 8-bit RGBA buffer, so
 * anything deeper is destroyed by it (16-bit RGB saturates to white, float32 grayscale
 * renders black).
 *
 * Palette is exempt from the bit-depth test, but only with a ColorMap present: a LUT is
 * inherently a display transform and is indexed by the RAW sample at any bit depth (a
 * 16-bit palette has 3 * 65536 ColorMap entries). A palette file MISSING its LUT is not
 * renderable as an image at all, so it falls through to the normal test and keeps its
 * precision on the data path.
 *
 * @param {Object} desc
 * @param {number} [desc.photometricInterpretation]
 * @param {number} [desc.samplesPerPixel]
 * @param {boolean} [desc.hasColorMap]
 * @param {SampleEncoding} desc.encoding
 * @param {number[]} [selectedChannels] band indices actually used (defaults to all)
 * @returns {"image"|"data"}
 */
export function inferInterpretation(desc, selectedChannels) {
  const d = desc || {};
  const pi = d.photometricInterpretation;
  const encoding = d.encoding;

  if (pi === PHOTOMETRIC.Palette && d.hasColorMap) return "image";

  const spp = d.samplesPerPixel || (encoding && encoding.channels.length) || 1;
  const photometricIsImage =
    pi === PHOTOMETRIC.RGB ||
    pi === PHOTOMETRIC.YCbCr ||
    pi === PHOTOMETRIC.CMYK ||
    pi === PHOTOMETRIC.CIELab ||
    ((pi === PHOTOMETRIC.BlackIsZero || pi === PHOTOMETRIC.WhiteIsZero) && spp === 1);

  if (!photometricIsImage) return "data";

  const used = Array.isArray(selectedChannels) && selectedChannels.length
    ? selectedChannels.filter((c) => c !== null && c !== undefined && c >= 0)
    : encoding.channels.map((_, i) => i);

  const allDisplayReady = used.every((c) => isDisplayReadyChannel(channelEncodingAt(encoding, c)));
  return allDisplayReady ? "image" : "data";
}
