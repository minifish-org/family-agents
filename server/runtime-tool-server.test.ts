import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeToolServer } from "./runtime-tool-server.js";
import type { RuntimeTools } from "./runtime.js";

const definitions = [{ name: "fixture_action", description: "A fixed fixture action.", inputSchema: { type: "object", properties: {} } }];
function endpoint(lease: Awaited<ReturnType<RuntimeToolServer["register"]>>) {
  const server = lease.config.mcp_servers.family_app;
  return {
    server,
    async call(id: string | number, name = "fixture_action", args: unknown = {}) {
      return fetch(server.url, { method: "POST", headers: { ...server.http_headers, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
    },
  };
}

test("application MCP capabilities isolate runs, retire old tokens, and deduplicate tool request IDs", async () => {
  const host = new RuntimeToolServer();
  let executions = 0, outputs = 0;
  const controller = new AbortController();
  const tools: RuntimeTools = { definitions, execute: async (_name, _args, context) => {
    assert.equal(context.callId, "1"); assert.equal(context.signal, controller.signal);
    executions++; await new Promise((resolve) => setTimeout(resolve, 5)); return { text: "saved" };
  } };
  try {
    const first = await host.register({ tools, signal: controller.signal, ready: async () => true, result: () => { outputs++; }, sanitize: () => "safe error" });
    const a = endpoint(first);
    assert.equal(a.server.default_tools_approval_mode, "approve");
    assert.equal(a.server.enabled, true);
    assert.deepEqual(a.server.enabled_tools, ["fixture_action"]);
    const replies = await Promise.all([a.call(1), a.call(1)]);
    for (const response of replies) assert.equal((await response.json() as any).result.isError, false);
    assert.equal(executions, 1); assert.equal(outputs, 1);
    const reused: any = await (await a.call(1, "fixture_action", { different: true })).json();
    assert.equal(reused.error.code, -32602);
    first.revoke();
    assert.equal((await a.call(1)).status, 401);
    const next = await host.register({ tools: { definitions, execute: async () => ({ text: "next owner" }) }, signal: new AbortController().signal,
      ready: async () => true, result: () => { outputs++; }, sanitize: () => "safe error" });
    const b = endpoint(next);
    assert.notEqual(a.server.http_headers.Authorization, b.server.http_headers.Authorization);
    assert.equal((await a.call(2)).status, 401);
    assert.equal((await (await b.call(1)).json() as any).result.content[0].text, "next owner");
    assert.equal(executions, 1); assert.equal(outputs, 2);
  } finally { controller.abort(); await host.close(); }
});

test("application MCP rejects unavailable, inactive, cancelled and browser-origin calls before returning artifacts", async () => {
  const host = new RuntimeToolServer(), controller = new AbortController();
  let active = false, executions = 0, outputs = 0;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const lease = await host.register({
      tools: { definitions, execute: async (_name, _args, { signal }) => {
        executions++; entered();
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        return { text: "late", files: [{ name: "late.csv", mimeType: "text/csv", data: "YQ==" }] };
      } }, signal: controller.signal, ready: async () => active, result: () => { outputs++; }, sanitize: () => "The Agent turn is no longer active.",
    });
    const target = endpoint(lease);
    assert.equal((await (await target.call(1)).json() as any).result.isError, true);
    assert.equal(executions, 0);
    active = true;
    assert.equal((await (await target.call(2, "unknown_tool")).json() as any).result.isError, true);
    const denied = await fetch(target.server.url, { method: "POST", headers: { ...target.server.http_headers, Origin: "https://example.org" }, body: "{}" });
    assert.equal(denied.status, 401);
    const pending = target.call(3); await entry; controller.abort();
    assert.equal((await (await pending).json() as any).result.isError, true);
    assert.equal(outputs, 0);
    assert.equal((await target.call(4)).status, 401);
  } finally { controller.abort(); await host.close(); }
});
