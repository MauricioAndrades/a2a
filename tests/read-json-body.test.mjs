import { test } from "vitest";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { readJsonBody } from "../src/server/read-json-body.mjs";

async function withJsonServer(handler) {
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

async function sendChunkedJsonRequest(port, chunks) {
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        headers: { "content-type": "application/json" },
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

test("readJsonBody parses UTF-8 object across chunk boundaries", async () => {
  const json = '{"x":"🙂"}';
  const bytes = Buffer.from(json, "utf8");
  const mid = Math.ceil(bytes.length / 2);
  const runtime = await withJsonServer(async (req, res) => {
    const body = await readJsonBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  try {
    const response = await sendChunkedJsonRequest(runtime.port, [
      bytes.subarray(0, mid),
      bytes.subarray(mid),
    ]);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), { x: "🙂" });
  } finally {
    await runtime.close();
  }
});

test("readJsonBody enforces byte cap (not UTF-16 code-unit length)", async () => {
  /** Two-byte UTF-8 chars: JS .length counts 1 each but bytes are 2 — cap uses Buffer byte length */
  const payload = `{"a":"${"\u00a3".repeat(51)}"}`;
  assert.ok(Buffer.byteLength(payload, "utf8") > 100);
  const runtime = await withJsonServer(async (req, res) => {
    try {
      await readJsonBody(req, 100);
      res.writeHead(200).end("ok");
    } catch (error) {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end(error.message);
    }
  });
  try {
    const response = await sendChunkedJsonRequest(runtime.port, [
      Buffer.from(payload, "utf8"),
    ]);
    assert.equal(response.statusCode, 413);
    assert.match(response.body, /too large/);
  } finally {
    await runtime.close();
  }
});

test("readJsonBody tags oversize rejections with code 413 for HTTP handlers", async () => {
  /**
   * Handlers answer `error.code ?? 400`; without the 413 tag the bridge
   * returned 400 for oversize bodies while the channel transport returned
   * 413 for the same condition.
   */
  const runtime = await withJsonServer(async (req, res) => {
    try {
      await readJsonBody(req, 8);
      res.writeHead(200).end("resolved");
    } catch (error) {
      res.writeHead(error?.code ?? 400, { "content-type": "text/plain" });
      res.end(error.message);
    }
  });
  try {
    const response = await sendChunkedJsonRequest(runtime.port, [
      Buffer.from('"0123456789abcdef"'),
    ]);
    assert.equal(response.statusCode, 413);
    assert.match(response.body, /request body too large/);
  } finally {
    await runtime.close();
  }
});

test("readJsonBody does not resolve after oversize reject even when end fires", async () => {
  const runtime = await withJsonServer(async (req, res) => {
    try {
      await readJsonBody(req, 8);
      res.writeHead(200).end("resolved");
    } catch (error) {
      res.writeHead(413, { "content-type": "text/plain" });
      res.end(error.message);
    }
  });
  try {
    const response = await sendChunkedJsonRequest(runtime.port, [
      Buffer.from('"123456789"'),
    ]);
    assert.equal(response.statusCode, 413);
    assert.match(response.body, /request body too large/);
  } finally {
    await runtime.close();
  }
});
