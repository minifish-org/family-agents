import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { AppError } from "./store.js";

const ISSUER = "https://auth.openai.com";
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const RESOURCE = "https://api.openai.com/v1";
const DIRECT_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`;
const DYNAMIC_CLIENT = "dynamic_agent_client";
const random = () => randomBytes(32).toString("base64url");
const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
type Tokens = { access: string; refresh: string; idToken: string; expires: number; scopes: string[] };
type Registration = {
  id: string;
  clientId: string;
  subject: string;
  email?: string;
  tokens?: Tokens;
};
type Stored = { version: 1; active: string | null; preferred: string | null; registrations: Registration[] };
export type ChatGptLoginStatus = {
  status: "pending" | "complete" | "error" | "cancelled";
  loginId: string;
  authUrl?: string;
  redirectUri?: string;
  prompt?: "callback_url";
  error?: string;
};
type Attempt = {
  state: ChatGptLoginStatus;
  controller: AbortController;
  oauthState: string;
  nonce: string;
  verifier: string;
  registration?: Registration;
  issuedClientId?: string;
  server?: Server;
  timer?: NodeJS.Timeout;
  consuming: boolean;
};
type Options = {
  beforeCommit?: (reason: "login" | "refresh" | "logout") => Promise<void | (() => void)> | void | (() => void);
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  callbackPort?: number;
  loginTimeoutMs?: number;
  requestTimeoutMs?: number;
};

/** Public-client SIWC. Credentials belong to this app, independently of Pi and native Codex auth. */
export class ChatGptAuth extends EventEmitter {
  private readonly path: string;
  private readonly hostId: string;
  private readonly fingerprintKey = randomBytes(32);
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly secrets = new Set<string>();
  private stored: Stored = { version: 1, active: null, preferred: null, registrations: [] };
  private storageInvalid = false;
  private pending?: Attempt;
  private queue: Promise<unknown> = Promise.resolve();
  private keys?: { created: number; resolve: ReturnType<typeof createLocalJWKSet> };
  private reauthorizationRequired = false;
  private retryIssuedClientId?: string;
  private closed = false;

  constructor(dataDir: string, private readonly options: Options = {}) {
    super();
    const directory = join(dataDir, "codex", "siwc");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, "credentials.json");
    const hostPath = join(directory, "host-id");
    if (!existsSync(hostPath)) writeFileSync(hostPath, `urn:uuid:${randomUUID()}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(hostPath, 0o600);
    this.hostId = readFileSync(hostPath, "utf8").trim();
    if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(this.hostId))
      this.storageInvalid = true;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    if (existsSync(this.path)) {
      chmodSync(this.path, 0o600);
      try {
        const value = JSON.parse(readFileSync(this.path, "utf8")) as Stored;
        if (value.version !== 1 || !Array.isArray(value.registrations) || value.registrations.length > 100 ||
          !value.registrations.every((entry) => typeof entry.id === "string" && this.validClientId(entry.clientId) &&
            typeof entry.subject === "string" && !!entry.subject && (!entry.tokens || this.validTokens(entry.tokens))) ||
          (value.active !== null && !value.registrations.some((entry) => entry.id === value.active)) ||
          (value.preferred !== null && !value.registrations.some((entry) => entry.id === value.preferred))) throw new Error();
        this.stored = value;
      } catch { this.storageInvalid = true; }
    }
  }

  private ready() {
    if (this.closed) throw new AppError(503, "ChatGPT authentication is shutting down.");
    if (this.storageInvalid) throw new AppError(400, "ChatGPT credential storage is invalid. Restore its private backup before continuing.");
  }
  private validClientId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) && value !== DYNAMIC_CLIENT;
  }
  private validTokens(value: Tokens) {
    return typeof value.access === "string" && !!value.access && typeof value.refresh === "string" && !!value.refresh &&
      typeof value.idToken === "string" && !!value.idToken && typeof value.expires === "number" && Number.isFinite(value.expires) &&
      Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string") && value.scopes.includes(DIRECT_SCOPE);
  }
  private active() { return this.stored.registrations.find((entry) => entry.id === this.stored.active); }

  status() {
    this.ready();
    const registration = this.active();
    return registration ? {
      type: "chatgpt" as const, auth_method: "siwc" as const, registrationId: registration.id,
      clientId: registration.clientId, subject: registration.subject,
      ...(registration.email ? { email: registration.email } : {}),
      ...(this.reauthorizationRequired || !registration.tokens ? { reauthorizationRequired: true } : {}),
    } : null;
  }
  registrations() {
    this.ready();
    return this.stored.registrations.map((entry) => ({
      id: entry.id, clientId: entry.clientId, subject: entry.subject, ...(entry.email ? { email: entry.email } : {}),
      authenticated: !!entry.tokens, selected: entry.id === this.stored.active,
    }));
  }
  version() {
    return createHmac("sha256", this.fingerprintKey).update(JSON.stringify(this.stored)).update("\0")
      .update(JSON.stringify(this.pending ? {loginId: this.pending.state.loginId, status: this.pending.state.status} : null)).digest("hex");
  }
  loginStatus(): ChatGptLoginStatus | undefined { return this.pending ? { ...this.pending.state } : undefined; }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(operation);
    this.queue = next;
    return next;
  }

  async begin(options: { newAccount?: boolean; registrationId?: string } = {}) {
    this.ready();
    if (this.pending?.state.status === "pending") throw new AppError(409, "Complete or cancel the current ChatGPT sign in first.");
    const selected = options.registrationId ?? (options.newAccount ? undefined : this.stored.active ?? this.stored.preferred ?? undefined);
    const registration = selected ? this.stored.registrations.find((entry) => entry.id === selected) : undefined;
    if (selected && !registration) throw new AppError(400, "Choose a saved ChatGPT account or add another account.");
    const issuedClientId = registration?.clientId ?? (!options.newAccount ? this.retryIssuedClientId : undefined);
    const attempt: Attempt = {
      state: { status: "pending", loginId: randomUUID(), prompt: "callback_url" }, controller: new AbortController(),
      oauthState: random(), nonce: random(), verifier: random(),
      ...(registration ? { registration: structuredClone(registration) } : {}),
      ...(issuedClientId ? {issuedClientId} : {}),
      consuming: false,
    };
    this.pending = attempt;
    try {
      const port = await this.listen(attempt, this.options.callbackPort ?? 1455);
      if (attempt.controller.signal.aborted) throw new AppError(409, "ChatGPT sign in was cancelled.");
      const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: issuedClientId ?? DYNAMIC_CLIENT,
        ext_agent_host_id: this.hostId,
        ...(!issuedClientId ? { agent_name_hint: "family_agents" } : {}),
        ...(registration?.tokens?.idToken ? { id_token_hint: registration.tokens.idToken } : {}),
        ...(registration?.email ? { login_hint: registration.email } : {}),
        response_type: "code", redirect_uri: redirectUri, resource: RESOURCE, scope: SCOPES,
        state: attempt.oauthState, nonce: attempt.nonce, code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
      }).toString();
      attempt.state.authUrl = url.href;
      attempt.state.redirectUri = redirectUri;
      attempt.timer = setTimeout(() => this.finishAttempt(attempt, "error", "ChatGPT sign in expired. Start again."), this.options.loginTimeoutMs ?? 10 * 60_000);
      attempt.timer.unref();
      this.emit("login", this.loginStatus());
      return { type: "chatgpt" as const, loginId: attempt.state.loginId, authUrl: url.href, redirectUri };
    } catch (error) {
      this.finishAttempt(attempt, "error", "Could not start ChatGPT sign in. Try again.");
      throw error instanceof AppError ? error : new AppError(503, "Could not start the ChatGPT callback listener.");
    }
  }

  private listen(attempt: Attempt, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        let url: URL;
        try { url = new URL(request.url ?? "/", attempt.state.redirectUri ?? "http://127.0.0.1"); }
        catch { response.writeHead(400, {"Cache-Control": "no-store"}).end("Invalid callback request."); return; }
        if (request.method !== "GET" || url.pathname !== "/auth/callback") { response.writeHead(404).end(); return; }
        const security = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
        void this.submit(attempt.state.loginId, url.href).then(() => {
          response.writeHead(200, security).end("ChatGPT is connected. Return to Family Agents.");
        }, () => {
          response.writeHead(400, security).end("ChatGPT could not be connected. Return to Family Agents for the sign-in status.");
        });
      });
      attempt.server = server;
      const onAbort = () => {
        server.close(); server.closeAllConnections();
        reject(new AppError(409, "ChatGPT sign in was cancelled."));
      };
      attempt.controller.signal.addEventListener("abort", onAbort, {once: true});
      server.once("error", (error: NodeJS.ErrnoException) => {
        attempt.controller.signal.removeEventListener("abort", onAbort);
        if (error.code === "EADDRINUSE" && port !== 0 && !attempt.controller.signal.aborted && !this.closed) {
          void this.listen(attempt, 0).then(resolve, reject); return;
        }
        reject(error);
      });
      server.listen(port, "127.0.0.1", () => {
        attempt.controller.signal.removeEventListener("abort", onAbort);
        if (attempt.controller.signal.aborted || this.closed || this.pending !== attempt) {
          server.close(); server.closeAllConnections();
          reject(new AppError(409, "ChatGPT sign in was cancelled."));
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string") { server.close(); reject(new Error()); return; }
        resolve(address.port);
      });
    });
  }

  async submit(loginId: string, callbackUrl: string) {
    this.ready();
    const attempt = this.pending;
    if (!attempt || attempt.state.loginId !== loginId || attempt.state.status !== "pending" || attempt.consuming)
      throw new AppError(409, "This ChatGPT sign-in attempt is no longer waiting for a callback.");
    let url: URL;
    try {
      if (typeof callbackUrl !== "string" || callbackUrl.length > 32768) throw new Error();
      url = new URL(callbackUrl.trim());
      const expected = new URL(attempt.state.redirectUri!);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new Error();
    } catch { throw new AppError(400, "Paste the complete final callback URL shown in the browser after ChatGPT authorization."); }
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !same(states[0], attempt.oauthState)) throw new AppError(400, "This callback belongs to a different ChatGPT sign-in attempt.");
    if (url.searchParams.has("error")) {
      this.finishAttempt(attempt, "error", "ChatGPT authorization was declined or could not be completed.");
      throw new AppError(400, attempt.state.error!);
    }
    const codes = url.searchParams.getAll("code"), ids = url.searchParams.getAll("client_id");
    if (codes.length !== 1 || !codes[0] || ids.length > 1) throw new AppError(400, "The ChatGPT callback is incomplete. Start sign in again.");
    const clientId = ids[0] ?? attempt.issuedClientId;
    if (!this.validClientId(clientId) || (attempt.issuedClientId && clientId !== attempt.issuedClientId))
      throw new AppError(400, "The ChatGPT callback did not return the expected client registration.");
    attempt.issuedClientId = clientId;
    attempt.consuming = true;
    this.secrets.add(codes[0]);
    await this.serial(async () => {
      try {
        this.ensureAttempt(attempt);
        const response = await this.token(new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId, code: codes[0], code_verifier: attempt.verifier,
          redirect_uri: attempt.state.redirectUri!, resource: RESOURCE,
        }), attempt.controller.signal);
        const identity = await this.identity(response.id_token, clientId, attempt.nonce, attempt.controller.signal);
        if (attempt.registration && identity.subject !== attempt.registration.subject)
          throw new AppError(400, "The signed-in ChatGPT account does not match the selected saved account.");
        const tokens = this.tokens(response);
        this.ensureAttempt(attempt);
        const old = this.stored.registrations.find((entry) => entry.clientId === clientId && entry.subject === identity.subject);
        const entry: Registration = { id: old?.id ?? randomUUID(), clientId, ...identity, tokens };
        const next = structuredClone(this.stored);
        next.registrations = [...next.registrations.filter((item) => item.id !== entry.id), entry];
        if (next.registrations.length > 100) throw new AppError(400, "Too many saved ChatGPT registrations.");
        next.active = next.preferred = entry.id;
        await this.commit("login", next, () => this.ensureAttempt(attempt));
        this.retryIssuedClientId = undefined;
        this.reauthorizationRequired = false;
        this.finishAttempt(attempt, "complete");
      } catch (error) {
        if ((error as {oauthCode?: string}).oauthCode === "invalid_grant" && !attempt.registration)
          this.retryIssuedClientId = attempt.issuedClientId;
        if (attempt.state.status === "pending")
          this.finishAttempt(attempt, "error", error instanceof AppError ? error.message : "ChatGPT authorization could not be verified. Start sign in again.");
        throw new AppError(error instanceof AppError ? error.status : 400, this.sanitizeError(attempt.state.error ?? "ChatGPT sign in was cancelled."));
      }
    });
  }

  private ensureAttempt(attempt: Attempt) {
    this.ready();
    if (this.pending !== attempt || attempt.state.status !== "pending" || attempt.controller.signal.aborted)
      throw new AppError(409, "This ChatGPT sign-in attempt is no longer active.");
  }
  private finishAttempt(attempt: Attempt, status: ChatGptLoginStatus["status"], error?: string) {
    if (attempt.state.status !== "pending") return;
    attempt.state.status = status;
    if (error) attempt.state.error = error;
    delete attempt.state.prompt;
    delete attempt.state.authUrl;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    // Give a valid callback response a chance to finish before draining idle sockets.
    attempt.server?.close();
    const server = attempt.server;
    const cleanup = setTimeout(() => server?.closeAllConnections(), 1000);
    cleanup.unref();
    this.emit("login", this.loginStatus());
  }

  private async json(url: string, init: RequestInit, signal?: AbortSignal) {
    const response = await this.fetcher(url, { ...init, redirect: "error", signal: AbortSignal.any([
      ...(signal ? [signal] : []), AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000),
    ]) });
    if (!response.ok) {
      const result = await response.json().catch(() => null) as {error?: unknown} | null;
      const error = new AppError(502, "OpenAI could not complete the authentication request. Start sign in again if it persists.");
      if (result?.error === "invalid_grant") Object.assign(error, {oauthCode: "invalid_grant"});
      throw error;
    }
    return await response.json() as Record<string, unknown>;
  }
  private token(body: URLSearchParams, signal?: AbortSignal) {
    return this.json(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body }, signal);
  }
  private tokens(value: Record<string, unknown>, prior?: Tokens): Tokens {
    const nonempty = (input: unknown): input is string => typeof input === "string" && !!input.trim() && input.length < 131072;
    if (!nonempty(value.access_token) || !nonempty(value.refresh_token) || typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.token_type !== "Bearer")
      throw new AppError(400, "OpenAI returned an incomplete token grant. Start sign in again.");
    const scopes = typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : prior?.scopes;
    if (!scopes?.includes(DIRECT_SCOPE) || !scopes.includes("resource.invoke"))
      throw new AppError(400, "ChatGPT plan usage was not authorized. Sign in again and allow access to your ChatGPT plan.");
    const idToken = nonempty(value.id_token) ? value.id_token : prior?.idToken;
    if (!idToken) throw new AppError(400, "OpenAI did not return an identity token. Start sign in again.");
    for (const secret of [value.access_token, value.refresh_token, idToken]) this.secrets.add(secret);
    return { access: value.access_token, refresh: value.refresh_token, idToken, expires: this.now() + value.expires_in * 1000, scopes };
  }
  private async identity(token: unknown, clientId: string, nonce: string | undefined, signal?: AbortSignal) {
    if (typeof token !== "string" || !token || token.length > 131072) throw new AppError(400, "OpenAI did not return a valid identity token.");
    const verify = async (reload: boolean) => {
      if (reload || !this.keys || this.now() - this.keys.created > 5 * 60_000) {
        const keys = await this.json(JWKS, { headers: { Accept: "application/json" } }, signal);
        if (!Array.isArray(keys.keys)) throw new Error("OpenAI returned an invalid signing key set.");
        this.keys = { created: this.now(), resolve: createLocalJWKSet(keys as unknown as JSONWebKeySet) };
      }
      return jwtVerify(token, this.keys.resolve, { issuer: ISSUER, audience: clientId, algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5, currentDate: new Date(this.now()) });
    };
    try {
      let result;
      try { result = await verify(false); }
      catch (error) { if ((error as {code?: string}).code !== "ERR_JWKS_NO_MATCHING_KEY") throw error; result = await verify(true); }
      const {payload} = result;
      if (typeof payload.sub !== "string" || !payload.sub || (nonce !== undefined && payload.nonce !== nonce)) throw new Error();
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) throw new Error();
      return { subject: payload.sub, ...(typeof payload.email === "string" && payload.email.length <= 320 ? { email: payload.email } : {}) };
    } catch { throw new AppError(400, "The ChatGPT identity token could not be verified. Start sign in again."); }
  }

  private async commit(reason: "login" | "refresh" | "logout", next: Stored, validate?: () => void) {
    const release = await this.options.beforeCommit?.(reason);
    try {
      validate?.();
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(temporary, this.path);
      } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      this.stored = next;
      this.emit("changed", reason);
    } finally { if (typeof release === "function") release(); }
  }

  accessToken(): Promise<string | undefined> {
    return this.serial(async () => {
      this.ready();
      const registration = this.active(), prior = registration?.tokens;
      if (!registration) return;
      if (!prior) throw new AppError(401, "ChatGPT authorization has expired. Sign in again to continue.");
      if (prior.expires - this.now() > 3 * 60_000) return prior.access;
      try {
        const value = await this.token(new URLSearchParams({ grant_type: "refresh_token", client_id: registration.clientId,
          refresh_token: prior.refresh, resource: RESOURCE }));
        if (value.id_token !== undefined) {
          const identity = await this.identity(value.id_token, registration.clientId, undefined);
          if (identity.subject !== registration.subject) throw new AppError(400, "The refreshed ChatGPT identity did not match the saved account.");
        }
        const tokens = this.tokens(value, prior), next = structuredClone(this.stored);
        next.registrations.find((entry) => entry.id === registration.id)!.tokens = tokens;
        await this.commit("refresh", next);
        this.reauthorizationRequired = false;
        return tokens.access;
      } catch (error) {
        this.reauthorizationRequired = true;
        if ((error as {oauthCode?: string}).oauthCode === "invalid_grant") {
          const next = structuredClone(this.stored);
          delete next.registrations.find((entry) => entry.id === registration.id)!.tokens;
          await this.commit("refresh", next);
        }
        throw new AppError(401, "ChatGPT authorization could not be refreshed. Sign in again to continue.");
      }
    });
  }

  async cancel() {
    if (this.pending?.state.status === "pending") this.finishAttempt(this.pending, "cancelled");
  }
  logout(): Promise<{revocationConfirmed: boolean}> {
    void this.cancel();
    return this.serial(async () => {
      this.ready();
      const registration = this.active();
      let revocationConfirmed = !registration?.tokens;
      if (registration?.tokens) {
        try {
          const discovery = await this.json(DISCOVERY, {headers: {Accept: "application/json"}});
          const endpoint = new URL(String(discovery.revocation_endpoint));
          if (discovery.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.protocol !== "https:") throw new Error();
          for (let retry = 0; retry < 2 && !revocationConfirmed; retry++) {
            try {
              const response = await this.fetcher(endpoint.href, {method: "POST", redirect: "error", headers: {"Content-Type": "application/x-www-form-urlencoded"},
                body: new URLSearchParams({token: registration.tokens.refresh, token_type_hint: "refresh_token", client_id: registration.clientId}),
                signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000)});
              revocationConfirmed = response.status === 200;
              if (response.status < 500) break;
            } catch { /* Retry transient transport failure once while the refresh token is still available. */ }
            if (!retry) await new Promise((resolve) => setTimeout(resolve, 250));
          }
        } catch { /* Local sign-out still clears tokens when remote revocation cannot be confirmed. */ }
      }
      const next = structuredClone(this.stored);
      if (registration) delete next.registrations.find((entry) => entry.id === registration.id)!.tokens;
      next.active = null;
      await this.commit("logout", next);
      this.retryIssuedClientId = undefined;
      this.reauthorizationRequired = false;
      return {revocationConfirmed};
    });
  }
  async close() {
    this.closed = true;
    await this.cancel();
    await this.queue.catch(() => {});
    this.pending?.server?.closeAllConnections();
  }
  sanitizeError(error: unknown) {
    let text = error instanceof Error ? error.message : String(error);
    const secrets = new Set(this.secrets);
    for (const entry of this.stored.registrations) if (entry.tokens)
      for (const value of [entry.tokens.access, entry.tokens.refresh, entry.tokens.idToken]) secrets.add(value);
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) if (secret.length >= 4) text = text.split(secret).join("[redacted]");
    return text.replace(/https?:\/\/[^\s]+[?&](?:code|id_token_hint|access_token)=[^\s]+/g, "[redacted authentication URL]");
  }
}
