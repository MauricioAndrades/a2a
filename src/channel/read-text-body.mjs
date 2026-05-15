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
    const maxBytes = typeof opts.maxBytes === "number" && opts.maxBytes > 0 ? opts.maxBytes : DEFAULT_MAX;
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (c) => {
            total += Buffer.byteLength(c);
            if (total > maxBytes) {
                if (typeof req.destroy === "function") req.destroy();
                reject(new Error("body too large"));
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
