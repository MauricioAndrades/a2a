import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readTextBody } from "../src/channel/read-text-body.mjs";

async function withBodyServer(handler) {
  const server = createServer(handler);
  const port = await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : null);
    });
  });
  return {
    port,
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

async function sendChunkedRequest(port, chunks) {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
      },
      (res) => {
        const responseChunks = [];
        res.on("data", (chunk) => responseChunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(responseChunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    for (const chunk of chunks) {
      req.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    }
    req.end();
  });
}

test("readTextBody preserves UTF-8 across chunk boundaries", async () => {
  const smile = Buffer.from("🙂", "utf8");
  const a = smile.subarray(0, 2);
  const b = smile.subarray(2);
  const runtime = await withBodyServer(async (req, res) => {
    const body = await readTextBody(req);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  try {
    const response = await sendChunkedRequest(runtime.port, [a, b]);
    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "🙂");
  } finally {
    await runtime.close();
  }
});

test("readTextBody rejects when byte budget exceeded (bytes not code units)", async () => {
  const big = Buffer.alloc(64, "x");
  const runtime = await withBodyServer(async (req, res) => {
    try {
      await readTextBody(req, { maxBytes: 100 });
      res.writeHead(200).end("ok");
    } catch (error) {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end(error.message);
    }
  });
  try {
    await assert.rejects(
      () => sendChunkedRequest(runtime.port, [big, big]),
      /socket hang up/,
    );
  } finally {
    await runtime.close();
  }
});
