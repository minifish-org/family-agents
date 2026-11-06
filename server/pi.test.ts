import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { PiService } from "./pi.js";
import type { RuntimeTools } from "./runtime.js";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const fixtureConfig = (baseUrl: string, apiKey = "local-fixture-key") => ({
  providers: {
    fixture: {
      baseUrl,
      apiKey,
      api: "openai-completions",
      authHeader: true,
      models: [
        {
          id: "fixture-model",
          name: "Fixture model",
          reasoning: true,
          thinkingLevelMap: {
            off: "none",
            minimal: null,
            low: "small",
            medium: null,
            high: "large",
            xhigh: null,
            max: "largest",
          },
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 4096,
          samplingParams: { temperature: 0.7, vendor_extra: { keep: true } },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: { maxTokensField: "max_tokens", supportsStore: false },
        },
      ],
    },
  },
});

test("Pi native schema, complete configuration round trip, masking, and optimistic conflict checks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-pi-config-"));
  const service = new PiService(directory);
  try {
    await service.ready;
    const config: any = fixtureConfig("http://127.0.0.1:1/v1");
    const sentinel = join(directory, "command-executed");
    config.providers.fixture.apiKey = `!touch '${sentinel}'; printf 'secret-command-key'`;
    config.providers.fixture.headers = {
      Authorization: "Bearer header-secret",
      "X-Command": "!printf header-command-secret",
    };
    config.providers.fixture.models[0].headers = {
      "X-Model-Secret": "private-model-header",
    };
    config.providers.fixture.extra_supported_future_property = {
      preserve: true,
    };
    config.providers.fixture.extraAuth = {
      accessToken: "private-access-value",
      refresh_token: "private-refresh-value",
      oauthTokens: ["private-token-list-value"],
    };
    let response = await service.saveConfig(config, service.config().version);
    assert.equal(
      existsSync(sentinel),
      false,
      "configuration validation must never execute command-backed values",
    );
    const serialized = JSON.stringify(response);
    for (const secret of [
      "secret-command-key",
      "header-secret",
      "header-command-secret",
      "private-model-header",
      "private-access-value",
      "private-refresh-value",
      "private-token-list-value",
    ])
      assert.equal(serialized.includes(secret), false);
    assert.equal(
      (response.config as any).providers.fixture.models[0].compat
        .maxTokensField,
      "max_tokens",
      "a token-limit parameter name is ordinary model metadata, not a credential",
    );
    assert.deepEqual(service.thinkingLevels("fixture", "fixture-model"), [
      "off",
      "low",
      "high",
      "max",
    ]);
    assert.equal(
      service.clampThinking("fixture", "fixture-model", "medium"),
      "high",
    );
    assert.throws(
      () => service.clampThinking("fixture", "fixture-model", "unrecognized"),
      /thinking level/i,
    );
    const models = await service.models();
    assert.equal(
      models.find((model) => model.provider === "fixture")?.available,
      true,
    );
    assert.equal(
      existsSync(sentinel),
      false,
      "catalog/status reads must not execute credential commands",
    );
    const edited = structuredClone(response.config) as any;
    edited.providers.fixture.models.unshift({
      id: "second-model",
      headers: { "X-Another": "second-secret" },
    });
    edited.providers.fixture.models[1].name = "Renamed";
    const previousVersion = response.version;
    response = await service.saveConfig(edited, response.version);
    const stored = JSON.parse(
      readFileSync(join(directory, "pi", "models.json"), "utf8"),
    );
    assert.equal(
      stored.providers.fixture.apiKey,
      config.providers.fixture.apiKey,
    );
    assert.equal(
      stored.providers.fixture.models[1].headers["X-Model-Secret"],
      "private-model-header",
      "array reordering must preserve the correct masked secret",
    );
    assert.deepEqual(
      stored.providers.fixture.models[1].samplingParams,
      config.providers.fixture.models[0].samplingParams,
    );
    assert.deepEqual(stored.providers.fixture.extra_supported_future_property, {
      preserve: true,
    });
    await assert.rejects(service.saveConfig(response.config, previousVersion), {
      status: 409,
    });
    const invalid = structuredClone(response.config) as any;
    invalid.providers.fixture.models[1].contextWindow = -1;
    await assert.rejects(
      service.saveConfig(invalid, response.version),
      /schema/i,
    );
    assert.equal(
      service.config().version,
      response.version,
      "invalid settings must not replace the valid file",
    );
    assert.equal(
      statSync(join(directory, "pi", "models.json")).mode & 0o777,
      0o600,
    );
    const schema = service.schema() as any;
    assert.equal(schema.properties.providers.type, "object");
    assert.ok(schema.$defs.ThinkingLevelMap.properties.max);
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native provider API-key authentication stores secrets privately and reports only status", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-pi-auth-"));
  const service = new PiService(directory);
  try {
    await service.ready;
    const initialVersion = (await service.providers()).find(
      (provider) => provider.id === "anthropic",
    )!.auth_version;
    await service.setKey(
      "anthropic",
      "fixture-never-send-secret",
      initialVersion,
    );
    const provider = (await service.providers()).find(
      (provider) => provider.id === "anthropic",
    );
    assert.equal(provider?.authenticated, true);
    assert.equal(provider?.auth_type, "api_key");
    assert.equal(
      JSON.stringify(await service.providers()).includes(
        "fixture-never-send-secret",
      ),
      false,
    );
    assert.equal(
      service.sanitizeError(
        new Error("Failed using fixture-never-send-secret"),
      ),
      "Failed using [redacted]",
    );
    assert.equal(
      statSync(join(directory, "pi", "auth.json")).mode & 0o777,
      0o600,
    );
    await assert.rejects(
      service.setKey("anthropic", "stale-secret", initialVersion),
      { status: 409 },
    );
    const flow = await service.beginOAuth(
      "anthropic",
      "api_key",
      provider!.auth_version,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(service.oauthStatus(flow.id).prompt_type, "secret");
    service.oauthInput(flow.id, "another-private-fixture-key");
    for (
      let n = 0;
      n < 50 && service.oauthStatus(flow.id).status === "pending";
      n++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(service.oauthStatus(flow.id).status, "complete");
    assert.equal(
      JSON.stringify(service.oauthStatus(flow.id)).includes(
        "another-private-fixture-key",
      ),
      false,
    );
    const currentVersion = (await service.providers()).find(
      (provider) => provider.id === "anthropic",
    )!.auth_version;
    const pendingLogin = await service.beginOAuth(
      "anthropic",
      "api_key",
      currentVersion,
    );
    const concurrent = await Promise.allSettled([
      service.setKey("anthropic", "first-concurrent-secret", currentVersion),
      service.setKey("anthropic", "second-concurrent-secret", currentVersion),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      (
        concurrent.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason.status,
      409,
    );
    assert.equal(
      service.oauthStatus(pendingLogin.id).status,
      "cancelled",
      "a delayed login must not overwrite a newer authentication edit",
    );
    const latestVersion = (await service.providers()).find(
      (provider) => provider.id === "anthropic",
    )!.auth_version;
    await service.removeAuth("anthropic", latestVersion);
    assert.equal(
      (await service.providers()).find(
        (provider) => provider.id === "anthropic",
      )?.authenticated,
      false,
    );
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function modelFixture() {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString());
    requests.push(body);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const content = (message: any) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content);
    const last = body.messages[body.messages.length - 1];
    const forwarding =
      last.role === "user" && content(last).includes("forward");
    const exporting = last.role === "user" && content(last).includes("export fixture");
    const chunk: any = {
      id: `chatcmpl-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture-model",
      choices: [
        {
          index: 0,
          delta: forwarding || exporting
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: exporting ? "call-export" : "call-forward",
                    type: "function",
                    function: {
                      name: exporting ? "export_file" : "send_image",
                      arguments: exporting ? '{"format":"csv"}' : '{"attachment_index":0}',
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: `Reply with ${body.messages.filter((message: any) => message.role === "user").length} user messages.`,
              },
          finish_reason: null,
        },
      ],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices[0] = {
      index: 0,
      delta: {},
      finish_reason: forwarding || exporting ? "tool_calls" : "stop",
    };
    chunk.usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, requests, url: `http://127.0.0.1:${address.port}/v1` };
}
async function stopServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("Pi application tools keep current owner callbacks and return files without registering execution tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-pi-application-")), fixture = await modelFixture();
  const service = new PiService(directory);
  const calls: string[] = [];
  const tools = (owner: string): RuntimeTools => ({
    definitions: [{ name: "export_file", description: "Export a fixture CSV.", inputSchema: {
      type: "object", properties: { format: { type: "string", enum: ["csv"] } }, required: ["format"], additionalProperties: false,
    } }],
    execute: async (name, args, context) => {
      assert.equal(name, "export_file"); assert.deepEqual(args, { format: "csv" }); assert.equal(context.signal.aborted, false);
      calls.push(owner);
      return { text: `Created ${owner}`, files: [{ name: `${owner}.csv`, mimeType: "text/csv", data: "YSxi" }] };
    },
  });
  try {
    await service.ready; await service.saveConfig(fixtureConfig(fixture.url), service.config().version);
    const defaults = { provider: "fixture", model: "fixture-model", thinking_level: "off" };
    const first = await service.run({ id: "a", tools: tools("first-context") }, defaults, "export fixture");
    assert.equal(first.files?.[0].name, "first-context.csv");
    const second = await service.run({ id: "a", tools: tools("new-context") }, defaults, "export fixture again");
    assert.equal(second.files?.[0].name, "new-context.csv");
    const third = await service.run({ id: "b", tools: tools("other-owner") }, defaults, "export fixture for B");
    assert.equal(third.files?.[0].name, "other-owner.csv");
    assert.deepEqual(calls, ["first-context", "new-context", "other-owner"]);
    assert.deepEqual(fixture.requests.at(-1).tools.map((tool: any) => tool.function.name), ["send_image", "export_file"]);
  } finally { await service.close(); await stopServer(fixture.server); rmSync(directory, { recursive: true, force: true }); }
});

test("stopping Pi aborts a threaded application tool and discards late file output", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-pi-tool-stop-")), fixture = await modelFixture();
  const service = new PiService(directory);
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => { entered = resolve; });
  const tools: RuntimeTools = {
    definitions: [{ name: "export_file", description: "Fixture export", inputSchema: { type: "object", properties: { format: { type: "string" } } } }],
    execute: async (_name, _args, { signal }) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "late", files: [{ name: "late.csv", mimeType: "text/csv", data: "YQ==" }] };
    },
  };
  try {
    await service.ready; await service.saveConfig(fixtureConfig(fixture.url), service.config().version);
    const defaults = { provider: "fixture", model: "fixture-model", thinking_level: "off" };
    await service.initializeAgent({ id: "a" }, defaults);
    const running = service.run({ id: "a", conversationId: "a".repeat(64), tools }, defaults, "export fixture");
    const rejected = assert.rejects(running, /abort|cancel|active/i);
    await executing;
    const state = (service as any).activeThreads.get("a");
    await service.stopAgent("a"); await rejected;
    assert.equal(state.toolController.signal.aborted, true);
    assert.deepEqual(state.outputFiles, []);
    assert.equal((service as any).sessions.size, 0);
    assert.equal((service as any).activeThreads.size, 0);
  } finally { await service.close(); await stopServer(fixture.server); rmSync(directory, { recursive: true, force: true }); }
});

test("Pi resumes a thread after releasing it and preserves separate thread and main histories across restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-pi-thread-session-"));
  const fixture = await modelFixture();
  let service = new PiService(directory);
  const defaults = { provider: "fixture", model: "fixture-model", thinking_level: "off" };
  const main = { id: "agent" };
  const threadA = { ...main, conversationId: "a".repeat(64), initialContext: "Earlier root: budget" };
  const threadB = { ...main, conversationId: "b".repeat(64), initialContext: "Earlier root: holiday" };
  const run = async (agent: typeof main, message: string, count: number) => {
    const reply = await service.run(agent, defaults, message);
    assert.equal(reply.text, `Reply with ${count} user messages.`);
    assert.equal((service as any).activeThreads.size, 0);
    return fixture.requests.at(-1).messages.filter((item: any) => item.role === "user");
  };
  try {
    await service.ready;
    await service.saveConfig(fixtureConfig(fixture.url), service.config().version);
    await service.initializeAgent(threadA, defaults);
    assert.equal(existsSync(join(directory, "agents", "agent", "threads")), false);
    await run(main, "Main before", 1);
    assert.equal(JSON.stringify(await run(threadA, "First budget", 1)).includes("Earlier root: budget"), true);
    assert.equal(JSON.stringify(await run(threadB, "First holiday", 1)).includes("First budget"), false);
    const budget = JSON.stringify(await run(threadA, "Second budget", 2));
    assert.equal(budget.includes("First holiday"), false);
    assert.equal(budget.includes("Main before"), false);
    assert.equal(budget.match(/Earlier root: budget/g)?.length, 1);
    await service.stopAgent(main.id);
    await run(main, "Main after stop", 2);
    await service.close();
    service = new PiService(directory);
    assert.equal(JSON.stringify(await run(main, "Main after restart", 3)).includes("Earlier root"), false);
    await run(threadA, "Budget after restart", 3);
    await run(threadB, "Holiday after restart", 2);
    await assert.rejects(service.run({ ...main, conversationId: "../sessions" }, defaults, "Invalid thread"), /invalid conversation/i);
  } finally {
    await service.close();
    await stopServer(fixture.server);
    rmSync(directory, { recursive: true, force: true });
  }
});

test("official Pi runs retain isolated context across restart, apply prompt/model changes, and forward images with a safe tool", async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-pi-session-"));
  const fixture = await modelFixture();
  let service = new PiService(directory);
  const defaults = {
    provider: "fixture",
    model: "fixture-model",
    thinking_level: "max",
  };
  try {
    await service.ready;
    await service.saveConfig(
      fixtureConfig(fixture.url),
      service.config().version,
    );
    const first = await service.run(
      { id: "agent-one", instructions: "Answer briefly." },
      defaults,
      "Hello",
    );
    assert.equal(first.text, "Reply with 1 user messages.");
    const second = await service.run(
      { id: "agent-one", instructions: "Use a warm tone." },
      defaults,
      "Again",
    );
    assert.equal(second.text, "Reply with 2 user messages.");
    const system = fixture.requests
      .at(-1)
      .messages.filter(
        (message: any) =>
          message.role === "system" || message.role === "developer",
      );
    assert.ok(JSON.stringify(system).includes("Use a warm tone."));
    assert.equal(JSON.stringify(system).includes("Answer briefly."), false);
    assert.deepEqual(
      fixture.requests.at(-1).tools.map((tool: any) => tool.function.name),
      ["send_image"],
    );
    assert.equal(
      (await service.run({ id: "agent-two" }, defaults, "Hello")).text,
      "Reply with 1 user messages.",
    );
    await service.close();
    service = new PiService(directory);
    await service.ready;
    assert.equal(
      (await service.run({ id: "agent-one" }, defaults, "After restart")).text,
      "Reply with 3 user messages.",
    );
    const result = await service.run(
      { id: "agent-one" },
      defaults,
      "Please forward the image",
      [{ data: png, mimeType: "image/png" }],
    );
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].data, png);
    assert.ok(
      fixture.requests.some((request) =>
        JSON.stringify(request.messages).includes("image_url"),
      ),
    );
    const config = service.config();
    const edited = structuredClone(config.config) as any;
    edited.providers.fixture.models[0].name = "Updated catalog entry";
    await service.saveConfig(edited, config.version);
    assert.equal(
      (
        await service.run(
          { id: "agent-one" },
          { ...defaults, thinking_level: "low" },
          "After catalog save",
        )
      ).text,
      "Reply with 5 user messages.",
    );
    assert.equal(fixture.requests.at(-1).reasoning_effort, "small");
    const next = service.config();
    const textOnly = structuredClone(next.config) as any;
    textOnly.providers.fixture.models[0].input = ["text"];
    await service.saveConfig(textOnly, next.version);
    const count = fixture.requests.length;
    await assert.rejects(
      service.run({ id: "agent-one" }, defaults, "Image", [
        { data: png, mimeType: "image/png" },
      ]),
      /does not support image input/i,
    );
    assert.equal(
      fixture.requests.length,
      count,
      "unsupported images must not be silently dropped or sent to the model",
    );
  } finally {
    await service.close();
    await stopServer(fixture.server);
    rmSync(directory, { recursive: true, force: true });
  }
});
