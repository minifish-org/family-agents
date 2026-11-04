/** Live deployment acceptance driver. Credentials stay in private external probe config files. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const recovery = process.env.LIVE_RECOVERY_DIR;
if (!recovery)
  throw new Error(
    "Set LIVE_RECOVERY_DIR to the private directory containing probe-owner.json, probe-agent.json, and probe-outsider.json.",
  );
const base = process.env.LIVE_API ?? "http://172.23.0.2:18091";
const data = process.env.LIVE_DATA_DIR ?? join(root, "data");
const binary = join(root, "gateway", "target", "release", "matrix-probe");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const ownerConfig = JSON.parse(
  readFileSync(join(recovery, "probe-owner.json"), "utf8"),
);
const botConfig = JSON.parse(
  readFileSync(join(recovery, "probe-agent.json"), "utf8"),
);
const outsiderConfig = JSON.parse(
  readFileSync(join(recovery, "probe-outsider.json"), "utf8"),
);
const checks = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function record(name, detail = {}) {
  checks.push({ name, status: "passed", ...detail });
  console.log(JSON.stringify({ check: name, status: "passed", ...detail }));
}
async function until(check, message, timeout = 90000) {
  const started = Date.now();
  let error;
  while (Date.now() - started < timeout) {
    try {
      const result = await check();
      if (result) return result;
    } catch (e) {
      error = e;
    }
    await sleep(500);
  }
  throw new Error(`${message}${error ? ": " + error.message : ""}`);
}
async function api(path, method = "GET", body, expected = 200) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const value = await response.json();
  assert.equal(
    response.status,
    expected,
    `${method} ${path}: ${value.error ?? response.status}`,
  );
  return value;
}
class Probe {
  events = [];
  requests = new Map();
  constructor(path) {
    this.child = spawn(binary, [path], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const item = JSON.parse(line);
        if (item.id && this.requests.has(item.id)) {
          const request = this.requests.get(item.id);
          this.requests.delete(item.id);
          clearTimeout(request.timer);
          item.ok
            ? request.resolve(item.result)
            : request.reject(new Error(item.error));
        } else this.events.push(item);
      }
    });
    this.child.stderr.on("data", () => {});
    this.child.on("exit", (code) => {
      for (const request of this.requests.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("Probe exited with status " + code));
      }
      this.requests.clear();
    });
  }
  request(op, args = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error("Probe " + op + " timed out."));
      }, 90000);
      this.requests.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + "\n");
    });
  }
  ready() {
    return until(
      () => this.events.find((event) => event.event === "ready"),
      "Probe did not become ready.",
    );
  }
  message(room, sender, after = 0, predicate = () => true) {
    return until(
      () =>
        this.events
          .slice(after)
          .find(
            (event) =>
              event.event === "message" &&
              event.room_id === room &&
              event.sender === sender &&
              predicate(event),
          ),
      "Encrypted reply did not arrive.",
      120000,
    );
  }
  async close() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.write('{"op":"shutdown"}\n');
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      sleep(5000),
    ]);
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
  }
}
function device(id) {
  return JSON.parse(
    readFileSync(join(data, "matrix", id, "session.json"), "utf8"),
  ).session.device_id;
}
function userTurns(id) {
  const dir = join(data, "agents", id, "sessions");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").trim().split("\n"))
    .map((line) => JSON.parse(line))
    .filter(
      (entry) => entry.type === "message" && entry.message?.role === "user",
    ).length;
}
function sidecar() {
  const processes = readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .flatMap((name) => {
      try {
        const args = readFileSync("/proc/" + name + "/cmdline", "utf8").split(
          "\0",
        );
        return args[0]?.endsWith("/family-matrix-gateway")
          ? [Number(name)]
          : [];
      } catch {
        return [];
      }
    });
  assert.equal(processes.length, 1, "exactly one main Matrix Gateway must run");
  return processes[0];
}
async function profile() {
  const response = await fetch(
    ownerConfig.homeserver +
      "/_matrix/client/v3/profile/" +
      encodeURIComponent(botConfig.matrix_id),
    { signal: AbortSignal.timeout(10000) },
  );
  return response.ok ? response.json() : {};
}
async function waitRunning(id) {
  return until(async () => {
    const agent = await api("/agents/" + id);
    if (agent.status === "Error") throw new Error(agent.error);
    return agent.status === "Running" ? agent : false;
  }, "Agent did not become Running.");
}

let owner, outsider, person, agent, room, outsiderRoom, groupRoom, server;
let originalSettings, originalConfig, originalProfile;
let failure;
try {
  await until(async () => {
    const health = await api("/health");
    return (
      health.status === "ready" &&
      health.agents.every((agent) => agent.status === "Running")
    );
  }, "Main application not ready.");
  originalSettings = await api("/settings");
  originalProfile = await profile();
  owner = new Probe(join(recovery, "probe-owner.json"));
  outsider = new Probe(join(recovery, "probe-outsider.json"));
  await Promise.all([owner.ready(), outsider.ready()]);
  person = await api(
    "/people",
    "POST",
    { matrix_id: ownerConfig.matrix_id },
    201,
  );
  assert.ok(person.display_name);
  record("Person profile lookup", { display_name: person.display_name });
  agent = await api(
    "/agents",
    "POST",
    {
      person_id: person.id,
      matrix_id: botConfig.matrix_id,
      password: botConfig.password,
      display_name: "Family Agents V2 validation",
      avatar: null,
      instructions:
        "You are a validation assistant. Follow the owner request concisely. Remember information across messages.",
    },
    201,
  );
  agent = await waitRunning(agent.id);
  assert.equal(
    (await api("/health")).agents.filter((agent) => agent.status === "Running")
      .length,
    2,
  );
  const originalDevice = device(agent.id),
    dotBefore = (await api("/agents")).find((value) => value.id !== agent.id),
    dotDevice = device(dotBefore.id);
  assert.ok(sidecar());
  record("Two Agent accounts share one Gateway");
  ({ room_id: room } = await owner.request("create_dm", {
    invite: [botConfig.matrix_id],
  }));
  await until(async () => {
    const result = await owner.request("members", { room_id: room });
    return (
      result.members.includes(botConfig.matrix_id) &&
      result.members.length === 2
    );
  }, "Agent did not join owner direct conversation.");
  const token = "V2-" + randomUUID();
  let offset = owner.events.length;
  const sent = await owner.request("send_message", {
    room_id: room,
    text: `Remember the exact validation token ${token}. Reply with exactly STORED.`,
  });
  assert.equal(sent.encrypted, true);
  const first = await owner.message(
    room,
    botConfig.matrix_id,
    offset,
    (event) => event.body.includes("STORED"),
  );
  assert.equal(first.encrypted, true);
  record("Encrypted owner DM through real Pi provider");
  console.log(JSON.stringify({ phase: "main-service-restart" }));
  execFileSync("sudo", [
    "-n",
    "docker",
    "exec",
    "webtop-desktop",
    "/command/s6-svc",
    "-r",
    "/run/service/family-agents",
  ]);
  await sleep(1500);
  await until(async () => {
    const health = await api("/health");
    return (
      health.status === "ready" &&
      health.agents.length === 2 &&
      health.agents.every((agent) => agent.status === "Running")
    );
  }, "Service did not restore both Agents after restart.");
  assert.equal(device(agent.id), originalDevice);
  assert.equal(device(dotBefore.id), dotDevice);
  offset = owner.events.length;
  await owner.request("send_message", {
    room_id: room,
    text: "What exact validation token did I ask you to remember? Reply with the token only.",
  });
  const restored = await owner.message(
    room,
    botConfig.matrix_id,
    offset,
    (event) => event.body.includes(token),
  );
  assert.equal(restored.encrypted, true);
  record(
    "Persistent Pi context and Matrix device continuity after service restart",
  );
  originalConfig = await api("/providers/config");

  const beforeNegatives = userTurns(agent.id);
  ({ room_id: outsiderRoom } = await outsider.request("create_dm", {
    invite: [botConfig.matrix_id],
  }));
  await outsider.request("send_message", {
    room_id: outsiderRoom,
    text: "Unauthorized validation: reply to this message.",
  });
  ({ room_id: groupRoom } = await owner.request("create_dm", {
    direct: false,
    invite: [botConfig.matrix_id, outsiderConfig.matrix_id],
  }));
  await owner.request("send_message", {
    room_id: groupRoom,
    text: "Group validation: reply to this message.",
  });
  await owner.request("invite", {
    room_id: room,
    matrix_id: outsiderConfig.matrix_id,
  });
  await until(async () => {
    const value = await owner.request("members", { room_id: room });
    return value.members.includes(outsiderConfig.matrix_id);
  }, "Third-party invite did not synchronize.");
  const negativeOffset = owner.events.length;
  await owner.request("send_message", {
    room_id: room,
    text: "This conversation now has a third participant. Reply GROUP-UNSAFE.",
  });
  await sleep(7000);
  assert.equal(userTurns(agent.id), beforeNegatives);
  assert.equal(
    owner.events
      .slice(negativeOffset)
      .some(
        (event) =>
          event.sender === botConfig.matrix_id && event.event === "message",
      ),
    false,
  );
  record(
    "Unauthorized sender and group membership ignored without Pi execution",
  );
  await until(
    () =>
      outsider.events.some(
        (event) => event.event === "invite" && event.room_id === room,
      ),
    "Outsider did not receive temporary room invitation.",
  );
  await outsider.request("join", { room_id: room });
  await outsider.request("leave", { room_id: room });
  await until(async () => {
    const value = await owner.request("members", { room_id: room });
    return value.members.length === 2;
  }, "Owner-only room membership did not restore.");

  const oldName = originalProfile.displayname ?? botConfig.matrix_id;
  agent = await api("/agents/" + agent.id);
  const newName = "V2 validation " + randomUUID().slice(0, 8);
  agent = await api("/agents/" + agent.id, "PUT", {
    version: agent.version,
    matrix_id: agent.matrix_id,
    password: "",
    display_name: newName,
    avatar: { data: png, mime_type: "image/png" },
    instructions: agent.instructions,
  });
  assert.equal(agent.status, "Running");
  let matrixProfile = await profile();
  assert.equal(matrixProfile.displayname, newName);
  assert.ok(matrixProfile.avatar_url?.startsWith("mxc://"));
  agent = await api("/agents/" + agent.id, "PUT", {
    version: agent.version,
    matrix_id: agent.matrix_id,
    password: "",
    display_name: oldName,
    avatar: null,
    instructions: agent.instructions,
  });
  matrixProfile = await profile();
  assert.equal(matrixProfile.displayname, oldName);
  assert.ok(!matrixProfile.avatar_url);
  assert.equal(device(agent.id), originalDevice);
  record(
    "Blank-password edit preserves credentials; Matrix name and avatar upload/clear synchronize",
  );

  const requests = [];
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const last = body.messages.at(-1);
    const forward =
      last.role === "user" &&
      JSON.stringify(last.content).includes("image_url");
    const delta = forward
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call-live-forward",
              type: "function",
              function: {
                name: "send_image",
                arguments: '{"attachment_index":0}',
              },
            },
          ],
        }
      : { role: "assistant", content: "Live vision fixture response." };
    const event = {
      id: "fixture-" + requests.length,
      object: "chat.completion.chunk",
      created: 1,
      model: "vision-fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: " + JSON.stringify(event) + "\n\n");
    event.choices = [
      { index: 0, delta: {}, finish_reason: forward ? "tool_calls" : "stop" },
    ];
    event.usage = {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
    };
    response.end("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "172.23.0.1", resolve));
  const port = server.address().port;
  const config = structuredClone(originalConfig.config);
  config.providers["live-vision-fixture"] = {
    baseUrl: `http://172.23.0.1:${port}/v1`,
    apiKey: "local-fixture-key",
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: "vision-fixture",
        name: "Live vision fixture",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          medium: null,
          xhigh: null,
          max: "maximum",
        },
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 4096,
        compat: { maxTokensField: "max_tokens", supportsStore: false },
      },
      {
        id: "without-max",
        name: "No Max fixture",
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: null },
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  };
  await api("/providers/config", "PUT", {
    config,
    version: originalConfig.version,
  });
  const supported = await api("/model-selection", "POST", {
    provider: "live-vision-fixture",
    model: "vision-fixture",
    thinking_level: "max",
  });
  assert.ok(supported.thinking_levels.includes("max"));
  assert.equal(supported.thinking_level, "max");
  const clamped = await api("/model-selection", "POST", {
    provider: "live-vision-fixture",
    model: "without-max",
    thinking_level: "max",
  });
  assert.ok(!clamped.thinking_levels.includes("max"));
  assert.equal(clamped.thinking_level, "high");
  const settings = await api("/settings");
  await api("/settings", "PUT", {
    ...settings,
    provider: "live-vision-fixture",
    model: "vision-fixture",
    thinking_level: "max",
  });
  await api("/settings", "PUT", { ...settings, thinking_level: "off" }, 409);
  record(
    "Native custom provider, dynamic Max support, model clamping and stale settings conflict",
  );
  offset = owner.events.length;
  const imageSent = await owner.request("send_image", {
    room_id: room,
    data: png,
    mime_type: "image/png",
    text: "Please forward this image back to me.",
  });
  assert.equal(imageSent.encrypted, true);
  const returned = await owner.message(
    room,
    botConfig.matrix_id,
    offset,
    (event) => !!event.media,
  );
  assert.equal(returned.encrypted, true);
  assert.equal(returned.media.encrypted, true);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(returned.media.data, "base64"))
      .digest("hex"),
    createHash("sha256").update(Buffer.from(png, "base64")).digest("hex"),
  );
  assert.ok(
    requests.some((request) =>
      JSON.stringify(request.messages).includes("image_url"),
    ),
  );
  assert.equal(requests.at(-1).reasoning_effort, "maximum");
  record(
    "Encrypted image input reaches Pi; safe tool returns byte-identical encrypted image",
  );

  const beforeCrashTurns = userTurns(agent.id),
    beforeCrashDevice = device(agent.id),
    oldSidecar = sidecar();
  process.kill(oldSidecar, "SIGKILL");
  await until(async () => {
    const health = await api("/health");
    return (
      health.gateway &&
      health.agents.length === 2 &&
      health.agents.every((value) => value.status === "Running") &&
      sidecar() !== oldSidecar
    );
  }, "Matrix Gateway did not recover.");
  assert.equal(device(agent.id), beforeCrashDevice);
  assert.equal(userTurns(agent.id), beforeCrashTurns);
  offset = owner.events.length;
  await owner.request("send_message", {
    room_id: room,
    text: "Gateway recovery validation.",
  });
  await owner.message(room, botConfig.matrix_id, offset, (event) =>
    event.body.includes("Live vision fixture response."),
  );
  record(
    "Gateway crash supervision restores both accounts without duplicate Pi turns",
  );

  agent = await api("/agents/" + agent.id);
  await api("/agents/" + agent.id + "/stop", "POST", {
    version: agent.version,
  });
  const crypto = join(
    data,
    "matrix",
    agent.id,
    "sqlite",
    "matrix-sdk-crypto.sqlite3",
  );
  writeFileSync(crypto, "Family Agents intentionally corrupt test database.");
  for (const suffix of ["-wal", "-shm"])
    rmSync(crypto + suffix, { force: true });
  agent = await api("/agents/" + agent.id);
  agent = await api("/agents/" + agent.id + "/start", "POST", {
    version: agent.version,
  });
  assert.equal(agent.status, "Running", agent.error ?? "Recovery failed.");
  const resetRoot = join(data, "matrix", agent.id);
  assert.ok(existsSync(join(resetRoot, "automatic-reset.json")));
  assert.ok(
    readdirSync(resetRoot).some((name) => name.startsWith("recovery-")),
  );
  assert.notEqual(device(agent.id), beforeCrashDevice);
  record(
    "Classified local crypto-store corruption triggers one controlled archived reset",
  );
  await api("/agents/" + agent.id + "/stop", "POST", {
    version: agent.version,
  });
  writeFileSync(crypto, "Family Agents second intentional corruption.");
  for (const suffix of ["-wal", "-shm"])
    rmSync(crypto + suffix, { force: true });
  agent = await api("/agents/" + agent.id);
  agent = await api("/agents/" + agent.id + "/start", "POST", {
    version: agent.version,
  });
  assert.equal(agent.status, "Error");
  assert.match(agent.error ?? "", /already attempted/);
  record(
    "Repeated corruption is bounded and reports Error instead of resetting endlessly",
  );
} catch (error) {
  failure = error;
  console.error(JSON.stringify({ status: "failed", message: error.message }));
} finally {
  const cleanup = [];
  if (originalConfig) {
    try {
      const current = await api("/providers/config");
      await api("/providers/config", "PUT", {
        config: originalConfig.config,
        version: current.version,
      });
      cleanup.push("Original provider configuration restored");
    } catch (error) {
      cleanup.push("Provider restore failed: " + error.message);
      failure ??= error;
    }
  }
  if (originalSettings) {
    try {
      const current = await api("/settings");
      await api("/settings", "PUT", {
        ...originalSettings,
        version: current.version,
      });
      cleanup.push("Original global settings restored");
    } catch (error) {
      cleanup.push("Settings restore failed: " + error.message);
      failure ??= error;
    }
  }
  if (agent) {
    try {
      const current = await api("/agents/" + agent.id);
      await api("/agents/" + agent.id, "DELETE", { version: current.version });
      cleanup.push("Temporary Agent removed");
    } catch (error) {
      cleanup.push("Agent cleanup failed: " + error.message);
      failure ??= error;
    }
  }
  if (person) {
    try {
      await api("/people/" + person.id, "DELETE");
      cleanup.push("Temporary Person removed");
    } catch (error) {
      cleanup.push("Person cleanup failed: " + error.message);
      failure ??= error;
    }
  }
  for (const [probe, rooms] of [
    [owner, [room, groupRoom]],
    [outsider, [room, outsiderRoom, groupRoom]],
  ])
    if (probe)
      for (const roomId of rooms.filter(Boolean))
        try {
          await probe.request("leave", { room_id: roomId });
        } catch {}
  await Promise.allSettled([owner?.close(), outsider?.close()]);
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  const report = {
    completed_at: new Date().toISOString(),
    status: failure ? "failed" : "passed",
    checks,
    cleanup,
    ...(failure ? { error: failure.message } : {}),
  };
  writeFileSync(
    join(recovery, "live-e2e-results.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ status: report.status, checks: checks.length, cleanup }),
  );
}
if (failure) process.exitCode = 1;
