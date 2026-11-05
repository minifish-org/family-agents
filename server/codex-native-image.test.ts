import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "./codex-client.js";
import { generatedImage } from "./codex-image.js";

const binary = process.env.CODEX_BIN;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";

test("native images generate and edit inline inputs while the deny-all file profile blocks repository, sibling, and symlink reads", {
  skip: !binary && "Set CODEX_BIN to run the isolated native image regression.", timeout: 25_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "family-native-images-"));
  const repository = join(directory, "repository"), a = join(repository, "data", "a", "workspace"), b = join(repository, "data", "b", "workspace");
  for (const path of [join(repository, ".git"), a, b]) mkdirSync(path, { recursive: true });
  writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
  const privateImage = join(repository, "data", "private.png"), siblingImage = join(b, "private.png"), aImage = join(a, "private.png"), alias = join(a, "alias.png");
  for (const path of [privateImage, siblingImage, aImage]) writeFileSync(path, png, "base64");
  symlinkSync(siblingImage, alias);
  const scripts: Record<string, string> = {
    GENERATE: 'text({generated:!!(await tools.image_gen__imagegen({prompt:"Draw a local red square fixture."})).image_url});',
    EDIT: 'text({generated:!!(await tools.image_gen__imagegen({prompt:"Edit the inline fixture.",num_last_images_to_include:1})).image_url});',
    DENY_A: `for(const path of ${JSON.stringify([privateImage, siblingImage, alias])}){try{await tools.image_gen__imagegen({prompt:"Read forbidden fixture.",referenced_image_paths:[path]});text("UNEXPECTED_READ");}catch{text("READ_BLOCKED");}}`,
    DENY_B: `try{await tools.image_gen__imagegen({prompt:"Read forbidden sibling.",referenced_image_paths:[${JSON.stringify(aImage)}]});text("UNEXPECTED_READ");}catch{text("READ_BLOCKED");}`,
    SIWC: 'text({names:ALL_TOOLS.map(x=>x.name),calculation:347*982,clock:await tools.clock__curr_time({})});',
  };
  const seen = new Set<string>(), outputs = new Map<string, string>(), definitions = new Map<string, string>();
  const imageRequests: Array<{ path: string; body: any }> = [], items: Array<{ threadId: string; item: any }> = [];
  let fixtureError: unknown;
  const client = new CodexClient(directory, { binary });
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") { response.writeHead(404).end("{}"); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url?.startsWith("/v1/images/")) {
        imageRequests.push({ path: request.url, body });
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ created: 1, data: [{ b64_json: png }] }));
        return;
      }
      assert.equal(request.url, "/v1/responses");
      const last = body.input.findLast((item: any) => item.type === "message" && item.role === "user");
      const label = last.content.find((item: any) => item.type === "input_text").text;
      assert.ok(scripts[label]);
      definitions.set(label, JSON.stringify(body.input.find((item: any) => item.type === "additional_tools")));
      const id = `response-${label}-${seen.size}`;
      const first = !seen.has(label);
      seen.add(label);
      if (!first) outputs.set(label, JSON.stringify(body.input.filter((item: any) => item.type === "custom_tool_call_output")));
      const item = first
        ? { type: "custom_tool_call", name: "exec", namespace: "functions", call_id: `call-${label}`, input: scripts[label] }
        : { type: "message", id: `answer-${label}`, role: "assistant", content: [{ type: "output_text", text: "Fixture completed." }] };
      response.writeHead(200, { "Content-Type": "text/event-stream" }).end([
        { type: "response.created", response: { id } }, { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    })().catch((error) => { fixtureError = error; if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  const turn = async (threadId: string, label: string, inline = false) => {
    let finish!: (value: any) => void;
    const done = new Promise<any>((resolve) => { finish = resolve; });
    const notification = (method: string, params: any) => { if (method === "turn/completed" && params.threadId === threadId) finish(params.turn); };
    client.on("notification", notification);
    try {
      await client.request("turn/start", { threadId, permissions: "family_agent", input: [
        { type: "text", text: label, text_elements: [] }, ...(inline ? [{ type: "image", url: `data:image/png;base64,${png}` }] : []),
      ] });
      assert.equal((await done).status, "completed");
      assert.ifError(fixtureError);
    } finally { client.off("notification", notification); }
  };
  client.on("notification", (method, params) => { if (method === "item/completed" && params.item?.type === "imageGeneration") items.push({ threadId: params.threadId, item: params.item }); });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/v1`;
    const original = (client as any).arguments.bind(client);
    (client as any).arguments = () => [
      ...original(), "-c", `model_providers.openai_chatgpt_plan.base_url=${JSON.stringify(base)}`,
      "-c", 'model_providers.image_fixture.name="Image fixture"', "-c", `model_providers.image_fixture.base_url=${JSON.stringify(base)}`,
      "-c", 'model_providers.image_fixture.wire_api="responses"', "-c", "model_providers.image_fixture.requires_openai_auth=true",
      "-c", "model_providers.image_fixture.supports_websockets=false", "-c", "features.enable_request_compression=false",
      ...((client as any).accessToken ? [] : ["-c", 'model_provider="image_fixture"']),
    ];
    const token = [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: "fixture", email: "fixture@example.org", exp: Math.floor(Date.now() / 1000) + 3600, "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account", chatgpt_plan_type: "plus" } })).toString("base64url"), "fixture"].join(".");
    await client.request("account/login/start", { type: "chatgptAuthTokens", accessToken: token, chatgptAccountId: "fixture-account", chatgptPlanType: "plus" });
    const start = async (cwd: string, provider = "image_fixture") => {
      const result: any = await client.request("thread/start", { model: "gpt-6.1-terra", modelProvider: provider, cwd, runtimeWorkspaceRoots: [cwd], permissions: "family_agent", approvalPolicy: "on-request", ephemeral: true });
      assert.equal(result.activePermissionProfile.id, "family_agent");
      return result.thread.id as string;
    };
    const threadA = await start(a), threadB = await start(b);
    await turn(threadA, "GENERATE");
    await turn(threadA, "EDIT", true);
    assert.deepEqual(imageRequests.map((request) => request.path), ["/v1/images/generations", "/v1/images/edits"]);
    assert.match(JSON.stringify(imageRequests[1].body), new RegExp(png.replace(/[+]/g, "\\+")));
    assert.equal(items.length, 2);
    for (const entry of items) assert.equal(generatedImage(client.homeDir, entry.threadId, entry.item).data, png);
    await turn(threadA, "DENY_A"); await turn(threadB, "DENY_B");
    assert.equal(imageRequests.length, 2, "denied file reads must not upload anything to the image API");
    assert.equal((outputs.get("DENY_A")!.match(/READ_BLOCKED/g) ?? []).length, 3);
    assert.match(outputs.get("DENY_B")!, /READ_BLOCKED/);
    assert.doesNotMatch(outputs.get("DENY_A")! + outputs.get("DENY_B")!, /UNEXPECTED_READ/);
    assert.match(definitions.get("GENERATE")!, /image_gen__imagegen/);
    await client.setAccessToken("dummy-siwc-fixture");
    const direct = await start(a, "openai_chatgpt_plan");
    await turn(direct, "SIWC");
    assert.doesNotMatch(definitions.get("SIWC")!, /image_gen__imagegen/);
    assert.match(outputs.get("SIWC")!, /340754/);
    assert.match(outputs.get("SIWC")!, /current_time/);
  } finally {
    await client.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
