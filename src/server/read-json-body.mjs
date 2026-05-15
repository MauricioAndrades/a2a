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
            const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
            total += buf.length;
            if (total > maxBytes) {
                if (typeof req.destroy === "function") req.destroy();
                settle(() => reject(new Error("request body too large")));
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
