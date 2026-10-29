import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { UnknownToolError } from "./tools.mjs";

// Stateless MCP revision 2026-07-28. This revision removes initialize/initialized
// and protocol-level sessions, carries protocol metadata per request in params._meta,
// requires a resultType on every result, and mirrors selected body fields into
// headers that the server must validate against the body.
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/index
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
//   https://modelcontextprotocol.io/specification/2026-07-28/server/tools
// SDK 1.29.0 negotiates only the initialize-era versions, so this layer answers
// the modern era directly instead of advertising a version the SDK cannot speak.
export const PROTOCOL_VERSION = "2026-07-28";

// Derived from the installed SDK rather than hand-listed, so the versions this
// endpoint claims to support stay true if the dependency changes.
export const LEGACY_PROTOCOL_VERSIONS = Object.freeze([...SUPPORTED_PROTOCOL_VERSIONS]);
export const SUPPORTED_VERSIONS = Object.freeze([PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS]);

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export const HEADER_MISMATCH = -32020;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
// The ChatGPT MCP Events guide requires -32015 for a callback endpoint failure.
// That code sits in the range the core spec marks legacy, so it is emitted only
// for this extension's documented case and never for core protocol errors.
export const CALLBACK_ENDPOINT_ERROR = -32015;

export const MODERN_ONLY_METHODS = Object.freeze([
  "server/discover", "events/list", "events/subscribe", "events/unsubscribe",
]);

const NAME_HEADER_METHODS = new Set(["tools/call", "resources/read", "prompts/get"]);
const BASE64_SENTINEL = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/;

export class RpcError extends Error {
  constructor(code, message, { data, httpStatus = 400 } = {}) {
    super(message);
    this.code = code;
    this.data = data;
    this.httpStatus = httpStatus;
  }
}

export function errorResponse(id, error) {
  const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
  const status = error instanceof RpcError ? error.httpStatus : 500;
  const body = {
    jsonrpc: "2.0",
    ...(id === undefined || id === null ? {} : { id }),
    error: {
      code,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof RpcError && error.data !== undefined ? { data: error.data } : {}),
    },
  };
  return { status, body };
}

export function decodeHeaderValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  const sentinel = BASE64_SENTINEL.exec(value);
  if (!sentinel) {
    return value;
  }
  return Buffer.from(sentinel[1], "base64").toString("utf8");
}

function headerValue(headers, name) {
  // Node lowercases incoming header names; compare case-insensitively because
  // RFC 9110 field names are case-insensitive while values are not.
  const found = headers?.[name.toLowerCase()];
  return Array.isArray(found) ? found[0] : found;
}

// The Origin check is the DNS-rebinding defense the transport requires. An
// absent Origin is a non-browser caller and is allowed; a present Origin must
// be explicitly permitted.
export function validateOrigin(headers, allowedOrigins) {
  const origin = headerValue(headers, "origin");
  if (origin === undefined || origin === "") {
    return;
  }
  if (!allowedOrigins.includes(origin)) {
    throw new RpcError(INVALID_PARAMS, `origin '${origin}' is not allowed`, { httpStatus: 403 });
  }
}

export function isModernRequest(headers, body) {
  const header = headerValue(headers, "mcp-protocol-version");
  if (header === PROTOCOL_VERSION) {
    return true;
  }
  if (typeof body?.method === "string" && MODERN_ONLY_METHODS.includes(body.method)) {
    return true;
  }
  const meta = body?.params?._meta;
  if (meta && typeof meta === "object" && typeof meta[META_PROTOCOL_VERSION] === "string") {
    return meta[META_PROTOCOL_VERSION] === PROTOCOL_VERSION;
  }
  return false;
}

export function validateProtocolHeaders(headers, body) {
  const declared = headerValue(headers, "mcp-protocol-version");
  const meta = body?.params?._meta;
  const metaVersion = meta && typeof meta === "object" ? meta[META_PROTOCOL_VERSION] : undefined;

  if (declared === undefined) {
    throw new RpcError(HEADER_MISMATCH, "missing required MCP-Protocol-Version header");
  }
  if (declared !== PROTOCOL_VERSION) {
    throw new RpcError(UNSUPPORTED_PROTOCOL_VERSION, `unsupported protocol version '${declared}'`, {
      data: { supported: [...SUPPORTED_VERSIONS] },
    });
  }
  // server/discover is the negotiation entry point, so it is answered without
  // requiring the per-request _meta a client cannot yet know to send.
  const discovery = body?.method === "server/discover";
  if (metaVersion === undefined) {
    if (!discovery) {
      throw new RpcError(INVALID_PARAMS, `missing required params._meta['${META_PROTOCOL_VERSION}']`);
    }
  } else if (metaVersion !== declared) {
    throw new RpcError(HEADER_MISMATCH, `MCP-Protocol-Version header '${declared}' does not match body value '${metaVersion}'`);
  }

  const method = headerValue(headers, "mcp-method");
  if (method === undefined) {
    throw new RpcError(HEADER_MISMATCH, "missing required Mcp-Method header");
  }
  if (method !== body?.method) {
    throw new RpcError(HEADER_MISMATCH, `Mcp-Method header '${method}' does not match body value '${body?.method}'`);
  }

  const nameHeader = headerValue(headers, "mcp-name");
  const bodyName = typeof body?.params?.name === "string" ? body.params.name
    : typeof body?.params?.uri === "string" ? body.params.uri : undefined;
  if (NAME_HEADER_METHODS.has(body?.method)) {
    if (nameHeader === undefined) {
      throw new RpcError(HEADER_MISMATCH, "missing required Mcp-Name header");
    }
    if (decodeHeaderValue(nameHeader) !== bodyName) {
      throw new RpcError(HEADER_MISMATCH, `Mcp-Name header does not match body value '${bodyName}'`);
    }
  } else if (nameHeader !== undefined && bodyName !== undefined && decodeHeaderValue(nameHeader) !== bodyName) {
    throw new RpcError(HEADER_MISMATCH, `Mcp-Name header does not match body value '${bodyName}'`);
  }

  if (!discovery) {
    const capabilities = meta?.[META_CLIENT_CAPABILITIES];
    if (capabilities === undefined || typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
      throw new RpcError(INVALID_PARAMS, `missing required params._meta['${META_CLIENT_CAPABILITIES}']`);
    }
  }
}

export function completeResult(value, serverInfo) {
  const { _meta: inner, ...rest } = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  return {
    resultType: "complete",
    ...rest,
    _meta: { ...(inner || {}), [META_SERVER_INFO]: serverInfo },
  };
}

export function serverDiscoverResult(serverInfo, capabilities) {
  return completeResult({ supportedVersions: [...SUPPORTED_VERSIONS], capabilities }, serverInfo);
}

// Methods that change state or run work. They are never executed as
// notifications, and never before the caller is authorized.
const SIDE_EFFECTING_METHODS = new Set(["tools/call", "events/subscribe", "events/unsubscribe"]);
const AUTHORIZED_METHODS = new Set(["events/list", "events/subscribe", "events/unsubscribe"]);

// deps: { serverInfo, capabilities, toolRouter, events, allowedOrigins }
export function createModernHandler(deps) {
  async function dispatch(body, principal) {
    const method = body?.method;
    const params = body?.params || {};
    switch (method) {
      case "server/discover":
        {
          return serverDiscoverResult(deps.serverInfo, deps.capabilities());
        }
      case "tools/list":
        {
          return completeResult({ tools: deps.toolRouter.list() }, deps.serverInfo);
        }
      case "tools/call": {
        if (typeof params.name !== "string") {
          throw new RpcError(INVALID_PARAMS, "tools/call requires params.name");
        }
        try {
          const value = await deps.toolRouter.call(params.name, params.arguments);
          return completeResult({
            content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
            structuredContent: value,
            isError: false,
          }, deps.serverInfo);
        } catch (error) {
          if (error instanceof UnknownToolError) {
            throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
          }
          // Execution failures are actionable by the caller, so they are a
          // tool result with isError rather than a protocol error.
          return completeResult({
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            isError: true,
          }, deps.serverInfo);
        }
      }
      case "events/list":
        {
          return completeResult(await deps.events.list(params, principal), deps.serverInfo);
        }
      case "events/subscribe":
        {
          return completeResult(await deps.events.subscribe(params, principal), deps.serverInfo);
        }
      case "events/unsubscribe":
        {
          return completeResult(await deps.events.unsubscribe(params, principal), deps.serverInfo);
        }
      default:
        {
          throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`, { httpStatus: 404 });
        }
    }
  }

  return {
    async handle({ headers, body, authorization }) {
      const rawId = body?.id;
      // Only report an id back when it is a valid one; a malformed id is not
      // echoed, per the JSON-RPC rules this revision keeps.
      const id = typeof rawId === "string" || typeof rawId === "number" ? rawId : undefined;
      try {
        validateOrigin(headers, deps.allowedOrigins());
        if (body?.jsonrpc !== "2.0") {
          throw new RpcError(INVALID_PARAMS, "jsonrpc must be '2.0'");
        }
        if (typeof body?.method !== "string") {
          throw new RpcError(INVALID_PARAMS, "method must be a string");
        }
        // Unlike base JSON-RPC, an id MUST NOT be null in MCP.
        if (rawId === null) {
          throw new RpcError(INVALID_PARAMS, "id must not be null");
        }
        if (rawId !== undefined && id === undefined) {
          throw new RpcError(INVALID_PARAMS, "id must be a string or number");
        }
        validateProtocolHeaders(headers, body);

        if (id === undefined) {
          // This revision defines no client-to-server notifications over
          // Streamable HTTP. A side-effecting method sent without an id is
          // refused outright rather than executed unauthenticated.
          throw new RpcError(
            SIDE_EFFECTING_METHODS.has(body.method) ? HEADER_MISMATCH : INVALID_PARAMS,
            `'${body.method}' must be sent as a request with an id, not a notification`,
          );
        }

        // Authorization is resolved before any dispatch so no handler can run
        // on behalf of an unauthenticated caller. tools/call joins the same
        // boundary once a key is configured: send_message, start_agent,
        // start_team and stop_agent act on the swarm, so they must not be reachable
        // unauthenticated on an endpoint that is exposed beyond loopback.
        const needsAuth = AUTHORIZED_METHODS.has(body.method) ||
          (body.method === "tools/call" && deps.protectToolCalls?.() === true);
        const principal = needsAuth ? deps.events.authorize(authorization) : null;
        return { status: 200, body: { jsonrpc: "2.0", id, result: await dispatch(body, principal) } };
      } catch (error) {
        return errorResponse(id, error);
      }
    },
  };
}
