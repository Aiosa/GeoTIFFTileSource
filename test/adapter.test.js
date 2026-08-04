import { describe, expect, it } from "vitest";
import OpenSeadragon from "openseadragon";
import { enableGeoTIFFTileSource } from "../src/main.js";
import { transportMark, withTransportCause } from "../src/utils/httpAdapterClient.js";
import { fixtureGray8 } from "./data/tiff-fixtures.js";

function parseRange(headerValue) {
  const m = /bytes=(\d+)-(\d+)/.exec(headerValue || "");
  if (!m) return null;
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
}

/**
 * A range-serving adapter over an in-memory TIFF, recording every call it sees.
 * `calls` is the assertion surface: url, parsed Range, and the forwarded AbortSignal.
 *
 * @param {ArrayBuffer} buffer
 * @param {Object} [opts]
 * @param {Function} [opts.interfere] called as (call, index) before each response is
 *   built. Return an Error to throw it, or a Response to send instead. Lets a test fail
 *   a specific request -- the header probe, or only a later tile read.
 * @param {Boolean} [opts.captureErrorBody] forwarded onto the adapter object.
 */
function recordingAdapter(buffer, { interfere = null, captureErrorBody } = {}) {
  const bytes = new Uint8Array(buffer);
  const calls = [];

  const httpAdapter = {
    async fetch(url, init) {
      const headers = init?.headers ?? {};
      const range = parseRange(headers.Range);
      const call = { url, range, signal: init?.signal ?? null };
      calls.push(call);

      const injected = interfere && interfere(call, calls.length - 1);
      if (injected instanceof Error) throw injected;
      if (injected) return injected;

      if (!range) {
        return new Response(bytes.slice(), {
          status: 200,
          headers: { "Content-Type": "image/tiff" },
        });
      }

      const start = Math.min(range.start, bytes.length);
      const end = Math.min(range.end + 1, bytes.length);
      return new Response(bytes.slice(start, end), {
        status: 206,
        headers: {
          "Content-Type": "image/tiff",
          "Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`,
        },
      });
    },
  };
  if (captureErrorBody !== undefined) httpAdapter.captureErrorBody = captureErrorBody;

  return { calls, bytes, httpAdapter };
}

/** Await a rejection and hand back the error, so its fields can be asserted. */
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** A private OpenSeadragon copy, so installing an adapter cannot leak between tests. */
const isolatedOSD = () => Object.assign(Object.create(OpenSeadragon), OpenSeadragon);

describe("httpAdapter injection", () => {
  it("routes all geotiff range requests through the supplied adapter", async () => {
    const { httpAdapter, calls } = recordingAdapter(fixtureGray8({ width: 32, height: 32 }));

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const url = "https://adapter-test.invalid/sample.tif";
    const tileSource = new OSD.GeoTIFFTileSource(url, { GeoTIFFOptions: {} });

    const tiff = await tileSource.promises.GeoTIFF;
    expect(tiff).toBeTruthy();

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === url)).toBe(true);
    expect(calls.some((c) => c.range !== null)).toBe(true);
  });

  it("routes tile reads, not just the header probe, and forwards the abort signal", async () => {
    // Larger than geotiff.js's 64KB block: header parsing reads the first and last blocks,
    // so the pixel read in the middle cannot be served from cache and must hit the adapter.
    const { httpAdapter, calls } = recordingAdapter(fixtureGray8({ width: 512, height: 512 }));

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const url = "https://adapter-test.invalid/tiles.tif";
    const tileSource = new OSD.GeoTIFFTileSource(url, { GeoTIFFOptions: {} });
    await tileSource.promises.ready.promise;

    const headerCalls = calls.length;
    calls.length = 0;

    const controller = new AbortController();
    const raster = await tileSource.regionToTiffRaster(
      tileSource.levels[tileSource.maxLevel], 0, 0, controller.signal
    );

    expect(headerCalls).toBeGreaterThan(0);
    expect(raster.width).toBeGreaterThan(0);
    // Pixel data came through the adapter too -- an adapter that only saw the header
    // would leave auth off every tile request.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === url)).toBe(true);
    // geotiff.js threads its own signal through; without forwarding it,
    // downloadTileAbort() cannot cancel anything.
    expect(calls.every((c) => c.signal != null)).toBe(true);
  });

  it("lets an options-object config outrank the constructor's own defaults", async () => {
    // The OSD autodetect path constructs with ONE argument -- configure()'s object -- so
    // anything defaulted through the second parameter would silently overrule the config.
    const { httpAdapter } = recordingAdapter(fixtureGray8({ width: 32, height: 32 }));

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const url = "https://adapter-test.invalid/configured.tif";
    const source = new OSD.GeoTIFFTileSource({
      url,
      logLatency: true,
      format: { interpretation: "data" },
    });
    await source.promises.ready.promise;

    expect(source.options.logLatency).toBe(true);
    expect(source.format).toEqual({ interpretation: "data" });
    expect(source.url).toBe(url);
    expect(source.width).toBe(32);
  });

  it("opens a header through openGeoTIFF() using the same adapter", async () => {
    const { httpAdapter, calls } = recordingAdapter(fixtureGray8({ width: 32, height: 32 }));

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const url = "https://adapter-test.invalid/header.tif";
    const tiff = await OSD.GeoTIFFTileSource.openGeoTIFF(url);
    const image = await tiff.getImage(0);

    expect(image.getWidth()).toBe(32);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === url)).toBe(true);
  });

  it("rejects an adapter that does not return a Response-like object", async () => {
    let called = false;
    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, {
      httpAdapter: {
        async fetch() { called = true; return { status: 206, body: "nope" }; },
      },
    });

    const source = new OSD.GeoTIFFTileSource("https://adapter-test.invalid/bad.tif");
    const err = await rejection(source.promises.ready.promise);

    // Without the shape check plus cause preservation this arrives as
    // "Request failed" -- a TypeError on `res.headers`, laundered by geotiff.js.
    expect(err.message).toMatch(/Response-like/);
    expect(called).toBe(true);
    expect(source.ready).toBe(false);
  });

  it("reports a transport failure as open-failed, with the adapter's own message", async () => {
    const thrown = new Error("403 from proxy");
    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, {
      httpAdapter: { async fetch() { throw thrown; } },
    });

    const source = new OSD.GeoTIFFTileSource("https://adapter-test.invalid/denied.tif");
    const failures = [];
    source.addHandler("open-failed", (e) => failures.push(e.message));

    const err = await rejection(source.promises.ready.promise);

    // geotiff.js discards this twice over: RemoteSource drops the status, then
    // BlockedSource throws AggregateError([undefined], "Request failed"). An app that
    // added auth through the adapter needs to tell an expired token from a missing file.
    expect(err.name).toBe("GeoTIFFTransportError");
    expect(err.message).toMatch(/403 from proxy/);
    expect(err.cause).toBe(thrown);
    expect(err.url).toBe("https://adapter-test.invalid/denied.tif");
    expect(err.status).toBe(null); // the adapter threw rather than responding
    expect(err.geotiffError).toBeTruthy(); // the opaque original, kept not discarded

    expect(source.ready).toBe(false);
    // OSD's waitUntilReady rejects the viewer's open() promise off this event alone --
    // without it a failed source waits forever.
    expect(failures).toEqual([expect.stringContaining("403 from proxy")]);
  });

  it("names the status when the adapter responds with a non-2xx", async () => {
    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, {
      httpAdapter: {
        async fetch() {
          return new Response("token expired", { status: 401 });
        },
      },
    });

    const source = new OSD.GeoTIFFTileSource("https://adapter-test.invalid/401.tif");
    const err = await rejection(source.promises.ready.promise);

    expect(err.name).toBe("GeoTIFFTransportError");
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/HTTP 401/);
    // The body is NOT echoed unless the caller opts in.
    expect(err.message).not.toMatch(/token expired/);
  });

  it("echoes the error body only when captureErrorBody is set", async () => {
    const serve401 = () => new Response("token expired", { status: 401 });

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, {
      httpAdapter: { fetch: async () => serve401(), captureErrorBody: true },
    });

    const err = await rejection(
      new OSD.GeoTIFFTileSource("https://adapter-test.invalid/body.tif").promises.ready.promise
    );

    expect(err.status).toBe(401);
    expect(err.message).toMatch(/HTTP 401/);
    expect(err.message).toMatch(/token expired/);
  });

  it("carries the cause on a tile read, not just the header probe", async () => {
    // Header succeeds, the pixel read does not. 512x512 exceeds geotiff.js's 64KB
    // block, so the read cannot be served from what header parsing already cached.
    let allowFailure = false;
    const { httpAdapter } = recordingAdapter(fixtureGray8({ width: 512, height: 512 }), {
      interfere: () => (allowFailure ? new Error("tile 502 from proxy") : null),
    });

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const source = new OSD.GeoTIFFTileSource("https://adapter-test.invalid/tilefail.tif");
    await source.promises.ready.promise;

    allowFailure = true;
    const err = await rejection(source.regionToTiffRaster(
      source.levels[source.maxLevel], 0, 0, new AbortController().signal
    ));

    expect(err.name).toBe("GeoTIFFTransportError");
    expect(err.message).toMatch(/tile 502 from proxy/);
  });

  it("does not report an aborted tile as a transport failure", async () => {
    const { httpAdapter } = recordingAdapter(fixtureGray8({ width: 512, height: 512 }), {
      interfere: (call) => {
        if (!call.signal || !call.signal.aborted) return null;
        const abort = new Error("Request was aborted");
        abort.name = "AbortError";
        return abort;
      },
    });

    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD, { httpAdapter });

    const source = new OSD.GeoTIFFTileSource("https://adapter-test.invalid/abort.tif");
    await source.promises.ready.promise;

    const controller = new AbortController();
    const pending = source.regionToTiffRaster(
      source.levels[source.maxLevel], 0, 0, controller.signal
    );
    controller.abort();

    const err = await rejection(pending);
    // downloadTileAbort() causes these on purpose -- reporting one as a proxy error
    // would be a lie, and would surface a bogus message on every fast pan.
    expect(err.name).not.toBe("GeoTIFFTransportError");
  });

  it("falls back to fromUrl when no adapter is provided (default fetch path)", () => {
    const OSD = isolatedOSD();
    enableGeoTIFFTileSource(OSD);
    expect(OSD.GeoTIFFTileSource).toBeDefined();
  });
});

describe("withTransportCause", () => {
  const fakeClient = (failures, lastFailure) => ({
    url: "https://adapter-test.invalid/x.tif",
    failures,
    lastFailure,
  });

  it("attaches only a failure recorded after the mark", () => {
    const stale = Object.assign(new Error("403 from an earlier request"), { status: 403 });
    const client = fakeClient(1, stale);

    // One client serves every request for a url. A failure that was already on the
    // record when this operation began says nothing about why THIS one failed.
    const mark = transportMark(client); // 1
    const opaque = new Error("Request failed");
    expect(withTransportCause(client, mark, opaque)).toBe(opaque);

    // ...but once this operation records its own, that one is the cause.
    client.failures = 2;
    client.lastFailure = Object.assign(new Error("503 now"), { status: 503 });
    const enriched = withTransportCause(client, mark, opaque);
    expect(enriched).not.toBe(opaque);
    expect(enriched.name).toBe("GeoTIFFTransportError");
    expect(enriched.message).toBe("503 now");
    expect(enriched.status).toBe(503);
    expect(enriched.geotiffError).toBe(opaque);
  });

  it("passes an error through untouched when there is no client or no failure", () => {
    const error = new Error("Server responded with full file");
    // No adapter configured at all.
    expect(withTransportCause(null, 0, error)).toBe(error);
    // An adapter that never failed -- geotiff.js raised this on its own, and its
    // wording is the more useful of the two.
    expect(withTransportCause(fakeClient(0, null), 0, error)).toBe(error);
  });
});
