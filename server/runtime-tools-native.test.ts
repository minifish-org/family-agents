import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "./codex-client.js";
import { CodexRuntime, type ChatGptAuthentication } from "./codex-runtime.js";
import type { RuntimeTools } from "./runtime.js";

test("native application tools upgrade existing history, rotate run capabilities, and isolate simultaneous Agents", {
  skip: !process.env.CODEX_BIN && "Set CODEX_BIN to run the native application-tool regression.", timeout: 25_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-runtime-tools-native-"));
  const requests: any[] = [], configurations: any[] = [], executed: string[] = [];
  const seen = new Set<string>();
  let fixtureError: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      requests.push(body);
      const user = body.input.findLast((item: any) => item.type === "message" && item.role === "user");
      const label = user.content.find((item: any) => item.type === "input_text").text;
      const id = `response-${requests.length}`;
      let item: any = { type: "message", id: `answer-${requests.length}`, role: "assistant", content: [{ type: "output_text", text: `Finished ${label}` }] };
      if (label.startsWith("TOOL") && !seen.has(label)) {
        seen.add(label);
        item = { type: "custom_tool_call", namespace: "functions", name: "exec", call_id: `call-${requests.length}`,
          input: 'text(await tools.mcp__family_app__export_file({format:"csv"}));' };
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" }).end([
        { type: "response.created", response: { id } }, { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    })().catch((error) => { fixtureError = error; response.writeHead(500).end(); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new CodexClient(directory, { binary: process.env.CODEX_BIN });
  const argumentsForNative = (client as any).arguments.bind(client);
  (client as any).arguments = () => [
    ...argumentsForNative(), "-c", `model_providers.openai_chatgpt_plan.base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`,
    "-c", "features.enable_request_compression=false",
  ];
  const requestNative = client.request.bind(client);
  client.request = async (method, params: any) => {
    if (["thread/start", "thread/resume", "thread/fork"].includes(method) && params.config?.mcp_servers?.family_app?.enabled)
      configurations.push(params.config.mcp_servers.family_app);
    return requestNative(method, params);
  };
  const authentication = Object.assign(new EventEmitter(), {
    status: () => ({ type: "chatgpt", subject: "fixture", clientId: "fixture", auth_method: "siwc" }),
    registrations: () => [], version: () => "1", accessToken: async () => "dummy-native-application-token",
    loginStatus: () => undefined, sanitizeError: (error: unknown) => error instanceof Error ? error.message : String(error),
    close: async () => {}, cancel: async () => {},
  }) as unknown as ChatGptAuthentication;
  const runtime = new CodexRuntime(directory, { client, authentication });
  const defaults = { provider: "codex", model: "gpt-6.1-terra", thinking_level: "low" };
  const tools = (owner: string): RuntimeTools => ({
    definitions: [{ name: "export_file", description: "Create a fixture file.", inputSchema: {
      type: "object", properties: { format: { type: "string", enum: ["csv"] } }, required: ["format"], additionalProperties: false,
    } }],
    execute: async (_name, args, context) => {
      assert.deepEqual(args, { format: "csv" }); assert.equal(context.signal.aborted, false);
      executed.push(owner);
      return { text: `Saved ${owner}`, files: [{ name: `${owner}.csv`, mimeType: "text/csv", data: Buffer.from(`${owner},42`).toString("base64") }] };
    },
  });
  const mapping = () => JSON.parse(readFileSync(join(directory, "codex", "agents", "a", "thread.json"), "utf8"));
  try {
    await runtime.run({ id: "a" }, defaults, "ORIGINAL HISTORY PROOF");
    const original = mapping().threadId;
    const first = await runtime.run({ id: "a", tools: tools("A") }, defaults, "TOOL A1");
    assert.equal(first.files?.[0].name, "A.csv");
    assert.equal(mapping().threadId, original, "application tool setup must preserve the original native thread");
    assert.equal(requests.length, 3, "upgrading tools must not replay a model turn");
    const retired = configurations.at(-1);
    const late = await fetch(retired.url, { method: "POST", headers: retired.http_headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "export_file", arguments: { format: "csv" } } }) });
    assert.equal(late.status, 401);
    const [a, b] = await Promise.all([
      runtime.run({ id: "a", tools: tools("A") }, defaults, "TOOL A2"),
      runtime.run({ id: "b", tools: tools("B") }, defaults, "TOOL B1"),
    ]);
    assert.equal(a.files?.[0].name, "A.csv"); assert.equal(b.files?.[0].name, "B.csv");
    assert.equal(new Set(configurations.map((config) => config.http_headers.Authorization)).size, 3);
    assert.deepEqual(executed.sort(), ["A", "A", "B"]);
    assert.equal(mapping().threadId, original);
    const aRequest = requests.find((body) => JSON.stringify(body.input).includes("TOOL A2"));
    assert.match(JSON.stringify(aRequest.input), /ORIGINAL HISTORY PROOF/);
    const bRequest = requests.find((body) => JSON.stringify(body.input).includes("TOOL B1"));
    assert.doesNotMatch(JSON.stringify(bRequest.input), /ORIGINAL HISTORY PROOF/);
    assert.ok(requests.every((body) => !(body.tools ?? []).some((tool: any) => ["tool_search", "mcp"].includes(tool.type))),
      "local application tools must not become unsupported hosted Responses tools");
    await runtime.stopAgent("a");
    const afterStop = await runtime.run({ id: "a", tools: tools("A") }, defaults, "TOOL A3 AFTER STOP");
    assert.equal(afterStop.files?.[0].name, "A.csv"); assert.equal(mapping().threadId, original);
    let entered!: () => void;
    const executing = new Promise<void>((resolve) => { entered = resolve; });
    const cancelledTools = tools("cancelled");
    cancelledTools.execute = async (_name, _args, { signal }) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "late", files: [{ name: "late.csv", mimeType: "text/csv", data: "YQ==" }] };
    };
    const cancelling = runtime.run({ id: "a", tools: cancelledTools }, defaults, "TOOL CANCEL");
    const rejected = assert.rejects(cancelling, /cancelled/);
    await executing;
    const activeState = (runtime as any).active.get(original);
    await runtime.stopAgent("a"); await rejected;
    assert.equal(activeState.toolController.signal.aborted, true);
    assert.deepEqual(activeState.outputFiles, [], "late tool artifacts must not survive cancellation");
    const cancelledConfig = configurations.at(-1);
    assert.equal((await fetch(cancelledConfig.url, { method: "POST", headers: cancelledConfig.http_headers, body: "{}" })).status, 401);
    const withoutTools = await runtime.run({ id: "a" }, defaults, "NO APPLICATION TOOLS");
    assert.equal(withoutTools.files, undefined);

    const budget = { id: "a", conversationId: "1".repeat(64), initialContext: "BUDGET ROOT" };
    const travel = { id: "a", conversationId: "2".repeat(64), initialContext: "TRAVEL ROOT" };
    await runtime.run(budget, defaults, "BUDGET FIRST QUESTION");
    await runtime.run(travel, defaults, "TRAVEL FIRST QUESTION");
    await runtime.deactivate();
    await runtime.run(budget, defaults, "BUDGET FOLLOWUP AFTER RESTART");
    await runtime.run({ id: "a" }, defaults, "MAIN FOLLOWUP AFTER RESTART");
    const budgetInput = JSON.stringify(requests.find((body) => JSON.stringify(body.input).includes("BUDGET FOLLOWUP AFTER RESTART"))?.input);
    assert.match(budgetInput, /BUDGET ROOT[\s\S]*BUDGET FIRST QUESTION/);
    assert.doesNotMatch(budgetInput, /TRAVEL ROOT|TRAVEL FIRST QUESTION|ORIGINAL HISTORY PROOF/);
    const travelInput = JSON.stringify(requests.find((body) => JSON.stringify(body.input).includes("TRAVEL FIRST QUESTION"))?.input);
    assert.match(travelInput, /TRAVEL ROOT/);
    assert.doesNotMatch(travelInput, /BUDGET ROOT|ORIGINAL HISTORY PROOF/);
    const mainInput = JSON.stringify(requests.find((body) => JSON.stringify(body.input).includes("MAIN FOLLOWUP AFTER RESTART"))?.input);
    assert.match(mainInput, /ORIGINAL HISTORY PROOF/);
    assert.doesNotMatch(mainInput, /BUDGET ROOT|TRAVEL ROOT/);
    assert.ifError(fixtureError);
  } finally {
    await runtime.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
