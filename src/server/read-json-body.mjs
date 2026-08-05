/**
 * Read and JSON-parse an IncomingMessage body with a byte cap (not JS string length).
 * Uses a single settlement guard so "end" cannot resolve after an oversize rejection.
 */

const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * @param {import("http").IncomingMessage} req
 * @param {number} [maxBytes]
 */
export function readJsonBody(req, maxBytes = DEFAULT_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    req.on("data", (c) => {
      if (settled) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
      total += buf.length;
      if (total > maxBytes) {
        // Tag the rejection so HTTP handlers can answer 413 Payload Too
        // Large (as this module's contract promises) instead of a generic
        // 400 — the channel transport (a2a-channel.mjs) already maps
        // oversize bodies to 413 and the bridge must agree.
        const oversize = Object.assign(new Error("request body too large"), {
          code: 413,
        });
        settle(() => reject(oversize));
        /**
         * Do NOT destroy the request: the handler awaiting this promise
         * needs the connection alive to write a 413 response. The
         * `settled` guard above swallows any further data events so we
         * neither grow `chunks` nor resolve after the rejection. The
         * server's natural backpressure stops reading once we stop
         * consuming. Calling req.destroy() here closes the underlying
         * socket and surfaces as a "socket hang up" on the client side
         * instead of the expected 413.
         */
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      settle(() => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (err) => settle(() => reject(err)));
  });
}
