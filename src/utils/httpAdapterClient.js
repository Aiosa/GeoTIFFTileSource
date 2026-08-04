/**
 * The transport a configured `httpAdapter` drives, plus the machinery that keeps a
 * failure's cause alive long enough to reach the application.
 *
 * geotiff.js destroys that cause twice on this path:
 *
 *  1. `RemoteSource.fetchSlice` turns any non-ok response into a bare
 *     `Error("Error fetching data.")` -- the status code is gone, so a 401 and a 503
 *     are indistinguishable.
 *  2. `BlockedSource.fetch` awaits its per-block promises with `Promise.allSettled`
 *     and never reads `.reason`, then throws `AggregateError(failedBlocks,
 *     "Request failed")` where `failedBlocks` is an array of `undefined`.
 *
 * By the time an error reaches a tile source there is nothing left to report but the
 * string "Request failed" -- useless for exactly the case an httpAdapter exists to
 * serve, since an app that added auth cannot tell an expired token from a missing file.
 *
 * The client below is the last place that still holds the truth: it sees what the
 * adapter threw, and it sees the response before RemoteSource flattens it. So it
 * records failures, and {@link withTransportCause} re-attaches them where an error
 * finally surfaces.
 */

import { BaseClient, BaseResponse } from "geotiff";

/**
 * Key under which a resolved GeoTIFF carries the client that loaded it, so a later
 * tile read can find the same failure log. A Symbol so it cannot collide with a
 * geotiff.js field and is never serialized.
 */
export const HTTP_CLIENT = Symbol("geoTiffTileSourceHttpClient");

/** Longest error body echoed into a message when captureErrorBody is enabled. */
const MAX_BODY_CHARS = 200;

/**
 * Build the error for a response the server refused, optionally echoing its body.
 *
 * The body is opt-in and off by default on purpose: error bodies routinely carry
 * tokens, internal hostnames and user data, and this message ends up in console logs
 * and in the `open-failed` event payload, which application code may display or ship
 * to telemetry. Turning it on is the caller's explicit decision.
 *
 * @param {number} status
 * @param {string} url
 * @param {*} res the raw value the adapter returned
 * @param {boolean} captureBody
 * @returns {Promise<Error>}
 */
async function httpError(status, url, res, captureBody) {
  let detail = "";
  if (captureBody && res && typeof res.clone === "function") {
    try {
      // Cloned so geotiff.js can still read the body afterwards, in the case where a
      // caller treats some non-2xx status as readable.
      const text = await res.clone().text();
      const collapsed = String(text).replace(/\s+/g, " ").trim();
      if (collapsed) {
        detail = collapsed.length > MAX_BODY_CHARS
          ? `: ${collapsed.slice(0, MAX_BODY_CHARS)}...`
          : `: ${collapsed}`;
      }
    } catch {
      // An unreadable or already-consumed body must not replace the status we do know.
    }
  }

  const error = new Error(`[GeoTIFFTileSource] HTTP ${status} for ${url}${detail}`);
  error.status = status;
  return error;
}

/**
 * The client class for a configured adapter, or null when there is no adapter.
 *
 * @param {{fetch: Function, captureErrorBody?: boolean}} [httpAdapter]
 * @returns {(typeof BaseClient)|null}
 */
export function makeAdapterClientCtor(httpAdapter) {
  if (!httpAdapter) return null;

  class AdapterResponse extends BaseResponse {
    constructor(res) {
      super();
      // Checked here rather than left to fail somewhere inside geotiff.js: a
      // duck-typed return value is the likeliest adapter mistake, and the error it
      // produces four frames deeper names none of this.
      if (!res || typeof res.arrayBuffer !== "function" ||
          !res.headers || typeof res.headers.get !== "function") {
        throw new Error(
          "[GeoTIFFTileSource] httpAdapter.fetch must resolve to a Response-like " +
          "object exposing status, headers.get(name) and arrayBuffer()."
        );
      }
      this.res = res;
    }
    get status()    { return this.res.status; }
    getHeader(name) { return this.res.headers.get(name); }
    async getData() { return this.res.arrayBuffer(); }
  }

  return class AdapterClient extends BaseClient {
    constructor(url) {
      super(url);
      /** Number of transport failures seen. Only ever increases -- see transportMark. */
      this.failures = 0;
      /** The most recent one. */
      this.lastFailure = null;
    }

    async request({ headers, signal } = {}) {
      let res;
      try {
        res = await httpAdapter.fetch(this.url, { headers, signal });
      } catch (err) {
        // An abort is not a transport failure: downloadTileAbort() causes these on
        // purpose, and reporting one as a proxy error would be a lie.
        if (!err || err.name !== "AbortError") this.record(err);
        throw err;
      }

      let response;
      try {
        response = new AdapterResponse(res);
      } catch (err) {
        this.record(err);
        throw err;
      }

      if (!response.ok) {
        // Recorded, not thrown. RemoteSource turns a non-ok response into its own
        // generic error one frame later, and that is the error withTransportCause()
        // will replace -- throwing here instead would only change which opaque
        // message geotiff.js ends up wrapping.
        this.record(await httpError(
          response.status, this.url, res, httpAdapter.captureErrorBody === true
        ));
      }

      return response;
    }

    /** @param {*} error */
    record(error) {
      this.failures += 1;
      this.lastFailure = error instanceof Error ? error : new Error(String(error));
    }
  };
}

/**
 * Snapshot a client's failure count before an operation, so a failure recorded during
 * it can be told apart from one that was already there.
 *
 * @param {*} client
 * @returns {number}
 */
export function transportMark(client) {
  return client ? client.failures : 0;
}

/**
 * Replace an opaque geotiff.js error with the transport failure that actually caused
 * it, if one was recorded since `mark`.
 *
 * The mark comparison is what makes the attribution safe: one client serves every
 * request for a url, so reporting `lastFailure` unconditionally would let a failure
 * from a long-finished operation be blamed for an unrelated later one.
 *
 * Not gated on recognising geotiff's own wording. A recorded transport failure is the
 * cause however geotiff phrased the symptom, and the original is kept on
 * `geotiffError` so nothing is lost either way. An error geotiff raises on its own --
 * "Server responded with full file", say -- records no failure and passes through
 * untouched.
 *
 * Caveat worth knowing: concurrent tile reads share one client, so `lastFailure` may
 * belong to a sibling request. It is still a real, recent failure against the same
 * url, which beats "Request failed" by any measure.
 *
 * @param {*} client
 * @param {number} mark value from {@link transportMark} taken before the operation
 * @param {*} error the error geotiff.js produced
 * @returns {*} the enriched error, or `error` unchanged
 */
export function withTransportCause(client, mark, error) {
  if (!client || client.failures <= mark || !client.lastFailure) return error;

  const failure = client.lastFailure;
  const enriched = new Error(failure.message, { cause: failure });
  enriched.name = "GeoTIFFTransportError";
  enriched.status = failure.status ?? null;
  enriched.url = client.url;
  enriched.geotiffError = error;
  return enriched;
}
