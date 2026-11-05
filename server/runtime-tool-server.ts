import { createServer, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { RuntimeToolResult, RuntimeTools } from "./runtime.js";

type Registration = {
  tools: RuntimeTools;
  signal: AbortSignal;
  ready(): Promise<boolean>;
  result(result: RuntimeToolResult): void;
  sanitize(error: unknown): string;
  calls: Map<string, { fingerprint: string; value: Promise<unknown> }>;
};
export type RuntimeToolLease = { config: Record<string, any>; revoke(): void };
const MAX_BODY = 256 * 1024;

/** A fixed, process-local MCP transport for application tools, never an extension host. */
export class RuntimeToolServer {
  private server?: Server;
  private starting?: Promise<number>;
  private readonly registrations = new Map<string, Registration>();

  private start() {
    if (this.starting) return this.starting;
    this.server = createServer((request, response) => {
      void (async () => {
        const authorization = request.headers.authorization ?? "";
        const registration = authorization.startsWith("Bearer ") ? this.registrations.get(authorization.slice(7)) : undefined;
        if (!registration || registration.signal.aborted || request.headers.origin) {
          response.writeHead(401).end(); return;
        }
        if (request.method !== "POST" || request.url !== "/mcp") { response.writeHead(405).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > MAX_BODY) { response.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        let message: any;
        try { message = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { response.writeHead(400).end(); return; }
        if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
          response.writeHead(400).end(); return;
        }
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        if (!(typeof message.id === "string" && message.id.length <= 256) && typeof message.id !== "number") {
          response.writeHead(400).end(); return;
        }
        let result: unknown;
        switch (message.method) {
          case "initialize": result = {
            protocolVersion: typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "2025-03-26",
            capabilities: { tools: {} }, serverInfo: { name: "family_application_tools", version: "1" },
          }; break;
          case "ping": result = {}; break;
          case "tools/list": result = { tools: registration.tools.definitions.map((tool) => ({
            name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          })) }; break;
          case "resources/list": result = { resources: [] }; break;
          case "resources/templates/list": result = { resourceTemplates: [] }; break;
          case "prompts/list": result = { prompts: [] }; break;
          case "tools/call": {
            const key = JSON.stringify(message.id), fingerprint = JSON.stringify(message.params);
            const previous = registration.calls.get(key);
            if (previous && previous.fingerprint !== fingerprint) {
              this.send(response, { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "The tool request identifier was reused." } }); return;
            }
            if (!previous && registration.calls.size >= 64) {
              result = { content: [{ type: "text", text: "This message reached its application tool limit." }], isError: true }; break;
            }
            const value = previous?.value ?? (async () => {
              try {
                if (!registration.tools.definitions.some((tool) => tool.name === message.params?.name)) throw new Error("This application tool is unavailable.");
                if (registration.signal.aborted || !await registration.ready()) throw new Error("The Agent turn is no longer active.");
                const output = await registration.tools.execute(message.params.name, message.params.arguments ?? {}, {
                  callId: key, signal: registration.signal,
                });
                if (registration.signal.aborted || !await registration.ready()) throw new Error("The Agent turn is no longer active.");
                registration.result(output);
                return { content: [{ type: "text", text: output.text }], isError: false };
              } catch (error) {
                return { content: [{ type: "text", text: registration.sanitize(error) }], isError: true };
              }
            })();
            if (!previous) registration.calls.set(key, { fingerprint, value });
            result = await value;
            break;
          }
          default: this.send(response, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unknown application tool method." } }); return;
        }
        this.send(response, { jsonrpc: "2.0", id: message.id, result });
      })().catch(() => { if (!response.headersSent) response.writeHead(400); response.end(); });
    });
    this.server.requestTimeout = 15_000;
    this.server.headersTimeout = 10_000;
    this.starting = new Promise<number>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        const address = this.server!.address();
        if (!address || typeof address === "string") { reject(new Error("Application tools could not start.")); return; }
        this.server!.unref();
        resolve(address.port);
      });
    });
    return this.starting;
  }

  async register(registration: Omit<Registration, "calls">): Promise<RuntimeToolLease> {
    const port = await this.start();
    const token = randomBytes(32).toString("hex");
    const entry: Registration = { ...registration, calls: new Map() };
    this.registrations.set(token, entry);
    const revoke = () => { this.registrations.delete(token); };
    registration.signal.addEventListener("abort", revoke, { once: true });
    return {
      config: {
        thread_unload_delay_secs: 0,
        mcp_servers: { family_app: {
          url: `http://127.0.0.1:${port}/mcp`, http_headers: { Authorization: `Bearer ${token}` },
          enabled: true, required: true, default_tools_approval_mode: "approve", tool_timeout_sec: 120,
          enabled_tools: registration.tools.definitions.map((tool) => tool.name),
        } },
      },
      revoke: () => { revoke(); registration.signal.removeEventListener("abort", revoke); },
    };
  }

  private send(response: ServerResponse, body: unknown) {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  }

  async close() {
    this.registrations.clear();
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined; this.starting = undefined;
  }
}
