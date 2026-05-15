import type { FastifyInstance } from "fastify";

import { logger } from "@/lib/logger.js";
import { TOOLS, TOOLS_BY_NAME, ToolUserError } from "@/mcp/tools.js";

/**
 * JSON-RPC 2.0 wire types. MCP runs on top of this; in the streamable-HTTP
 * transport that offer-mcp-v2 uses, each POST is one (or one batch of)
 * request(s), and the response is JSON (we don't speak SSE — Accept header
 * just permits it for compat, we always return application/json).
 *
 * Spec: https://www.jsonrpc.org/specification + MCP 2024-11-05 protocol.
 */
interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}
interface JsonRpcOk {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}
interface JsonRpcErr {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}
type JsonRpcResp = JsonRpcOk | JsonRpcErr;

// JSON-RPC standard error codes — using these instead of inventing our own
// keeps MCP clients (e.g. Claude Desktop, mcp-cli) happy.
const E_PARSE = -32700;
const E_INVALID = -32600;
const E_METHOD_NOT_FOUND = -32601;
const E_INVALID_PARAMS = -32602;
const E_INTERNAL = -32603;

function ok(id: string | number | null, result: unknown): JsonRpcOk {
  return { jsonrpc: "2.0", id, result };
}
function err(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErr {
  const e: JsonRpcErr = { jsonrpc: "2.0", id, error: { code, message } };
  if (data !== undefined) e.error.data = data;
  return e;
}

async function handleSingle(req: JsonRpcReq): Promise<JsonRpcResp | null> {
  const id = req.id ?? null;

  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return err(id, E_INVALID, "invalid JSON-RPC envelope");
  }

  // Notifications (no id) get no response — return null and let the caller drop.
  const isNotification = req.id === undefined || req.id === null;

  switch (req.method) {
    case "initialize": {
      // Echo back the protocolVersion the client asked for if we recognize it,
      // otherwise default to 2024-11-05 (the one offer-mcp-v2 speaks). MCP
      // doesn't actually break across these patch revisions for our scope.
      const p = (req.params ?? {}) as { protocolVersion?: string };
      const proto = p.protocolVersion ?? "2024-11-05";
      return ok(id, {
        protocolVersion: proto,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "zhide-data-mcp", version: "0.1.0" },
      });
    }

    case "notifications/initialized":
    case "initialized":
    case "notifications/cancelled":
      // Pure notification — no response.
      return null;

    case "ping":
      return ok(id, {});

    case "tools/list": {
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case "tools/call": {
      const p = (req.params ?? {}) as { name?: string; arguments?: unknown };
      const tool = p.name ? TOOLS_BY_NAME.get(p.name) : undefined;
      if (!tool) {
        return err(id, E_METHOD_NOT_FOUND, `unknown tool: ${p.name ?? "(missing name)"}`);
      }
      let parsedArgs: unknown;
      try {
        parsedArgs = tool.parse(p.arguments);
      } catch (e) {
        // zod errors and our ToolUserError should both surface as user errors
        // (E_INVALID_PARAMS) — they're definitionally caller mistakes.
        const msg = e instanceof Error ? e.message : String(e);
        return err(id, E_INVALID_PARAMS, `invalid arguments: ${msg}`);
      }
      const startedAt = new Date();
      try {
        const data = await tool.handler(parsedArgs);
        return ok(id, {
          // Provide both content (text fallback for clients that don't read
          // structuredContent) and structuredContent (the JSON payload).
          content: [
            {
              type: "text",
              text:
                typeof data === "string" ? data : JSON.stringify(data, null, 0).slice(0, 4000),
            },
          ],
          structuredContent: {
            tool: tool.name,
            source: "zhide-data-mcp",
            requestId: id,
            status: "ok",
            data,
            meta: { requestStartedAt: startedAt.toISOString() },
          },
          isError: false,
        });
      } catch (e) {
        if (e instanceof ToolUserError) {
          // Tool-defined user error — return as a successful response with
          // isError=true (MCP convention: tool errors aren't transport errors).
          return ok(id, {
            content: [{ type: "text", text: e.message }],
            structuredContent: {
              tool: tool.name,
              source: "zhide-data-mcp",
              requestId: id,
              status: "error",
              error: { code: "TOOL_USER_ERROR", message: e.message, retryable: false },
              meta: { requestStartedAt: startedAt.toISOString() },
            },
            isError: true,
          });
        }
        // Unexpected error — log + opaque internal error to the caller.
        const msg = e instanceof Error ? e.message : String(e);
        logger.error(
          { tool: tool.name, err: msg, stack: e instanceof Error ? e.stack : undefined },
          "mcp tool handler crashed",
        );
        return ok(id, {
          content: [{ type: "text", text: "internal tool error" }],
          structuredContent: {
            tool: tool.name,
            source: "zhide-data-mcp",
            requestId: id,
            status: "error",
            error: {
              code: "TOOL_INTERNAL_ERROR",
              message: "internal tool error",
              retryable: false,
            },
            meta: { requestStartedAt: startedAt.toISOString() },
          },
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return err(id, E_METHOD_NOT_FOUND, `method not found: ${req.method}`);
  }
}

export function registerMcpRoute(app: FastifyInstance) {
  // POST /mcp — JSON-RPC entry point. Single or batch requests supported.
  app.post("/mcp", async (req, reply) => {
    let body: unknown = req.body;
    // Fastify already parses application/json. Defend against clients that
    // sent a string anyway (some MCP clients do).
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        reply
          .code(200)
          .header("content-type", "application/json")
          .send(err(null, E_PARSE, "parse error"));
        return;
      }
    }

    const isBatch = Array.isArray(body);
    const items = (isBatch ? (body as JsonRpcReq[]) : [body as JsonRpcReq]).filter(
      (x): x is JsonRpcReq => !!x && typeof x === "object",
    );

    const responses: JsonRpcResp[] = [];
    for (const item of items) {
      const r = await handleSingle(item);
      if (r !== null) responses.push(r);
    }

    // Per JSON-RPC: a batch of nothing-but-notifications gets HTTP 204.
    // We use HTTP 200 with an empty body for simpler client compat; both are
    // common in the wild and MCP doesn't pin it.
    if (responses.length === 0) {
      reply.code(200).header("content-type", "application/json").send("");
      return;
    }

    reply
      .code(200)
      .header("content-type", "application/json")
      .send(isBatch ? responses : responses[0]);
  });
}
