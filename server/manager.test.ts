import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.js";
import { Manager } from "./manager.js";
import { createApp } from "./app.js";

class FakeGateway extends EventEmitter {
  ready = true;
  calls: Array<{ op: string; args: any }> = [];
  safe = true;
  failSend = false;
  async request(op: string, args: any) {
    this.calls.push({ op, args });
    if (op === "validate_room" && !this.safe) throw new Error("Unsafe room.");
    if (this.failSend && (op === "send_message" || op === "send_media"))
      throw new Error("Temporary Matrix send failure.");
    return {
      is_direct: true,
      encrypted: true,
      members: ["@owner:example.org", "@bot:example.org"],
    };
  }
  async start() {}
  async close() {}
}
test("owner-only DM routing, persistent duplicates, images and outbound transaction IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "family-manager-"));
  const s = new Store(dir),
    g = new FakeGateway();
  let runs = 0;
  const pi = {
    ready: Promise.resolve(),
    resolveModel: () => ({}),
    initializeAgent: async () => {},
    sanitizeError: (e: unknown) => String(e),
    run: async (_a: any, _s: any, text: string, images: any[]) => {
      runs++;
      assert.equal(text, "Hello");
      assert.equal(images.length, 1);
      return { text: "Reply", images: [] };
    },
    stopAgent: async () => {},
    close: async () => {},
  };
  const m = new Manager(s, pi as any, g as any);
  try {
    const p = s.addPerson("@owner:example.org", "Owner");
    s.db
      .prepare(
        "INSERT INTO agents(id,person_id,matrix_id,display_name,status) VALUES('a',?,'@bot:example.org','Bot','Running')",
      )
      .run(p.id);
    const event = {
      event: "message",
      agent_id: "a",
      event_id: "$1",
      room_id: "!dm:example.org",
      sender: p.matrix_id,
      body: "Hello",
      is_direct: true,
      members: [p.matrix_id, "@bot:example.org"],
      media: { data: "aGVsbG8=", mime_type: "image/png" },
    };
    await m.receive({ ...event, sender: "@stranger:example.org" });
    await m.receive({
      ...event,
      members: [...event.members, "@third:example.org"],
    });
    await m.receive({ ...event, is_direct: false });
    assert.equal(runs, 0);
    await m.receive(event);
    await m.receive(event);
    assert.equal(runs, 1);
    const sends = g.calls.filter((c) => c.op === "send_message");
    assert.equal(sends.length, 1);
    assert.ok(sends[0].args.txn_id);
    assert.equal(sends[0].args.room_id, event.room_id);
    assert.equal(s.outbox("a").length, 0);
    g.safe = false;
    await m.receive({ ...event, event_id: "$2" });
    assert.equal(runs, 1);
    assert.equal(s.agent("a").status, "Error");
    const app = createApp(m);
    assert.equal((await app.request("/api/people")).status, 200);
    const cross = await app.request("/api/people", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.invalid",
      },
      body: JSON.stringify({ matrix_id: "@bad:example.org" }),
    });
    assert.equal(cross.status, 403);
  } finally {
    await m.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "family-lifecycle-")),
    store = new Store(dir),
    gateway = new FakeGateway();
  const owner = store.addPerson("@owner:example.org", "Owner");
  store.db
    .prepare(
      "INSERT INTO agents(id,person_id,matrix_id,display_name,status) VALUES('a',?,'@bot:example.org','Bot','Running')",
    )
    .run(owner.id);
  store.setPassword("a", "matrix-password");
  store.saveSettings({
    ...store.settings(),
    homeserver: "https://matrix.example.org",
    provider: "fixture",
    model: "fixture-model",
  });
  const calls = { runs: 0, stops: 0, initializations: 0 };
  const pi = {
    ready: Promise.resolve(),
    resolveModel: () => ({}),
    sanitizeError: (error: unknown) => String(error),
    initializeAgent: async () => {
      calls.initializations++;
    },
    run: async (..._args: unknown[]) => {
      calls.runs++;
      return { text: "Reply", images: [] };
    },
    stopAgent: async () => {
      calls.stops++;
    },
    close: async () => {},
  };
  const manager = new Manager(store, pi as any, gateway as any);
  const event = {
    event: "message",
    agent_id: "a",
    event_id: "$one",
    room_id: "!dm:example.org",
    sender: owner.matrix_id,
    body: "Hello",
    is_direct: true,
    members: [owner.matrix_id, "@bot:example.org"],
  };
  return {
    dir,
    store,
    gateway,
    pi,
    calls,
    manager,
    event,
    close: async () => {
      await manager.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("rejected attachments are acknowledged and a fresh message can continue after a model error", async () => {
  const f = fixture();
  try {
    await f.manager.receive({
      ...f.event,
      event_id: "$unsupported",
      media: { data: "aGVsbG8=", mime_type: "image/svg+xml" },
    });
    assert.equal(f.calls.runs, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT state FROM inbox WHERE event_id='$unsupported'")
        .get()!.state,
      "rejected",
    );
    assert.ok(
      f.gateway.calls.some(
        (call) =>
          call.op === "ack_event" && call.args.event_id === "$unsupported",
      ),
    );
    f.pi.run = async () => {
      f.calls.runs++;
      throw new Error("Model temporarily unavailable.");
    };
    await f.manager.receive({ ...f.event, event_id: "$failed" });
    assert.equal(f.store.agent("a").status, "Error");
    f.pi.run = async () => {
      f.calls.runs++;
      return { text: "Recovered", images: [] };
    };
    await f.manager.receive({ ...f.event, event_id: "$fresh" });
    assert.equal(f.store.agent("a").status, "Running");
    assert.equal(f.calls.runs, 2);
    await f.manager.receive({ ...f.event, event_id: "$failed" });
    assert.equal(
      f.calls.runs,
      2,
      "the failed earlier turn must never be rerun",
    );
  } finally {
    await f.close();
  }
});

test("stale lifecycle and configuration edits never interrupt the active Agent", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  f.pi.run = async () => {
    f.calls.runs++;
    entered();
    await gate;
    return { text: "Completed before stale edit", images: [] };
  };
  try {
    const receive = f.manager.receive(f.event);
    await began;
    const staleStop = f.manager.lifecycle("a", "stop", 999);
    assert.equal(f.calls.stops, 0);
    release();
    await receive;
    await assert.rejects(staleStop, { status: 409 });
    await assert.rejects(f.manager.delete("a", 999), { status: 409 });
    await assert.rejects(
      f.manager.edit("a", {
        version: 999,
        matrix_id: "@bot:example.org",
        display_name: "Changed",
        instructions: "Changed",
      }),
      { status: 409 },
    );
    assert.equal(f.calls.stops, 0);
    assert.equal(f.store.agent("a").status, "Running");
    assert.equal(
      f.gateway.calls.filter((call) => call.op === "stop").length,
      0,
    );
    assert.equal(
      f.gateway.calls.filter((call) => call.op === "send_message").length,
      1,
    );
  } finally {
    release();
    await f.close();
  }
});

test("changing a stopped Agent Matrix identity isolates old queued work and stores", async () => {
  const f = fixture();
  try {
    f.store.db
      .prepare("UPDATE agents SET desired=0,status='Stopped' WHERE id='a'")
      .run();
    f.store.enqueue("a", "$old", "!old:example.org", f.event);
    f.store.addOutbox("a", "!old:example.org", { text: "Old reply" });
    const oldStore = join(f.dir, "matrix", "a");
    mkdirSync(oldStore, { recursive: true });
    writeFileSync(join(oldStore, "old-device"), "old");
    const agent = await f.manager.edit("a", {
      version: 1,
      matrix_id: "@replacement:example.org",
      password: "replacement-password",
      display_name: "Replacement",
      instructions: "New instructions",
    });
    assert.equal(agent.matrix_id, "@replacement:example.org");
    assert.equal(agent.status, "Stopped");
    assert.equal(f.store.password("a"), "replacement-password");
    assert.equal(f.store.pending("a").length, 0);
    assert.equal(f.store.outbox("a").length, 0);
    assert.equal(existsSync(oldStore), false);
    assert.equal(readdirSync(join(f.dir, "matrix-archives")).length, 1);
    assert.equal(
      f.gateway.calls.filter((call) => call.op === "send_message").length,
      0,
    );
    assert.equal(f.calls.runs, 0);
  } finally {
    await f.close();
  }
});

test("homeserver changes isolate work and crypto stores for running and stopped Agents", async () => {
  const f = fixture();
  try {
    const owner = f.store.people()[0];
    f.store.db
      .prepare(
        "INSERT INTO agents(id,person_id,matrix_id,display_name,status,desired) VALUES('b',?,'@second:example.org','Second','Stopped',0)",
      )
      .run(owner.id);
    for (const id of ["a", "b"]) {
      f.store.enqueue(id, "$old", "!old:example.org", f.event);
      f.store.addOutbox(id, "!old:example.org", { text: "Old server reply" });
      const path = join(f.dir, "matrix", id);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "device"), "old");
    }
    f.store.saveSettings({
      ...f.store.settings(),
      homeserver: "https://new.example.org",
    });
    await f.manager.reconnectAll();
    for (const id of ["a", "b"]) {
      assert.equal(f.store.pending(id).length, 0);
      assert.equal(f.store.outbox(id).length, 0);
    }
    const starts = f.gateway.calls.filter((call) => call.op === "start");
    assert.equal(starts.length, 1);
    assert.equal(starts[0].args.homeserver, "https://new.example.org");
    assert.equal(existsSync(join(f.dir, "matrix", "b")), false);
    assert.equal(readdirSync(join(f.dir, "matrix-archives")).length, 2);
    assert.equal(f.calls.runs, 0);
    assert.equal(
      f.gateway.calls.filter((call) => call.op === "send_message").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("failed outbound delivery is visible and retry keeps the original transaction without rerunning Pi", async () => {
  const f = fixture();
  try {
    f.gateway.failSend = true;
    await f.manager.receive(f.event);
    assert.equal(f.calls.runs, 1);
    assert.equal(f.store.agent("a").status, "Error");
    assert.match(f.store.agent("a").error ?? "", /^Reply delivery pending:/);
    const pending = f.store.outbox("a");
    assert.equal(pending.length, 1);
    f.gateway.failSend = false;
    await f.manager.lifecycle("a", "start", f.store.agent("a").version);
    assert.equal(f.store.agent("a").status, "Running");
    assert.equal(f.store.outbox("a").length, 0);
    assert.equal(f.calls.runs, 1);
    const sends = f.gateway.calls.filter((call) => call.op === "send_message");
    assert.equal(sends.length, 2);
    assert.equal(sends[0].args.txn_id, pending[0].id);
    assert.equal(sends[1].args.txn_id, pending[0].id);
    await f.manager.proactive("a", {
      room_id: f.event.room_id,
      txn_id: "operator-one",
      text: "Proactive reply",
    });
    await assert.rejects(
      f.manager.proactive("a", {
        room_id: f.event.room_id,
        txn_id: "operator-one",
        text: "Different reply",
      }),
      { status: 409 },
    );
    const count = f.gateway.calls.filter(
      (call) => call.op === "send_message",
    ).length;
    await f.manager.proactive("a", {
      room_id: f.event.room_id,
      txn_id: "operator-one",
      text: "Proactive reply",
    });
    assert.equal(
      f.gateway.calls.filter((call) => call.op === "send_message").length,
      count,
      "reusing an identical completed transaction must not send twice",
    );
  } finally {
    await f.close();
  }
});

test("restart preserves interrupted-run warning without replaying the old Agent prompt", async () => {
  const f = fixture();
  let restored: Store | undefined, manager: Manager | undefined;
  try {
    f.store.enqueue("a", "$interrupted", "!dm:example.org", f.event);
    f.store.mark("a", "$interrupted", "running");
    f.store.close();
    restored = new Store(f.dir);
    manager = new Manager(restored, f.pi as any, f.gateway as any);
    await manager.restore();
    assert.equal(restored.agent("a").status, "Running");
    assert.match(
      restored.agent("a").error ?? "",
      /previous reply was interrupted/i,
    );
    assert.equal(f.calls.runs, 0);
    await manager.receive({ ...f.event, event_id: "$interrupted" });
    assert.equal(f.calls.runs, 0);
    await manager.receive({ ...f.event, event_id: "$new" });
    assert.equal(f.calls.runs, 1);
    assert.equal(restored.agent("a").error, null);
  } finally {
    if (manager) await manager.close();
    else restored?.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
