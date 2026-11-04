import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { AppError, matrixId, required, type Settings } from "./store.js";
import { Manager } from "./manager.js";

export function homeserver(value: unknown) {
  const raw = required(value, "Matrix Server", 2048);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError(400, "Enter an HTTP or HTTPS Matrix Server URL.");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new AppError(
      400,
      "Matrix Server must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  return raw.replace(/\/+$/, "");
}
export async function probe(server: string) {
  try {
    const r = await fetch(server + "/_matrix/client/versions", {
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    if (!r.ok) throw new Error();
    const data = (await r.json()) as any;
    if (!Array.isArray(data.versions)) throw new Error();
  } catch {
    throw new AppError(
      400,
      "Cannot connect to that Matrix Server. Check its URL and network connection.",
    );
  }
}

export function createApp(m: Manager) {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (m.closing)
      return c.json({ error: "The service is shutting down." }, 503);
    await next();
  });
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (
        c.req.header("Sec-Fetch-Site") === "cross-site" ||
        (origin &&
          new URL(origin).host !== c.req.header("Host") &&
          origin !== process.env.PUBLIC_ORIGIN)
      )
        throw new AppError(
          403,
          "Open the control panel directly to make changes.",
        );
    }
    await next();
  });
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 13 * 1024 * 1024,
      onError: (c) => c.json({ error: "Request is too large." }, 413),
    }),
  );
  app.onError((e, c) => {
    let status =
      e instanceof AppError
        ? e.status
        : typeof (e as any).status === "number"
          ? (e as any).status
          : 500;
    let message = e.message;
    if (message.includes("UNIQUE constraint")) {
      status = 409;
      message = "That Matrix account is already configured.";
    }
    if (message.includes("FOREIGN KEY constraint")) {
      status = 409;
      message = "This record is still in use.";
    }
    if (e instanceof SyntaxError) {
      status = 400;
      message = "Invalid JSON request.";
    }
    if (status === 500)
      message =
        "The operation failed. Check the service configuration and try again.";
    return c.json({ error: message }, status as any);
  });
  app.get("/api/health", (c) =>
    c.json(
      {
        status: m.gateway.ready && !m.closing ? "ready" : "unavailable",
        gateway: m.gateway.ready,
        agents: m.store
          .agents()
          .map((a) => ({ id: a.id, status: a.status, error: a.error })),
      },
      m.gateway.ready && !m.closing ? 200 : 503,
    ),
  );
  app.get("/api/people", (c) => c.json(m.store.people()));
  app.post("/api/people", async (c) => {
    const b = await c.req.json();
    const id = matrixId(b.matrix_id),
      s = m.store.settings();
    if (!s.homeserver)
      throw new AppError(400, "Configure Matrix Server in Settings first.");
    let name = id;
    try {
      const r = await fetch(
        `${s.homeserver}/_matrix/client/v3/profile/${encodeURIComponent(id)}`,
        { signal: AbortSignal.timeout(8000), redirect: "error" },
      );
      if (r.ok) {
        const p = (await r.json()) as any;
        if (typeof p.displayname === "string" && p.displayname.trim())
          name = p.displayname;
      }
    } catch {}
    return c.json(m.store.addPerson(id, name), 201);
  });
  app.delete("/api/people/:id", (c) => {
    m.store.person(c.req.param("id"));
    m.store.db.prepare("DELETE FROM people WHERE id=?").run(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/api/agents", (c) =>
    c.json(m.store.agents(c.req.query("person_id")).map((a) => m.public(a))),
  );
  app.get("/api/agents/:id", (c) =>
    c.json(m.public(m.store.agent(c.req.param("id")))),
  );
  app.post("/api/agents", async (c) =>
    c.json(await m.create(await c.req.json()), 201),
  );
  app.put("/api/agents/:id", async (c) =>
    c.json(await m.edit(c.req.param("id"), await c.req.json())),
  );
  for (const op of ["start", "stop", "restart"])
    app.post(`/api/agents/:id/${op}`, async (c) =>
      c.json(
        await m.lifecycle(c.req.param("id"), op, (await c.req.json()).version),
      ),
    );
  app.delete("/api/agents/:id", async (c) => {
    await m.delete(c.req.param("id"), (await c.req.json()).version);
    return c.json({ ok: true });
  });
  app.post("/api/agents/:id/send", async (c) =>
    c.json(await m.proactive(c.req.param("id"), await c.req.json())),
  );
  app.get("/api/settings", (c) => c.json(m.store.settings()));
  app.put("/api/settings", async (c) => {
    const b = (await c.req.json()) as Settings;
    return m.serial.run("global-settings", async () => {
      const old = m.store.settings();
      if (old.version !== b.version)
        throw new AppError(
          409,
          "Settings changed in another browser. Reload before saving.",
        );
      const server = homeserver(b.homeserver);
      if (server !== old.homeserver) await probe(server);
      const provider = required(b.provider, "Default Model provider", 255),
        model = required(b.model, "Default Model", 255);
      m.pi.resolveModel(provider, model);
      const thinking = m.pi.clampThinking(provider, model, b.thinking_level);
      const result = m.store.saveSettings({
        ...b,
        homeserver: server,
        provider,
        model,
        thinking_level: thinking,
      });
      if (server !== old.homeserver) await m.reconnectAll();
      return c.json(result);
    });
  });
  app.get("/api/models", async (c) => c.json(await m.pi.models()));
  app.post("/api/model-selection", async (c) => {
    const b = await c.req.json();
    const provider = required(b.provider, "Provider", 255),
      model = required(b.model, "Model", 255);
    return c.json({
      thinking_level: m.pi.clampThinking(provider, model, b.thinking_level),
      thinking_levels: m.pi.thinkingLevels(provider, model),
    });
  });
  app.get("/api/providers", async (c) => c.json(await m.pi.providers()));
  app.get("/api/providers/config", (c) => c.json(m.pi.config()));
  app.get("/api/providers/schema", (c) => c.json(m.pi.schema()));
  app.put("/api/providers/config", async (c) => {
    const b = await c.req.json();
    return c.json(await m.pi.saveConfig(b.config, b.version));
  });
  app.put("/api/providers/:id/key", async (c) => {
    const b = await c.req.json();
    await m.pi.setKey(
      c.req.param("id"),
      required(b.key, "API key", 16384),
      b.version,
    );
    return c.json({ ok: true });
  });
  app.delete("/api/providers/:id/key", async (c) => {
    await m.pi.removeAuth(c.req.param("id"), (await c.req.json()).version);
    return c.json({ ok: true });
  });
  app.post("/api/providers/:id/oauth", async (c) => {
    const body = await c.req.json();
    return c.json(
      await m.pi.beginOAuth(
        c.req.param("id"),
        body.type === "api_key" ? "api_key" : "oauth",
        body.version,
      ),
    );
  });
  app.get("/api/oauth/:id", (c) => c.json(m.pi.oauthStatus(c.req.param("id"))));
  app.post("/api/oauth/:id", async (c) => {
    await m.pi.oauthInput(c.req.param("id"), (await c.req.json()).input);
    return c.json(m.pi.oauthStatus(c.req.param("id")));
  });
  app.delete("/api/oauth/:id", async (c) => {
    await m.pi.cancelOAuth(c.req.param("id"));
    return c.json({ ok: true });
  });
  app.get("/source.tar.gz", serveStatic({ path: "./dist/source.tar.gz" }));
  app.use("/assets/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
  return app;
}
