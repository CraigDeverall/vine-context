// `p2pcg ui`: the MCP App views in a browser tab, for agents that can't show
// MCP Apps themselves. It serves a small host page and an MCP endpoint
// (Streamable HTTP) on 127.0.0.1 only. Each browser tab gets its own MCP
// session, a client of this machine's graph host like any agent session.
//
// The endpoint acts as you (the host's admin), so it is locked to whoever
// holds the random token in the URL: it travels in the URL fragment and an
// Authorization header, never in a query string. Host and Origin are checked
// too, so a web page can't reach it through DNS rebinding.

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { packageRoot } from "../core/package-root.js";
import type { Session } from "../mcp/server.js";

export interface UiServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

// Inline scripts and styles only; the views' iframes (srcdoc) inherit this.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function shellHtml(): string {
  try {
    return readFileSync(join(packageRoot(), "dist", "apps", "shell.html"), "utf8");
  } catch {
    return "<!doctype html><meta charset=utf-8><p>The views aren't built. Run <code>npm run build</code> in p2p-context-graph.</p>";
  }
}

const MAX_BODY = 4 * 1024 * 1024;
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

export async function startUi(o: { session: () => Session; port?: number; log?(m: string): void }): Promise<UiServer> {
  const token = randomBytes(24).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; session: Session }>();
  let port = 0;

  const authorized = (req: IncomingMessage) => {
    const got = Buffer.from(String(req.headers.authorization ?? ""));
    return got.length === expected.length && timingSafeEqual(got, expected);
  };
  const sameHost = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
  const sameOrigin = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
  };
  const send = (res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") => {
    res.writeHead(status, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "no-store" }).end(body);
  };

  const server: Server = createServer(async (req, res) => {
    try {
      if (!sameHost(req)) return send(res, 421, "Wrong host.");
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": CSP,
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        return res.end(shellHtml());
      }
      if (path !== "/mcp") return send(res, 404, "Not found.");
      if (!sameOrigin(req)) return send(res, 403, "Wrong origin.");
      if (!authorized(req)) return send(res, 401, "Missing or wrong token.");

      const id = req.headers["mcp-session-id"];
      const existing = typeof id === "string" ? sessions.get(id) : undefined;
      if (req.method === "POST") {
        const body = await readJson(req);
        if (existing) return existing.transport.handleRequest(req, res, body);
        if (!isInitializeRequest(body)) return send(res, 400, "No session: initialize first.");
        const session = o.session();
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, session });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
          session.close();
        };
        await session.start();
        await session.server.connect(transport);
        return transport.handleRequest(req, res, body);
      }
      if (!existing) return send(res, 404, "No such session.");
      return existing.transport.handleRequest(req, res);
    } catch (e) {
      o.log?.(`ui: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, "Something went wrong; see the p2pcg log.");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? 0, "127.0.0.1", () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/#token=${token}`,
    close: async () => {
      for (const { transport } of sessions.values()) await transport.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
