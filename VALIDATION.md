# Deployment validation

Verified on 5 November 2026 (Asia/Singapore) in the existing `webtop-desktop` deployment.

## Architecture and deployment

- Replaced the Go backend and removed its source, schemas, dependencies, generated artifacts, and s6 service definition.
- Preserved the pre-rewrite Git checkpoint and a stopped-data recovery archive outside the repository before removal.
- The deployed application has one Node.js 24 backend and one supervised Rust Gateway, with Hono, React/TypeScript, official Pi 1.5.0 `ModelRuntime`, matrix-rust-sdk 0.19.1, and SQLite.
- Tuwunel stayed running and its configuration was not modified. Registration remains disabled. Existing inactive Matrix accounts were used for isolated acceptance rooms.
- Node runs as UID 1000 with a loopback listener inside the existing container. The existing tailnet-only HTTPS application endpoint at port 8456 works; port 8450 now reaches the same V2 application.
- The root-owned launcher is installed in the existing persistent custom-service mount. Node supervises/restarts the Rust child; s6 supervises Node. Graceful restart, normal Matrix device continuity, and forced Gateway crash recovery were checked.
- Private files/directories use 0600/0700 permissions. The process lock is atomic and heartbeated. SQLite uses WAL, foreign keys, transactions, unique event IDs, and optimistic editable-record versions.

## Automated checks

- `npm run check`: frontend and backend TypeScript passed.
- `npm test`: 14 tests passed, including real Pi SDK execution against a streaming model fixture, persistent and independent sessions, full native configuration/schema, secret masking, native authentication prompts, capability-driven Max/clamping, stale writes/lifecycle operations, SQLite recovery, owner/group filtering, stable outbound retries, and IPC child termination.
- `npm run build`: backend, production React assets, and downloadable corresponding-source archive built.
- `cargo test --locked --manifest-path gateway/Cargo.toml`: 12 tests passed, including owner/group/invitation policy, media validation, protocol readiness, profile fallback, bounded reset classification, durable spool acknowledgments, and arrival-order replay.
- `cargo clippy --locked --manifest-path gateway/Cargo.toml --all-targets -- -D warnings`: passed.
- `cargo fmt --check --manifest-path gateway/Cargo.toml` and `git diff --check`: passed.
- `cargo build --locked --release --bins --manifest-path gateway/Cargo.toml`: production Gateway and test probe built.
- `npm audit --omit=dev`: zero vulnerabilities.

## Browser checks

Live production HTTPS was exercised at desktop and mobile widths, with no browser exceptions or horizontal overflow. Verified no login, cached Matrix person names, final Add Person dropdown option, immediate Agent filtering, Running status, exactly five Agent fields, blank edit password, native provider JSON with masked credentials, built-in authentication controls, and capability-derived thinking levels. An available model with native Max support showed Max; an Off-only model removed it and clamped correctly. Mock-browser tests additionally covered CRUD, lifecycle, deletion confirmation, and conflict handling without discarding unsaved instructions.

## Live encrypted acceptance

The final deployed backend/Gateway passed the complete live driver twice. The driver used isolated rooms and dedicated existing test accounts, then restored provider/global settings and removed temporary local records.

1. Public Matrix profile lookup populated the Person display name.
2. Two Agent accounts operated concurrently in one Gateway.
3. An authorized owner's encrypted DM executed the actual Pi SDK against the real configured DeepSeek provider and returned a decrypted encrypted response.
4. After a full main-service restart, Pi recalled an exact random token and both Matrix device IDs were unchanged.
5. Stranger invitations/messages, group rooms, and a third-party invitation to a previously valid DM caused no Pi execution or response.
6. Blank-password edits retained authentication; Matrix display name and avatar upload/removal synchronized without changing the device.
7. Native custom providers/models, Max thinking mappings, capability clamping, and stale settings conflicts worked through the HTTP API.
8. An encrypted image traversed the real Matrix Gateway and actual Pi SDK, then the fixed safe tool returned a byte-identical encrypted image. A local streaming vision fixture controlled model output for this transport test.
9. Killing the Gateway restored both accounts, retained devices and session state, and did not replay completed Pi turns.
10. Deliberately corrupting only the temporary Agent's crypto database caused one archived, controlled reset and a new device.
11. A second corruption reported Error and did not enter a reset loop.

The reusable operator driver is `scripts/live-e2e.mjs`. It requires private external `probe-owner.json`, `probe-agent.json`, and `probe-outsider.json` files containing dedicated test-account credentials and separate stores; set `LIVE_RECOVERY_DIR` to their directory. It temporarily changes global provider/model settings, restarts the application, and deliberately corrupts only its newly created temporary Agent's crypto database. Its default API target and service commands match this deployment. No test credentials are included in source.

The actual configured owner account also sent an encrypted DM to existing Dot. Dot returned the exact requested `FAMILY-V2-ONLINE` marker in an encrypted reply. The usable DM was retained; the temporary owner test device was logged out and its stored password, token, and crypto store were deleted.

## Practical limits

- Native OAuth flows are implemented and interactive prompt handling is tested, but a complete external-provider OAuth sign-in has not been performed with a real subscription account.
- Image transport and the actual SDK image/tool path were initially verified using a controlled vision fixture. Production image understanding depends on the selected global model's native input capabilities. Model selection and thinking level remain user-managed.
- Automatic compaction is enabled through Pi's native settings. A real-provider conversation was not extended to its full context limit solely to force compaction.
- Unrecoverable credentials and a second corrupt-store failure require correcting credentials/configuration or recreating the affected Agent; they remain visible Error states.

## Existing-DM and device-verification regression (5 November 2026)

The initial new-room-only acceptance missed an existing-conversation regression. The Agent-side direct index contained only the newly created test DM, and the replacement device lacked a signature from the account's existing self-signing key.

The gateway now discovers existing joined DMs only after checking the current owner/Agent pair, invite-only encryption, and direct membership evidence. It merges missing routing entries without weakening group/outsider rejection. Native signing secrets are kept separately from the crypto DB and must match the existing server identity before import and device signing.

Live checks cryptographically verified the unchanged original master → self-signing → current Dot device chain. The actual pre-existing owner room received an encrypted `ORIGINAL-DM-OK` response through Pi and the configured provider; no new room or replacement device was created. Temporary owner test credentials were logged out and deleted. Regression tests cover direct evidence, group denial, and wrong signing-key rejection.

## Official provider cleanup (5 November 2026)

The temporary application-branded DeepSeek alias was removed from deployment configuration. Its key now belongs to Pi's built-in DeepSeek provider, using the official endpoint and native catalog without custom model definitions. An isolated real SDK call using the built-in DeepSeek model returned `DEEPSEEK-OFFICIAL-OK`. The user's current global model selection was preserved. The duplicate Add API Key and Provider Setup actions were replaced with one Configure Provider action using native prompts; supported OAuth Sign In remains separate.

Live desktop/mobile checks confirmed a single connected DeepSeek entry, one Configure Provider action, a masked native key prompt, successful cancellation, no browser errors or overflow, and an unchanged global model selection.

## Advanced provider presentation and redaction (5 November 2026)

Custom provider/model JSON is now behind a default-collapsed Advanced Provider Configuration section with a plain description of when it is needed. The full native editor and schema reference remain available. Credential matching distinguishes secret token fields from ordinary token-limit metadata: `maxTokensField` remains readable, while API keys, access/refresh tokens, token arrays, command-backed values, and custom headers remain masked. Regression checks use the real SDK configuration round trip.

Live desktop/mobile checks confirmed that the editor and save controls are hidden until expanded, the complete editor and schema reference remain accessible, normal provider setup remains visible, and opening the section does not change settings. After deployment, the original owner DM still received an encrypted response and the existing device signature chain remained valid.

## Configured-model selector (5 November 2026)

The Default Model dropdown filters Pi's native catalog by actual SDK availability instead of displaying unconfigured providers. The complete registry remains available to backend configuration code. An unavailable saved choice is preserved with a clear message, and an empty list points to provider setup and disables invalid saves. Provider changes reload the available list. During this check, the native catalog contained 1,592 models, while the two connected providers supplied 46 available models.

Live desktop/mobile browser checks matched the dropdown options exactly to SDK-available models, preserved the saved default, exercised the empty/unavailable state, reloaded after provider changes, included an available custom model, and verified native thinking levels. No settings were saved or changed during these checks.

## Thin Agent Runtime implementation (5 November 2026)

Implemented a shared application-facing interface, an embedded Pi adapter, and a supervised Codex App Server adapter. Existing databases upgrade additively to Pi by default, retain all People/Agents/passwords, and preserve independent runtime defaults. Pi's native providers, tools, sessions, thinking levels, and compaction remain intact. Runtime switching drains or cancels active execution, keeps verified incoming events durable, restores target sessions, and rolls back failed preparation without restarting Matrix clients. Combined homeserver/runtime changes isolate old-server work before queue resumption; Gateway restoration waits for runtime transitions.

Validation for this change:

- Frontend/backend TypeScript checks and all 45 Node tests passed. Tests include real Pi SDK fixture execution, JSONL framing/request correlation, safe approvals, process crashes/reconnection without replay, bounded shutdown, thread persistence/isolation, image input/output, dynamic reasoning metadata, optimistic authentication updates, device-code login notifications, early streaming/tool events, cancellation, runtime switching, rollback, inbox deduplication, and legacy database upgrades.
- All 14 Rust Gateway tests, Clippy with warnings denied, and Rust formatting checks passed. Gateway source and protocol were unchanged.
- The production build, including the corresponding-source archive, passed in a separate temporary source/build directory. The running deployment's executables and service were not replaced or restarted.
- Headless Chromium checks with mocked APIs passed runtime draft/save behavior, per-runtime defaults, Pi provider visibility, API-key login/logout, browser/device-code sign in and cancellation/polling, and dynamic thinking options with no browser errors.
- Installed `codex-cli 0.166.0` passed isolated native initialization, `account/read`, `model/list` (nine discovered catalog models), `config/read`, and `thread/start` with the fixed dynamic image tool. The actual CLI accepted read-only sandbox/network restrictions and live web-search configuration. It requires `on-request` approval policy even though generated types also list `untrusted`; unsupported requests are declined by the client.
- Real native startup confirmed that empty threads have no persistent rollout until their first turn. New Agent threads are therefore deferred until first input. Atomic mappings distinguish never-submitted threads from submitted conversations; submitted history is always resumed and never silently replaced.

No existing desktop Codex credentials were read or reused. Real provider login, billed Codex inference, image understanding, live web search, and encrypted Matrix delivery through Codex have not been performed with live credentials for this change. Account/model entitlement and compaction behavior remain native to the runtime. Direct source links are preserved; opaque native citation markers are not resolved, so Agent instructions request ordinary Markdown source links.

## Runtime deployment (5 November 2026)

Deployed the validated runtime build to the existing `webtop-desktop` service after the user requested deployment and restart. Installed the matching standalone `codex-cli 0.166.0` in persistent `/config/.local/opt/codex-0.166.0/bin/codex`, linked from `/config/.local/bin/codex`. No existing Codex account credentials were copied. The launcher and unrelated services, including Tuwunel, were unchanged.

Stopped only `/run/service/family-agents`, backed up the stopped data directory and previous production build privately, replaced `dist`, and restarted through s6. Both Node and the Matrix Gateway run as UID 1000. The loopback and existing tailnet HTTPS `/api/health` endpoints report ready, Pi remains selected, and the original Agent is Running without an error. Existing Matrix session and signing-secret files are byte-identical across the restart.

The production frontend serves the new runtime selector and device-code sign-in controls. The actual service successfully launched its isolated Codex App Server: `account/read` reports unauthenticated and `model/list` discovers nine models with native reasoning metadata. No login or inference was initiated; the user will test Codex authentication and encrypted conversations from the existing control panel and Matrix client.

## Sign in with ChatGPT migration (5 November 2026)

Replaced the Codex adapter's legacy managed ChatGPT login with the current open-source Sign in with ChatGPT flow, while retaining native API-key login. Installed Pi 1.5.0 is also the current npm release and already supports the new OpenAI flow and a pasted full callback URL; the Codex adapter now follows the official registration and verified-identity contract using an independent credential store. Pi's providers and credentials were not changed.

`ChatGptAuth` persists a stable host ID and separate verified account/client registrations, supports loopback and pasted callback completion, reuses issued client IDs, verifies state/PKCE/JWT signature/issuer/audience/expiry/nonce and plan-use scopes, and serializes rotating refresh tokens with private atomic writes. Sign-out attempts renewable-session revocation and clears tokens while retaining registration metadata. Failed or cancelled attempts preserve a working connection. Existing legacy credentials do not authorize inference through the new flow.

The Codex child receives the access token only in its isolated environment and uses the documented Responses provider at `https://api.openai.com/v1`. Token replacement waits for live execution leases to finish before restarting the shared process and resuming persistent threads. Internal cancellation continues to work while a token replacement is queued. Authentication completion restores desired Agents without replacing existing Matrix clients.

Validation:

- All 68 Node tests and frontend/backend TypeScript checks passed, including 15 SIWC tests with locally signed JWTs and mocked OpenAI endpoints. Coverage includes full callback exchange, real loopback callback delivery, malformed requests, signature/nonce/identity/scope rejection, immediate cancellation during listener startup, cancellation during exchange/commit, expired grants, saved/new registrations, client-ID reuse after a failed code exchange, serialized refresh rotation, revoked refresh grants, and unconfirmed remote revocation.
- Runtime/client tests verify token isolation from process arguments, old-login rejection, two concurrent Agents during token replacement, cancellation and shutdown without process resurrection, callback-driven Agent recovery, and API-key success after a failed SIWC attempt.
- All 14 unchanged Rust Gateway tests passed.
- Headless Chromium with mocked APIs passed new authorization-link, pasted-URL, pending-flow reload, automatic completion, cancellation, invalid/stale callback, saved-account/new-account, plan-use notice, and retained API-key flows with no browser errors.
- The actual installed Codex 0.166.0 accepted the custom Responses provider, environment-only dummy token, native model discovery, explicit per-thread provider selection, dynamic image tool, read-only permissions, and live-search configuration in an isolated smoke test. No real SIWC login or model inference was performed; the user will test those after deployment.

Deployed this migration to the existing s6-managed service after backing up the stopped data and previous build. The loopback and existing tailnet HTTPS health endpoints report ready; Node and Gateway still run as UID 1000. The selected runtime, saved defaults, native thread history, and original Matrix session/signing files were retained. The earlier native ChatGPT connection is explicitly reported as legacy and requires new authorization; the Agent shows an authentication error until that authorization succeeds, then the authentication callback restores it automatically.

Live production smoke checks verified the new authorize endpoint, dynamic client registration, direct-plan scopes/resource, PKCE/nonce, stable host ID, manual callback prompt, and rejection/redaction of a synthetic invalid callback. The synthetic attempt was cancelled without exchanging or replacing credentials. The production frontend serves Continue with ChatGPT and Final Browser URL controls; legacy device-code controls are removed. API-key login is retained. Real sign-in and conversation testing are left to the user as requested.

The user subsequently completed the new Sign in with ChatGPT authorization and reported successful testing. Read-only production checks confirmed `auth_method: siwc`, `authenticated: true`, and the original Agent Running without an error.
