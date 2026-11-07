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

## Native web-search diagnosis (5 November 2026)

The user's current-news question received a response claiming internet access was unavailable. The matching native thread contained no search calls. Its raw assistant reply had valid Markdown links; the existing Matrix path sends plain text, so the client could reinterpret those links when displaying or copying them.

Two configuration gaps were found with actual Codex 0.166.0 protocol probes: custom SIWC providers need `supports_standalone_web_search=true` to advertise native search, and Responses Lite's `functions.exec` wrapper needs `features.code_mode_host=true` to invoke it. The corresponding companion binary is required. Retained `features.code_mode=false` and all existing shell/browser/computer-use restrictions and read-only permissions. Updated the assistant instructions to attempt native search for current information, distinguish search permission failures from general connectivity, and emit plain source URLs for Matrix.

The optional `server/codex-search.test.ts` drives the actual installed binary against a local fake Responses/search server with dummy credentials. It verifies `functions.exec` → native `web__run` → `/v1/alpha/search` → model output, `external_web_access: true`, and no exposed shell/browser/computer-use execution tools. Enable it by setting `CODEX_BIN` when running tests.

The live authorized SIWC probe reached native search, which returned HTTP 401 with `error.type: rejected_by_hardened_oauth_boundary`, `error.code: hardened_oauth_rule_missing`, and the message that the ChatPass credential is not authorized for the requested operation. The same current token was used, without changing its scopes or stored credentials. This is a separate remote authorization boundary from successful Responses inference. Search remains unavailable for the observed SIWC grant; tool configuration and local sandbox changes cannot grant that endpoint access.

All 69 Node tests passed with `CODEX_BIN` set, including the actual-binary search regression; frontend/backend TypeScript checks and the production build passed. The native regression also passed inside `webtop-desktop` as the service user after installing the version-matched Code Mode host companion. Deployed the configuration/instruction corrections through the existing stopped-data backup and s6 restart process. Both health endpoints report ready, SIWC remains authenticated, the original Agent is Running, and Matrix session/signing files are byte-identical. The production process has the tool-host and provider-search capability flags enabled; remote search authorization is still denied for the current grant.

## Explicit new/native/API-key connections (5 November 2026)

The user requested retaining both ChatGPT login methods after the new grant's search authorization failed. The existing application-owned native ChatGPT access token was still valid. A native Codex search request, generated through the actual installed binary and forwarded to `https://chatgpt.com/backend-api/codex/alpha/search`, returned HTTP 200 and search results. The emitted Bearer token matched the original cache and the native account header was present; this check did not rotate the stored credentials. A local synthetic model response triggered the real search operation, without running a new remote model turn or sending a Matrix message. This establishes search access for the observed native grant, separately from the earlier new-flow denial.

Added explicitly selected **Sign in with ChatGPT (New)**, **Codex Native Login**, and **API Key** connections. The upgrade preserves the active new connection and makes retained native credentials available for **Use Connection**. Native browser/device authorization and refresh remain Codex-owned. Independent private caches preserve other connections during setup, switching, and active-only sign-out. No search error automatically switches credentials. Pending native login blocks new turns, and cancelled or failed setup restores the previous connection.

Installed Codex 0.166.0 rejects `thread/resume` across provider IDs with the documented `modelProviderMismatch` discriminator. The adapter handles only that discriminator by creating a native `thread/fork` from stored history and atomically saving its new mapping; arbitrary resume failures still preserve the existing mapping and fail without replay. The actual-binary regression verifies the fork retains the full earlier turn and dynamic image tool and performs no model execution until fresh input arrives.

All 82 Node tests passed with `CODEX_BIN` set, including both actual-binary regressions and the new connection lifecycle/concurrency cases. Frontend/backend TypeScript checks passed. New coverage includes all three credentials coexisting, selected-only sign-out, restart persistence, early/foreign native completion events, cancellation after native `notFound`, timeout/crash/deactivation restoration, expired-SIWC recovery through other login methods, failed-commit recovery, no search fallback, and model discovery concurrent with credential commit. Chromium mocked flows passed all three methods, explicit cached switches, callback/device/browser polling and reload, cancellation, stale-write recovery, and independent model defaults without browser exceptions.

Deployed the production build through the existing s6 service after backing up the previous build and stopped data. Both loopback and tailnet HTTPS health endpoints report ready, the original Agent is Running without error, SIWC remains authenticated and selected, and the retained native connection is available. The native credential snapshot is byte-identical to the pre-deploy cache and private (0600 under 0700); Matrix session and signing files are byte-identical. Both native protocol regressions also pass inside the service container as its service user. A real Chromium production check verified all three methods, an available saved-native **Use Connection** action, no browser exceptions, and that changing the draft selector alone does not activate a connection. The user can now explicitly select the native connection and test current-news replies in Matrix.

## Native history recovery after connection switch (5 November 2026)

The user reported no Matrix reply after explicitly selecting the saved native connection. Production checks confirmed native authentication and inbound delivery, but three inbox entries failed before the native thread mapping changed; no model turn or outbound reply had been created. Native startup omitted the public SIWC provider definition. Codex therefore rejected the stored SIWC thread with `modelProviderNotConfigured` before the documented mismatch/fork recovery could run. The earlier native fixture kept both provider definitions present and did not cover that production startup condition.

The SIWC provider definition now remains registered across authentication choices; its token is still supplied only when SIWC is selected, with native mode using the built-in OpenAI provider and its native credentials. The actual-binary regression now uses the production transition from SIWC to built-in OpenAI with the SIWC environment token absent, verifies the mismatch, forks full saved history, and confirms no old inference is replayed. Gateway Running events also retain existing runtime/session errors so a connected Matrix client cannot hide a failed reply. New Manager regressions cover failure visibility, fresh-message recovery, explicit session recovery, and terminal failed inbox entries.

All 83 tests, frontend/backend TypeScript checks, and the production build passed. Both actual-binary regressions also passed inside the service container. A separate real native model turn in that container used only the existing native access token through Codex's external-token API (no refresh token copied or rotated), invoked live search, and completed with a nonempty answer and HTTPS source URL. It sent no Matrix message and used no private conversation history.

Redeployed and restarted the existing service with the user's selected native connection retained. Production startup successfully forked the previously saved SIWC conversation into a native continuation; the original history remains on disk. The Agent is Running without error, both new/native credentials remain configured, and Matrix session/signing files are byte-identical. The three failed inbox entries remain terminal and no reply was automatically re-executed; a fresh Matrix message is required.

## Family assistant tools, documents, and generated images (5 November 2026)

The user requested webpage/weather/market utilities, calculations/time, document processing, and image generation. The actual installed tool inventory already includes native web search/page reading/PDF screenshots/image search/weather/finance/sports, plus isolated JavaScript Math/Date/Intl and the local clock. Updated assistant instructions to use those tools and explain a specific failed capability rather than claiming all tools are unavailable. A real SIWC model turn through an authorized Responses relay emitted one custom tool call and its output, completed the correct arithmetic, and returned the native clock result. The original native connection stayed selected; no token refresh or credential mutation was performed. This confirms the earlier native search 401 is not a general tool prohibition. Current official SIWC preview limitations exclude hosted image generation, file search, and Code Interpreter.

The Matrix Gateway now accepts supported encrypted `m.file` attachments after owner/direct-room checks, rejects unsupported or oversized documents with an acknowledged terminal record, and sends only bounded decrypted bytes through IPC. Node validates canonical encoding and file metadata, extracts plaintext locally with fixed stdin-only parsers, preserves the owner caption, marks document content as untrusted, limits the combined model input, and revalidates the room after extraction. Text/code/CSV, selectable-text PDF, DOCX, and XLSX work for both adapters without changing the runtime interface or adding dependencies. Local extraction does not execute document code or macros; ZIP/XML and parser resource limits are covered by fixtures.

Native image generation is enabled outside SIWC, subject to SDK model/account gates. The native `family_agent` permission profile denies all local-file reads and writes with command network disabled, and is applied to defaults, thread start/resume/fork, and every turn. Text generation and conversation-image editing remain available, while arbitrary local image paths and symlinks are rejected before upload. The app validates and deduplicates completed image results, restricts artifact fallback to the exact private native thread/item path, and limits each reply to four generated images and 8 MiB total. A real native model turn in the service container generated a PNG of 991,642 bytes and the production image collector accepted it for delivery. The probe used access-only external authentication, isolated temporary history, and no Matrix message.

All 99 Node tests passed inside the service container as `abc`, including actual Codex search/history/image regressions and real local PDF/Office fixtures. All 15 Rust tests passed, frontend/backend TypeScript checks passed, and the new Gateway was built in a separate target directory and smoke-tested inside the container without touching the running executable. Native image fixtures cover generation, inline-image edits, denied repository/sibling/symlink reads even beneath a Git parent, SIWC image-tool absence with clock/calculation retained, output bounds, ownership, cancellation, and duplicate notifications.

Deployed the new Node build and staged Gateway together through the existing s6 service after backing up the stopped data, prior build, and prior Gateway. The selected native connection and existing conversation resumed successfully under the new permission profile. Both health endpoints report ready, the Agent is Running without error, Node/Gateway/Codex run as UID 1000, and Matrix session/signing files are byte-identical. No failed inbox entry was replayed. A production Chromium check verified document help, updated connection capabilities, unchanged active authentication when only the draft selector changes, no browser exceptions, and no desktop/mobile horizontal overflow. The SIWC live clock/calculation proof was repeated successfully under the final deny-all profile.

## Persistent family tools and local Python (6 November 2026)

Added eight fixed application tools for one-time reminders, daily briefing subscriptions, CSV/PDF export, and local Python statistics and plots. Both adapters use the same application-owned definitions and callbacks. Pi registers explicit SDK tools. Codex uses a process-local loopback MCP transport with a separate, revocable bearer capability for each active run; no third-party server, extension discovery, generic execution, or filesystem permissions are enabled. The installed App Server ignores resumed dynamic-tool changes and cached MCP header changes. Native unsubscribe/unload/resume therefore reloads the current run's tools and token on the same saved thread, preserving history without replay.

Schedules and occurrence leases live in additive SQLite tables. Jobs are scoped to the Agent, owner, Matrix identity, homeserver, and originating room. One-time reminders need no inference and do not wait behind a long model reply. Stopped Agents pause delivery. Safe reminder recovery retains the original outbound transaction; uncertain interrupted briefings pause for review instead of repeating inference. Daily times use IANA timezone rules, including DST gaps and folds, and skip missed bursts. Runtime initialization failure still permits Matrix reconnection and delivery of saved reminders without clearing the model error. Daily briefings require the explicitly selected native Codex connection and a completed native search result before delivery; scheduled input cannot create or cancel schedules.

Exports are encrypted Matrix files with validated PDF/CSV metadata, contents, canonical encoding, and stable delivery transactions. CSV exports preserve Chinese and spreadsheet quoting while neutralizing formula cells. The local worker accepts bounded table data and named descriptive/group/correlation operations, with optional bar, line, scatter, or histogram plots. It runs a fixed Python program with a private temporary directory, sanitized environment, process limits, and cancellation; arbitrary programs, local paths, and network instructions are not accepted. Matplotlib 3.11.2 and ReportLab 5.1.0 are pinned in the service's persistent private virtual environment. Matrix now receives typing indicators, one delayed progress notice, explicit failure notices, and cancellation feedback; late artifacts are discarded after cancellation.

Validation for this change:

- All 147 Node tests passed inside the service container as `abc`, with the installed Codex binary and real Python graphics/PDF dependencies enabled; no tests were skipped. Coverage includes existing-history tool upgrades, concurrent Agent isolation, retired-token rejection, duplicate-call protection, cancellation, schedule scope/timezone/lease recovery, independent reminder delivery, unavailable model authentication after restart, verified-search gating, and encrypted file delivery validation. The eight artifact tests were rerun after tightening early CSV control-character validation and passed.
- Frontend and backend TypeScript checks passed. The real worker generated extractable Chinese PDF text and actual PNG charts, and calculated missing-value statistics, grouped aggregates, and paired correlations correctly.
- All 17 Rust Gateway tests passed, along with Rust formatting and Clippy with warnings denied. The release Gateway was rebuilt in its isolated staging target directory without replacing the running executable.
- An isolated live native model conversation retained the same thread while creating a reminder and daily subscription, exporting CSV and PDF, and returning a Python-generated PNG chart. Both inbox turns completed successfully. A second isolated due-job check delivered a saved reminder without inference and a real live-search briefing, completed both occurrence records, and scheduled the next daily run. These checks used an access-only copy of the application's existing native connection, could not rotate its renewable grant, and sent no messages to real Matrix rooms.
- The production build and corresponding-source archive passed in a separate staging directory. Deployed Node, the rebuilt Gateway, and the Python/timezone launcher together through the existing s6 service after backing up the old executables, launchers, and stopped data. Loopback and tailnet HTTPS health checks report ready, the original Agent is Running without error, and Node/Gateway/Codex each run as UID 1000. The new Python interpreter and default timezone are active. Matrix session/signing files and the native thread mapping are byte-identical; inbox states remain unchanged with no failed execution replayed.
- A read-only production Chromium check verified the new reminder/briefing and CSV/PDF/Python help, all three retained authentication methods, the still-active native connection, and unchanged authentication when choosing only a draft connection. Desktop/mobile layouts have no horizontal overflow and no browser exceptions. Recoverable backups remain outside the checkout; temporary old executables were removed after comparing them with those backups.

The current production connection and conversation are retained. Real encrypted Matrix acceptance testing of the new requests is left to the owner.

## Installable control panel and project introduction (6 November 2026)

Added a same-origin web app manifest with a stable root identity, standalone launch mode, application colors, and 192/512 PNG icons rendered from the existing SVG brand mark. Assets use the existing `/assets/*` static route. A small React component exposes Install App only after Chrome supplies an install event, opens the browser confirmation on a user click, consumes each event once, and hides the action when installed or running standalone. Installation uses the existing service; no service worker, offline cache, API cache, or additional runtime is introduced.

The README now describes the current Matrix, runtime, authentication, scheduling, document, and data features and explains Chrome installation over trusted HTTPS or localhost. GitHub's repository description was updated and read back successfully. Chrome controls installation eligibility and prompt timing; a manifest does not force an automatic native dialog on every visit.

Frontend/backend TypeScript checks, the production build, and the diff check passed. A fresh persistent Chromium 156 profile loaded the staged production assets through the actual Hono static route: the manifest MIME type is `application/manifest+json`, both PNG icons decode at their declared sizes, and native CDP manifest/installability checks report no errors.

All 14 browser checks passed. Full Chromium, using a fresh persistent profile with foreground interaction, emitted a trusted `beforeinstallprompt` after 31 seconds and displayed the actual Install App action. Separate synthetic-event checks verified single use, dismissal, duplicate-click protection, installed/standalone suppression, and a safe failure hint. Home and Settings layouts fit 1280, 390, and 320 pixel viewports with no horizontal overflow, no JavaScript errors, and no backend writes. The lightweight headless shell did not emit the event; the full browser did, so the real-event result does not rely on synthetic dispatch.

Published the static assets and entry page atomically after backing up the previous frontend and source offer, retaining older asset hashes for open tabs. The backend process continued running. The actual tailnet HTTPS service passed the same native CDP manifest/installability checks and emitted a real install event in full Chromium. Read-only production checks preserved the active native login, reported no browser errors or horizontal overflow, and made no backend writes. The Agent remains Running without error; Matrix device/signing files and the native thread mapping are unchanged.

## Automatic Matrix reconnection (7 November 2026)

Reproduced a temporary sync failure leaving an Agent permanently Stopped: the later running event was rejected because the transport error was mistaken for an independent runtime failure. The Manager now tracks transient connection errors separately, clears only the matching transport status on recovery, and immediately drains queued work through its existing serial queue. Model, session, interrupted-reply, and delivery errors remain visible. Gateway status strings retain their redacted diagnostic text instead of becoming the generic Operation failed message.

The Gateway no longer abandons synchronization after eight temporary network or homeserver failures. It keeps the existing capped backoff and original device, and separates network failures from inbound persistence failures. Authorization failures, repeated inbound persistence failures, and sync-cursor write failures retain their terminal behavior. Interrupted or failed inference is never replayed.

All 157 Node tests passed in the service container with native Codex and the configured Python interpreter enabled, with no skips. New Manager regressions first failed against the old behavior and now cover automatic processing without another incoming message, preservation of independent errors, and diagnostic redaction. All 24 Rust tests, Clippy with warnings denied, Rust formatting, frontend/backend TypeScript checks, and the diff check passed. Rust regressions cover more than eight temporary failures, bounded backoff, saturation, and terminal authorization failures. The Node build and source offer were prepared outside the running checkout.

The staged release Gateway passed a real process readiness/shutdown check. After backing up the prior executables and stopped private data, installed only the changed Manager output, Gateway, and corresponding-source archive through the existing s6 service. Both configured Agents now report Running without errors through loopback and tailnet HTTPS; Node, Codex, and Gateway run as UID 1000. All ten saved Matrix identity/session and Codex thread-mapping files are byte-identical; only the two normal sync cursors advanced. All 34 inbox states are unchanged and no reply is awaiting delivery. No new encrypted owner DM was sent during deployment; a fresh owner message remains the live reply acceptance check.
