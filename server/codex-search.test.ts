import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "./codex-client.js";

const binary = process.env.CODEX_BIN;
const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = (id: string) => ({
  type: "response.completed",
  response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
});

test("native Codex preserves history and dynamic tools when an explicit connection switch requires a provider fork", {
  skip: !binary && "Set CODEX_BIN to run the isolated native protocol regression.",
  timeout: 20_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-native-provider-test-"));
  const client = new CodexClient(directory, { binary });
  let provider = "openai_chatgpt_plan";
  const requests: any[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const id = `response-${requests.length}`;
      response.writeHead(200, { "Content-Type": "text/event-stream" }).end(sse([
        { type: "response.created", response: { id } },
        { type: "response.output_item.done", item: { type: "message", id: `answer-${requests.length}`, role: "assistant", content: [{ type: "output_text", text: "Saved response proof." }] } },
        completed(id),
      ]));
    })().catch(() => { response.writeHead(500).end(); });
  });
  const turn = async (threadId: string, text: string) => {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const notification = (method: string, params: any) => {
      if (method === "turn/completed" && params.threadId === threadId) finish();
    };
    client.on("notification", notification);
    try {
      await client.request("turn/start", {
        threadId, input: [{ type: "text", text, text_elements: [] }],
        permissions: "family_agent",
      });
      await done;
    } finally { client.off("notification", notification); }
  };
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const nativeArguments = (client as any).arguments.bind(client);
    (client as any).arguments = () => [
      ...nativeArguments(),
      ...((client as any).accessToken ? ["-c", `model_providers.openai_chatgpt_plan.base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`] : []),
      "-c", 'model_providers.second_fixture.name="Second fixture"',
      "-c", `model_providers.second_fixture.base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`,
      "-c", 'model_providers.second_fixture.wire_api="responses"',
      "-c", 'model_providers.second_fixture.env_key="FAMILY_CODEX_SIWC_TOKEN"',
      "-c", "model_providers.second_fixture.requires_openai_auth=false",
      "-c", "model_providers.second_fixture.supports_websockets=false",
      "-c", `model_provider=${JSON.stringify(provider)}`,
      "-c", "features.enable_request_compression=false",
    ];
    await client.setAccessToken("dummy-provider-fixture-token");
    const common = () => ({
      model: "gpt-6.1-terra", modelProvider: provider, cwd: client.cwd, runtimeWorkspaceRoots: [client.cwd],
      approvalPolicy: "on-request", permissions: "family_agent", developerInstructions: "Keep the saved fixture history.",
    });
    const original: any = await client.request("thread/start", {
      ...common(), ephemeral: false,
      dynamicTools: [{ type: "function", name: "send_image", description: "Return a current attachment.", inputSchema: { type: "object", properties: {} } }],
    });
    await turn(original.thread.id, "Original conversation proof.");
    await client.setAccessToken(undefined);
    provider = "openai";
    // Exercise the production native provider with no SIWC credential in its
    // environment, rather than leaving both fixture providers authenticated.
    await assert.rejects(client.request("thread/resume", { ...common(), threadId: original.thread.id }),
      (error: any) => error.reason === "modelProviderMismatch" && error.code === -32600);
    const nativeFork: any = await client.request("thread/fork", { ...common(), threadId: original.thread.id, ephemeral: false });
    assert.equal(nativeFork.modelProvider, "openai");
    assert.match(JSON.stringify(nativeFork.thread.turns), /Original conversation proof/);
    assert.equal(requests.length, 1, "native provider preparation must not replay inference");
    await client.setAccessToken("dummy-provider-fixture-token");
    provider = "second_fixture";
    await assert.rejects(client.request("thread/resume", { ...common(), threadId: original.thread.id }),
      (error: any) => error.reason === "modelProviderMismatch" && error.code === -32600);
    const fork: any = await client.request("thread/fork", { ...common(), threadId: original.thread.id, ephemeral: false });
    assert.notEqual(fork.thread.id, original.thread.id);
    assert.equal(fork.modelProvider, provider);
    assert.match(JSON.stringify(fork.thread.turns), /Original conversation proof/);
    assert.match(JSON.stringify(fork.thread.turns), /Saved response proof/);
    assert.equal(requests.length, 1, "forking must not replay inference");
    await turn(fork.thread.id, "Continue with the other connection.");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /Original conversation proof/);
    assert.match(JSON.stringify(requests[1]), /send_image/);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native Codex executes live search through the Responses Lite tool host without local execution tools", {
  skip: !binary && "Set CODEX_BIN to run the isolated native protocol regression.",
  timeout: 20_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-native-search-test-"));
  const client = new CodexClient(directory, { binary });
  const requests: Array<{ path: string; body: any }> = [];
  const webItems = new Set<string>();
  let fixtureFailure: unknown;
  let responseCount = 0;
  const proof = "NATIVE_LIVE_SEARCH_PROOF";
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path: request.url!, body });
      if (request.url === "/v1/alpha/search") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ output: `${proof} https://example.org/source` }));
        return;
      }
      assert.equal(request.url, "/v1/responses");
      const events = ++responseCount === 1 ? [
        { type: "response.created", response: { id: "first" } },
        {
          type: "response.output_item.done",
          item: {
            type: "custom_tool_call", call_id: "native-search", namespace: "functions", name: "exec",
            input: 'text({tools:ALL_TOOLS.map(tool=>tool.name),search:await tools.web__run({search_query:[{q:"native integration fixture"}],response_length:"short"})});',
          },
        },
        completed("first"),
      ] : [
        { type: "response.created", response: { id: "second" } },
        { type: "response.output_item.done", item: { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text: "Search completed." }] } },
        completed("second"),
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(sse(events));
    })().catch((error) => {
      fixtureFailure = error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  let finish!: (turn: any) => void;
  const done = new Promise<any>((resolve) => { finish = resolve; });
  client.on("notification", (method, params) => {
    if ((method === "item/started" || method === "item/completed") && params.item?.type === "webSearch")
      webItems.add(params.item.id);
    if (method === "turn/completed") finish(params.turn);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    // Only redirect the model/search endpoint to this local peer. Production capability
    // and safety arguments are deliberately retained so a missing gate fails the test.
    const nativeArguments = (client as any).arguments.bind(client);
    (client as any).arguments = () => [
      ...nativeArguments(),
      "-c", `model_providers.openai_chatgpt_plan.base_url=${JSON.stringify(`http://127.0.0.1:${address.port}/v1`)}`,
      "-c", "features.enable_request_compression=false",
    ];
    await client.setAccessToken("dummy-native-search-test-credential");
    const thread: any = await client.request("thread/start", {
      model: "gpt-6.1-terra", modelProvider: "openai_chatgpt_plan", cwd: client.cwd, runtimeWorkspaceRoots: [client.cwd],
      approvalPolicy: "on-request", permissions: "family_agent", ephemeral: true,
      config: { web_search: "live" },
    });
    await client.request("turn/start", {
      threadId: thread.thread.id, model: "gpt-6.1-terra",
      permissions: "family_agent",
      input: [{ type: "text", text: "Search the web using the local fixture.", text_elements: [] }],
    });
    const turn = await done;
    assert.ifError(fixtureFailure);
    assert.equal(turn.status, "completed");
    assert.deepEqual(requests.map((request) => request.path), ["/v1/responses", "/v1/alpha/search", "/v1/responses"]);
    assert.equal(webItems.size, 1);
    const search = requests[1].body;
    assert.deepEqual(search.commands.search_query, [{ q: "native integration fixture" }]);
    assert.equal(search.settings.external_web_access, true);
    const result = requests[2].body.input.find((item: any) => item.type === "custom_tool_call_output" && item.call_id === "native-search");
    assert.ok(result, "the search result must be returned to the model");
    const output = JSON.stringify(result.output);
    assert.match(output, new RegExp(proof));
    assert.match(output, /web__run/);
    assert.doesNotMatch(output, /exec_command|browser_use|computer_use/);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
