import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, Serial, matrixId, AppError } from "./store.js";
import { DatabaseSync } from "node:sqlite";

test("metadata transactions, protected credentials, deduplication and version conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-store-"));
  const s = new Store(dir);
  try {
    const p = s.addPerson("@owner:example.org", "Owner");
    s.db
      .prepare(
        "INSERT INTO agents(id,person_id,matrix_id,display_name) VALUES(?,?,?,?)",
      )
      .run("a", p.id, "@bot:example.org", "Bot");
    s.setPassword("a", "private-password");
    assert.equal(s.password("a"), "private-password");
    const raw = s.db.prepare("SELECT secret FROM credentials").get()!
      .secret as Uint8Array;
    assert.ok(!Buffer.from(raw).includes(Buffer.from("private-password")));
    assert.equal(statSync(join(dir, "credentials.key")).mode & 0o777, 0o600);
    const settings = s.settings();
    s.saveSettings({ ...settings, homeserver: "https://matrix.example.org" });
    assert.throws(
      () => s.saveSettings(settings),
      (e: unknown) => e instanceof AppError && e.status === 409,
    );
    assert.throws(
      () => s.checkVersion("a", 2),
      (e: unknown) => e instanceof AppError && e.status === 409,
    );
    assert.equal(s.enqueue("a", "$one", "!dm", {}), true);
    assert.equal(s.enqueue("a", "$one", "!dm", {}), false);
    assert.throws(() =>
      s.transaction(() => {
        s.addPerson("@rollback:example.org", "Rollback");
        throw new Error("rollback");
      }),
    );
    assert.equal(s.people().length, 1);
    s.mark("a", "$one", "running");
    s.close();
    const restored = new Store(dir);
    assert.equal(restored.password("a"), "private-password");
    assert.equal(restored.pending("a").length, 0);
    assert.equal(
      restored.db.prepare("SELECT state FROM inbox").get()!.state,
      "interrupted",
    );
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("per-agent work serializes while other agents make progress", async () => {
  const s = new Serial(),
    order: string[] = [];
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  const a = s.run("a", async () => {
    order.push("a1");
    await wait;
    order.push("a2");
  });
  const b = s.run("a", async () => {
    order.push("a3");
  });
  await s.run("b", async () => {
    order.push("b");
  });
  assert.deepEqual(order, ["a1", "b"]);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a1", "b", "a2", "a3"]);
});
test("Matrix identities reject incomplete and unsafe input", () => {
  assert.equal(matrixId("@owner:example.org"), "@owner:example.org");
  for (const bad of ["owner", "@a", "@a:bad/path", "@a:bad host"])
    assert.throws(() => matrixId(bad));
});

test("legacy settings upgrade defaults to Pi and keeps independent runtime defaults after reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "family-legacy-runtime-"));
  const legacy = new DatabaseSync(join(dir, "application.sqlite"));
  legacy.exec(`CREATE TABLE settings(id INTEGER PRIMARY KEY,version INTEGER NOT NULL,homeserver TEXT NOT NULL,
    provider TEXT NOT NULL,model TEXT NOT NULL,thinking_level TEXT NOT NULL);
    INSERT INTO settings VALUES(1,12,'https://matrix.example.org','original-provider','original-model','high');`);
  legacy.close();
  let store = new Store(dir);
  try {
    assert.equal(store.settings().runtime, "pi");
    assert.equal(store.settings().version, 12);
    assert.equal(store.settings().model, "original-model");
    const person = store.addPerson("@owner:example.org", "Owner");
    store.db.prepare("INSERT INTO agents(id,person_id,matrix_id,display_name) VALUES('a',?,'@bot:example.org','Bot')").run(person.id);
    store.setPassword("a", "original-password");
    store.saveSettings({...store.settings(), runtime: "codex", provider: "codex", model: "discovered-model", thinking_level: "medium"});
    const piDefaults = store.runtimeDefaults("pi") as {provider: string; model: string; thinking_level: string};
    assert.equal(piDefaults.model, "original-model");
    store.close(); store = new Store(dir);
    assert.equal(store.settings().runtime, "codex");
    assert.equal(store.password("a"), "original-password");
    assert.equal(store.people()[0].id, person.id);
    assert.equal(store.agent("a").person_id, person.id);
    store.saveSettings({...store.settings(), ...piDefaults, runtime: "pi"});
    assert.equal(store.settings().model, "original-model");
    assert.equal(store.runtimeDefaults("codex").model, "discovered-model");
  } finally { store.close(); rmSync(dir, {recursive: true, force: true}); }
});
