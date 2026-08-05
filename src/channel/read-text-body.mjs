/**
 * Accumulate IncomingMessage bodies as UTF-8 text with a byte-length cap (not char length).
 */

const DEFAULT_MAX = 2 * 1024 * 1024;

/**
 * @param {import("http").IncomingMessage} req
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string>}
 */
export function readTextBody(req, opts = {}) {
  const maxBytes =
    typeof opts.maxBytes === "number" && opts.maxBytes > 0
      ? opts.maxBytes
      : DEFAULT_MAX;
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
        settle(() => reject(new Error("body too large")));
        if (typeof req.destroy === "function") req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      settle(() => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", (err) => {
      settle(() => reject(err));
    });
  });
}
