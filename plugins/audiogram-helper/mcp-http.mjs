import { AsyncLocalStorage } from "node:async_hooks";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

// One shared HTTP entry, fresh MCP instances per request. No job store is owned here.
export function createMcpHttpHandler({
  makeServer,
  principalResolver,
  eventHandler,
} = {}) {
  if (typeof makeServer !== "function")
    throw new TypeError("makeServer is required.");
  if (
    principalResolver !== undefined &&
    typeof principalResolver !== "function"
  )
    throw new TypeError("principalResolver must be a function.");
  if (eventHandler !== undefined && typeof eventHandler !== "function")
    throw new TypeError("eventHandler must be a function.");
  const context = new AsyncLocalStorage();
  const handler = createMcpHandler(
    async (request) => {
      const ctx = { ...request, principal: context.getStore()?.principal };
      const server = await makeServer(ctx);
      if (eventHandler && request.era === "modern")
        await eventHandler(server, ctx);
      return server;
    },
    { legacy: "stateless", maxRequestBodySize: 1024 * 1024 },
  );
  const handleNode = toNodeHandler(handler, {
    maxRequestBodySize: 1024 * 1024,
  });
  return {
    async handleNodeRequest(req, res, body) {
      let principal;
      if (principalResolver) {
        try {
          principal = await principalResolver(req);
        } catch {
          /* Deny failed authentication. */
        }
        if (!principal) {
          res.writeHead(403, { "content-type": "application/json" }).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body?.id ?? null,
              error: { code: -32001, message: "Forbidden" },
            }),
          );
          return;
        }
      }
      await context.run({ principal }, () => handleNode(req, res, body));
    },
    close: () => handler.close(),
  };
}
