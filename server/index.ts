import { serve } from "@hono/node-server";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { lock } from "proper-lockfile";
import { Store } from "./store.js";
import { PiService } from "./pi.js";
import { Gateway } from "./gateway.js";
import { Manager } from "./manager.js";
import { createApp } from "./app.js";

process.umask(0o077);
const dir = resolve(process.env.DATA_DIR ?? "data");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const release = await lock(dir, {
  lockfilePath: join(dir, ".service-lock"),
  stale: 10_000,
  retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 },
});
const store = new Store(dir),
  pi = new PiService(dir),
  gateway = new Gateway(),
  manager = new Manager(store, pi, gateway);
let server: ReturnType<typeof serve> | undefined,
  closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 25_000);
  deadline.unref();
  server?.close();
  await manager.close();
  await release();
  clearTimeout(deadline);
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
try {
  await manager.init();
  server = serve(
    {
      fetch: createApp(manager).fetch,
      hostname: process.env.HOST ?? "127.0.0.1",
      port: Number(process.env.PORT ?? 18090),
    },
    (info) =>
      console.log(`Family Agents ready on ${info.address}:${info.port}`),
  );
} catch (e) {
  console.error(
    "Family Agents startup failed:",
    e instanceof Error ? e.message : "Unknown error",
  );
  await manager.close();
  await release();
  process.exit(1);
}
