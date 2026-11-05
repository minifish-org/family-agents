import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "./codex-client.js";

function fixture(options: { requestTimeoutMs?: number; shutdownTimeoutMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "family-codex-client-"));
  const path = join(dir, "fake.cjs");
  writeFileSync(path, `
const readline = require("node:readline");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({input:process.stdin}).on("line", line => {
  const message = JSON.parse(line);
  if (!message.method) { send({method:"test/response",params:message}); return; }
  if (message.method === "initialize") {
    process.stderr.write("private diagnostic that must not become protocol\\n");
    const result=JSON.stringify({id:message.id,result:{userAgent:"fake"}})+"\\n";
    process.stdout.write(result.slice(0,7));
    setTimeout(()=>process.stdout.write(result.slice(7)),5);
  } else if (message.method === "initialized") {
    send({method:"test/initialized",params:{ready:true}});
  } else if (message.method === "echo") {
    setTimeout(()=>send({id:message.id,result:message.params}),message.params.delay || 0);
  } else if (message.method === "approvals") {
    ["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/permissions/requestApproval","execCommandApproval","applyPatchApproval","item/tool/requestUserInput","unsupported/request"].forEach((method,index)=>send({id:"server-"+index,method,params:{threadId:"thread-a",turnId:"turn-a"}}));
    send({id:message.id,result:true});
  } else if (message.method === "tool") {
    send({id:"tool-1",method:"item/tool/call",params:{tool:message.params.tool}});
    send({id:message.id,result:true});
  } else if (message.method === "crash") {
    process.exit(42);
  } else if (message.method === "invalid") {
    process.stdout.write("not-json\\n");
  } else if (message.method === "secretError") {
    send({id:message.id,error:{code:-123,message:"secret-api-key-token"}});
  } else if (message.method === "environment") {
    send({id:message.id,result:{home:process.env.HOME,codexHome:process.env.CODEX_HOME,hasKey:!!process.env.OPENAI_API_KEY,hasSiwc:!!process.env.FAMILY_CODEX_SIWC_TOKEN,pid:process.pid}});
  } else if (message.method === "stubborn") {
    process.on("SIGTERM",()=>{});
    setInterval(()=>{},1000);
    send({id:message.id,result:true});
  } else if (message.method === "hang") {}
});
`);
  const client = new CodexClient(dir, { binary: process.execPath, args: [path], ...options });
  return {
    client,
    async close() { await client.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test("Codex client frames JSONL, completes handshake once and correlates out-of-order responses", async () => {
  const f = fixture();
  let initialized = 0;
  f.client.on("notification", (method) => { if (method === "test/initialized") initialized++; });
  try {
    await Promise.all([f.client.start(), f.client.start()]);
    const replies = await Promise.all([
      f.client.request("echo", { value: "first", delay: 30 }),
      f.client.request("echo", { value: "second" }),
    ]);
    assert.deepEqual(replies, [{ value: "first", delay: 30 }, { value: "second" }]);
    assert.equal(initialized, 1);
  } finally { await f.close(); }
});

test("Codex client rejects every approval safely and responds to unsupported requests", async () => {
  const f = fixture();
  const replies: any[] = [];
  const complete = new Promise<void>((resolve) => {
    f.client.on("notification", (method, params) => {
      if (method === "test/response") {
        replies.push(params);
        if (replies.length === 7) resolve();
      }
    });
  });
  try {
    await f.client.request("approvals");
    await complete;
    assert.deepEqual(replies[0].result, { decision: "decline" });
    assert.deepEqual(replies[1].result, { decision: "decline" });
    assert.deepEqual(replies[2].result, { permissions: {}, scope: "turn" });
    assert.deepEqual(replies[3].result, { decision: "denied" });
    assert.deepEqual(replies[4].result, { decision: "denied" });
    assert.deepEqual(replies[5].result, { answers: {} });
    assert.equal(replies[6].error.code, -32601);
  } finally { await f.close(); }
});

test("Codex client delegates only fixed tool requests and strips native error bodies", async () => {
  const f = fixture();
  const received = new Promise<any>((resolve) => {
    f.client.on("notification", (method, params) => {
      if (method === "test/response" && params.id === "tool-1") resolve(params);
    });
  });
  let calls = 0;
  f.client.setRequestHandler((method, params) => {
    calls++;
    assert.equal(method, "item/tool/call");
    assert.equal(params.tool, "send_image");
    return { success: true, contentItems: [] };
  });
  try {
    await f.client.request("tool", { tool: "send_image" });
    assert.deepEqual((await received).result, { success: true, contentItems: [] });
    assert.equal(calls, 1);
    await assert.rejects(f.client.request("secretError"), (error: any) => {
      assert.equal(error.code, -123);
      assert.doesNotMatch(error.message, /secret-api-key-token/);
      return true;
    });
  } finally { await f.close(); }
});

test("Codex process crash rejects all work and a later request reconnects without replay", async () => {
  const f = fixture();
  let disconnects = 0;
  f.client.on("disconnect", () => disconnects++);
  try {
    const hanging = f.client.request("hang");
    const crash = f.client.request("crash");
    const results = await Promise.allSettled([hanging, crash]);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.equal(disconnects, 1);
    assert.deepEqual(await f.client.request("echo", { value: "new" }), { value: "new" });
    await f.client.close();
    assert.deepEqual(await f.client.request("echo", { value: "reopened" }), { value: "reopened" });
  } finally { await f.close(); }
});

test("Codex invalid framing and timeouts disconnect safely instead of replaying requests", async () => {
  const f = fixture({ requestTimeoutMs: 100 });
  try {
    await assert.rejects(f.client.request("invalid"), /invalid protocol/);
    await assert.rejects(f.client.request("hang"), /timed out/);
    assert.deepEqual(await f.client.request("echo", { value: "new" }), { value: "new" });
  } finally { await f.close(); }
});

test("Codex missing binary fails promptly and keeps installation guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-codex-missing-"));
  const client = new CodexClient(dir, { binary: join(dir, "missing") });
  try { await assert.rejects(client.start(), /not installed/); }
  finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Codex process receives an isolated home and no inherited provider key", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-private-provider-key";
  const f = fixture();
  try {
    const environment: any = await f.client.request("environment");
    assert.equal(environment.codexHome, f.client.homeDir);
    assert.notEqual(environment.home, process.env.HOME);
    assert.equal(environment.hasKey, false);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await f.close();
  }
});

test("Codex shutdown is bounded when a child ignores EOF and termination", async () => {
  const f = fixture({ shutdownTimeoutMs: 10 });
  try {
    await f.client.request("stubborn");
    const began = Date.now();
    await f.client.close();
    assert.ok(Date.now() - began < 2000);
    assert.deepEqual(await f.client.request("echo", { value: "reopened" }), { value: "reopened" });
  } finally { await f.close(); }
});


test("SIWC credentials reach only the isolated child environment and provider changes restart the process", async () => {
  const f = fixture();
  try {
    const native: any = await f.client.request("environment");
    assert.equal(native.hasSiwc, false);
    await f.client.setAccessToken("fixture-siwc-token");
    const siwc: any = await f.client.request("environment");
    assert.equal(siwc.hasSiwc, true); assert.equal(siwc.hasKey, false);
    assert.notEqual(siwc.pid, native.pid);
    await f.client.setAccessToken(undefined);
    const restored: any = await f.client.request("environment");
    assert.equal(restored.hasSiwc, false); assert.notEqual(restored.pid, siwc.pid);
  } finally { await f.close(); }
});
