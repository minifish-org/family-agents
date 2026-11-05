import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { ChatGptAuth } from "./chatgpt-auth.js";

const ISSUER = "https://auth.openai.com";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const keys = generateKeyPair("RS256");
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return {promise, resolve};
}
async function fixture(options: ConstructorParameters<typeof ChatGptAuth>[1] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "family-siwc-"));
  const {privateKey, publicKey} = await keys;
  const jwk = {...await exportJWK(publicKey), kid: "key-1", alg: "RS256", use: "sig"};
  let now = Date.now(), tokenCount = 0, refreshCount = 0, currentAuthorization: URL | undefined;
  const state = {
    subject: "subject-a", email: "person@example.org", clientId: "oaiapp_registered", nonce: undefined as string | undefined,
    audience: undefined as string | undefined, issuer: ISSUER, scope: SCOPE, expiresIn: 3600,
    failToken: false, revokeStatus: 200, beforeToken: undefined as undefined | (() => Promise<void>),
    badSignature: false, expiredIdentity: false,
  };
  const calls: Array<{url: string; body?: URLSearchParams}> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = init?.body ? new URLSearchParams(String(init.body)) : undefined;
    calls.push({url, body});
    if (url.endsWith("/.well-known/jwks.json")) return Response.json({keys: [jwk]});
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json({issuer: ISSUER, revocation_endpoint: `${ISSUER}/api/accounts/oauth/revoke`});
    if (url.endsWith("/oauth/revoke")) return new Response(null, {status: state.revokeStatus});
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`);
    await state.beforeToken?.();
    if (state.failToken) return Response.json({error: "invalid_grant", secret: "must-not-leak"}, {status: 400});
    tokenCount++;
    if (body!.get("grant_type") === "refresh_token") refreshCount++;
    else {
      assert.equal(body!.get("redirect_uri"), currentAuthorization!.searchParams.get("redirect_uri"));
      assert.equal(createHash("sha256").update(body!.get("code_verifier")!).digest("base64url"), currentAuthorization!.searchParams.get("code_challenge"));
    }
    const idToken = await new SignJWT({
      nonce: state.nonce ?? currentAuthorization!.searchParams.get("nonce"), email: state.email,
    }).setProtectedHeader({alg: "RS256", kid: "key-1"}).setIssuer(state.issuer).setAudience(state.audience ?? body!.get("client_id")!)
      .setSubject(state.subject).setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + (state.expiredIdentity ? -10 : 3600)).sign(privateKey);
    return Response.json({access_token: `access-${tokenCount}`, refresh_token: `refresh-${tokenCount}`, id_token: state.badSignature ? `${idToken.slice(0, -8)}xxxxxxxx` : idToken,
      expires_in: state.expiresIn, token_type: "Bearer", scope: state.scope});
  }) as typeof fetch;
  const auth = new ChatGptAuth(dir, {...options, fetch: fetcher, callbackPort: 0, now: () => now});
  const begin = async (params: Parameters<ChatGptAuth["begin"]>[0] = {}) => {
    const result = await auth.begin(params); currentAuthorization = new URL(result.authUrl); return result;
  };
  const callback = (login: Awaited<ReturnType<typeof begin>>, fields: Record<string, string | null> = {}) => {
    const url = new URL(login.redirectUri);
    url.search = new URLSearchParams({code: "authorization-code", state: new URL(login.authUrl).searchParams.get("state")!, client_id: state.clientId}).toString();
    for (const [name, value] of Object.entries(fields)) if (value === null) url.searchParams.delete(name); else url.searchParams.set(name, value);
    return url.href;
  };
  const signin = async (params: Parameters<typeof begin>[0] = {}) => {
    const login = await begin(params); await auth.submit(login.loginId, callback(login)); return login;
  };
  return {dir, auth, state, calls, begin, callback, signin, advance(ms: number) {now += ms;},
    stored: () => readFileSync(join(dir, "codex", "siwc", "credentials.json"), "utf8"),
    counts: () => ({tokenCount, refreshCount}), async close() {await auth.close(); rmSync(dir, {recursive: true, force: true});}};
}

test("SIWC registers with PKCE, verifies identity and scopes, and saves credentials privately", async () => {
  const f = await fixture();
  try {
    const login = await f.begin(), url = new URL(login.authUrl);
    assert.equal(url.origin + url.pathname, `${ISSUER}/api/accounts/authorize`);
    assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(url.searchParams.get("agent_name_hint"), "family_agents");
    assert.match(url.searchParams.get("ext_agent_host_id")!, /^urn:uuid:/);
    assert.equal(url.searchParams.get("resource"), "https://api.openai.com/v1");
    assert.match(url.searchParams.get("scope")!, /chatgpt.tokens.use.direct/);
    assert.equal(f.auth.loginStatus()!.authUrl, login.authUrl);
    await f.auth.submit(login.loginId, f.callback(login));
    assert.equal(f.auth.status()!.email, "person@example.org");
    assert.equal(f.auth.status()!.auth_method, "siwc");
    assert.equal(f.auth.loginStatus()!.status, "complete");
    assert.equal(await f.auth.accessToken(), "access-1");
    assert.equal(statSync(join(f.dir, "codex", "siwc", "credentials.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(f.dir, "codex", "siwc")).mode & 0o777, 0o700);
    assert.ok(!JSON.stringify(f.auth.status()).includes("access-1"));
    assert.equal(f.auth.sanitizeError("access-1 refresh-1 authorization-code"), "[redacted] [redacted] [redacted]");
  } finally {await f.close();}
});

test("saved client registration and host identity survive restart and are reused after sign-out", async () => {
  const f = await fixture();
  try {
    const initial = await f.signin(), initialHost = new URL(initial.authUrl).searchParams.get("ext_agent_host_id");
    const next = await f.begin(), returning = new URL(next.authUrl);
    assert.equal(returning.searchParams.get("client_id"), f.state.clientId);
    assert.equal(returning.searchParams.get("agent_name_hint"), null);
    assert.ok(returning.searchParams.get("id_token_hint"));
    await f.auth.submit(next.loginId, f.callback(next, {client_id: null}));
    assert.deepEqual(await f.auth.logout(), {revocationConfirmed: true});
    assert.equal(f.auth.status(), null);
    assert.equal(f.auth.registrations().length, 1);
    const fresh = await f.begin(), afterLogout = new URL(fresh.authUrl);
    assert.equal(afterLogout.searchParams.get("client_id"), f.state.clientId);
    assert.equal(afterLogout.searchParams.get("id_token_hint"), null);
    assert.equal(afterLogout.searchParams.get("ext_agent_host_id"), initialHost);
    await f.auth.cancel(); await f.auth.close();
    const reopened = new ChatGptAuth(f.dir, {callbackPort: 0});
    try {
      assert.equal(reopened.status(), null);
      const restored = await reopened.begin();
      assert.equal(new URL(restored.authUrl).searchParams.get("client_id"), f.state.clientId);
      assert.equal(new URL(restored.authUrl).searchParams.get("ext_agent_host_id"), initialHost);
    } finally {await reopened.close();}
  } finally {await f.close();}
});

test("manual callback rejects wrong state, client registration and endpoint without exchanging a code", async () => {
  const f = await fixture();
  try {
    const login = await f.begin();
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login, {state: "wrong"})), /different ChatGPT/);
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login, {state: "µ".repeat(43)})), /different ChatGPT/);
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login).replace("127.0.0.1", "localhost")), /complete final callback/);
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login, {client_id: "dynamic_agent_client"})), /expected client/);
    assert.equal(f.counts().tokenCount, 0);
    await f.auth.submit(login.loginId, f.callback(login));
    const returning = await f.begin();
    await assert.rejects(f.auth.submit(returning.loginId, f.callback(returning, {client_id: "oaiapp_foreign"})), /expected client/);
    await f.auth.cancel();
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login)), /no longer waiting/);
  } finally {await f.close();}
});

test("invalid nonce, signature claims and missing ChatGPT plan scope never replace a working credential", async () => {
  const f = await fixture();
  try {
    await f.signin(); const original = f.stored();
    const attempts = [
      () => {f.state.nonce = "wrong";},
      () => {f.state.nonce = undefined; f.state.audience = "wrong-client";},
      () => {f.state.audience = undefined; f.state.issuer = "https://wrong.example";},
      () => {f.state.issuer = ISSUER; f.state.badSignature = true;},
      () => {f.state.badSignature = false; f.state.expiredIdentity = true;},
      () => {f.state.expiredIdentity = false; f.state.scope = "openid profile email";},
    ];
    for (const change of attempts) {
      change(); const login = await f.begin();
      await assert.rejects(f.auth.submit(login.loginId, f.callback(login)));
      assert.equal(f.stored(), original);
      assert.equal(f.auth.status()!.subject, "subject-a");
    }
  } finally {await f.close();}
});

test("refresh rotation is serialized and the complete replacement is persisted atomically", async () => {
  const f = await fixture();
  try {
    await f.signin(); f.advance(59 * 60_000);
    const tokens = await Promise.all([f.auth.accessToken(), f.auth.accessToken(), f.auth.accessToken()]);
    assert.deepEqual(tokens, ["access-2", "access-2", "access-2"]);
    assert.equal(f.counts().refreshCount, 1);
    const request = f.calls.find((call) => call.body?.get("grant_type") === "refresh_token")!;
    assert.equal(request.body!.get("refresh_token"), "refresh-1");
    assert.equal(request.body!.get("client_id"), "oaiapp_registered");
    const file = JSON.parse(readFileSync(join(f.dir, "codex", "siwc", "credentials.json"), "utf8"));
    assert.equal(file.registrations[0].tokens.refresh, "refresh-2");
    assert.equal(file.registrations[0].tokens.access, "access-2");
  } finally {await f.close();}
});

test("cancelled or expired authorization cannot overwrite the active account", async () => {
  const f = await fixture({loginTimeoutMs: 30});
  try {
    await f.signin(); const version = f.stored();
    const login = await f.begin(), entered = deferred(), finish = deferred();
    f.state.beforeToken = async () => {entered.resolve(); await finish.promise;};
    const response = f.auth.submit(login.loginId, f.callback(login));
    const rejected = assert.rejects(response, /cancelled|no longer active/);
    await entered.promise; await f.auth.cancel(); finish.resolve(); await rejected;
    assert.equal(f.stored(), version);
    assert.equal(f.auth.loginStatus()!.status, "cancelled");
    f.state.beforeToken = undefined;
    await f.begin(); await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(f.auth.loginStatus()!.status, "error");
    assert.equal(f.stored(), version);
  } finally {await f.close();}
});

test("different account registrations remain separate and returning identity must match", async () => {
  const f = await fixture();
  try {
    await f.signin(); const first = f.auth.registrations()[0];
    f.state.subject = "subject-b";
    f.state.clientId = "oaiapp_other";
    await f.signin({newAccount: true});
    assert.equal(f.auth.registrations().length, 2);
    const login = await f.begin({registrationId: first.id});
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login, {client_id: first.clientId})), /does not match/);
    assert.equal(f.auth.status()!.subject, "subject-b");
  } finally {await f.close();}
});

test("commit gate releases on success and rejected commit keeps the earlier credential", async () => {
  let blocked = false, acquired = 0, released = 0;
  const f = await fixture({beforeCommit: () => {if (blocked) throw new Error("gate rejected"); acquired++; return () => {released++;};}});
  try {
    await f.signin(); const version = f.stored();
    assert.equal(acquired, 1); assert.equal(released, 1);
    blocked = true; const login = await f.begin();
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login)));
    assert.equal(f.stored(), version);
    assert.equal(released, 1);
  } finally {await f.close();}
});

test("unconfirmed remote revocation clears local tokens and preserves registration for reauthorization", async () => {
  const f = await fixture();
  try {
    await f.signin(); f.state.revokeStatus = 503;
    assert.deepEqual(await f.auth.logout(), {revocationConfirmed: false});
    assert.equal(f.auth.status(), null);
    assert.equal(f.auth.registrations().length, 1);
    assert.equal(f.calls.filter((call) => call.url.endsWith("/oauth/revoke")).length, 2);
    assert.equal(JSON.stringify(f.auth.registrations()).includes("refresh"), false);
  } finally {await f.close();}
});

test("malformed HTTP callback requests are rejected without affecting the pending authorization", async () => {
  const f = await fixture();
  try {
    const login = await f.begin(), callback = new URL(login.redirectUri);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({hostname: callback.hostname, port: callback.port, path: "http://[", method: "GET"}, (response) => {
        response.resume(); resolve(response.statusCode!);
      });
      req.once("error", reject); req.end();
    });
    assert.equal(status, 400);
    assert.equal(f.auth.loginStatus()!.status, "pending");
    await f.auth.submit(login.loginId, f.callback(login));
    assert.equal(f.auth.status()!.subject, "subject-a");
  } finally {await f.close();}
});

test("cancellation during callback startup closes the newly bound listener", async () => {
  const f = await fixture();
  try {
    const version = f.auth.version();
    const started = f.auth.begin();
    const rejected = assert.rejects(started, /cancelled|listener/);
    await f.auth.cancel(); await rejected;
    assert.equal(f.auth.loginStatus()!.status, "cancelled");
    assert.notEqual(f.auth.version(), version);
    const next = await f.begin();
    assert.ok(next.redirectUri.startsWith("http://127.0.0.1:"));
  } finally {await f.close();}
});

test("invalid refresh grants clear unusable tokens, preserve account registration, and require reauthorization", async () => {
  const f = await fixture();
  try {
    await f.signin(); const id = f.auth.status()!.registrationId;
    f.advance(59 * 60_000); f.state.failToken = true;
    await assert.rejects(f.auth.accessToken(), {status: 401});
    assert.equal(f.auth.status()!.registrationId, id);
    assert.equal(f.auth.status()!.reauthorizationRequired, true);
    assert.equal(f.auth.registrations()[0].authenticated, false);
    assert.equal(f.stored().includes("refresh-1"), false);
    await assert.rejects(f.auth.accessToken(), {status: 401});
  } finally {await f.close();}
});

test("the native loopback callback completes once and returns a safe success page", async () => {
  const f = await fixture();
  try {
    const login = await f.begin();
    const response = await fetch(f.callback(login));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Return to Family Agents/);
    assert.equal(f.auth.loginStatus()!.status, "complete");
    assert.equal(f.counts().tokenCount, 1);
    await assert.rejects(f.auth.submit(login.loginId, f.callback(login)), /no longer waiting/);
  } finally {await f.close();}
});

test("cancellation while acquiring the commit gate releases it without saving new credentials", async () => {
  let pause = false, releases = 0;
  const entered = deferred(), releaseGate = deferred();
  const f = await fixture({beforeCommit: async () => {
    if (pause) {entered.resolve(); await releaseGate.promise;}
    return () => {releases++;};
  }});
  try {
    await f.signin(); const original = f.stored(); pause = true;
    const login = await f.begin(), submission = f.auth.submit(login.loginId, f.callback(login));
    const rejected = assert.rejects(submission, /cancelled|no longer active/);
    await entered.promise; await f.auth.cancel(); releaseGate.resolve(); await rejected;
    assert.equal(f.stored(), original);
    assert.equal(releases, 2);
  } finally {releaseGate.resolve(); await f.close();}
});

test("a consumed registration code retries with its issued client ID and fresh state instead of registering again", async () => {
  const f = await fixture();
  try {
    f.state.failToken = true;
    const first = await f.begin();
    await assert.rejects(f.auth.submit(first.loginId, f.callback(first)));
    assert.equal(f.auth.status(), null);
    assert.equal(f.auth.registrations().length, 0);
    f.state.failToken = false;
    const next = await f.begin(), url = new URL(next.authUrl);
    assert.equal(url.searchParams.get("client_id"), f.state.clientId);
    assert.equal(url.searchParams.get("agent_name_hint"), null);
    assert.notEqual(url.searchParams.get("state"), new URL(first.authUrl).searchParams.get("state"));
    await f.auth.submit(next.loginId, f.callback(next, {client_id: null}));
    assert.equal(f.auth.status()!.clientId, f.state.clientId);
  } finally {await f.close();}
});
