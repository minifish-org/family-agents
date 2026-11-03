# Pith Post — agent instructions

Read this file at the start of every task. Update it when lasting decisions or verified commands change.

## Language policy
All repository-authored code and documentation must be in English: identifiers, comments, tests, errors, logs, configuration examples, and default UI text included. Owners may configure prompts and converse in any language. Never commit credentials, access tokens, encryption keys, or recovery keys.

## Architecture and safety
- Ship one `pith-post` Go binary. `internal/store` owns PocketBase configuration/private ledgers; `internal/agent` owns serial workers; `internal/pith` embeds the SDK; `internal/matrix` owns E2EE; `internal/admin` embeds a static HTML/CSS/JavaScript UI. Tuwunel and model services are external.
- Embed the Pith coding-agent SDK with an explicit persistent session per agent and an explicit empty tool allowlist. Nil enables tools. A workspace is not an OS sandbox.
- Each agent has exactly one full-MXID owner, its own bot/device, prompt, model, workspace, session history, and mautrix-go crypto store. Serialize turns per agent; run different agents concurrently.
- Bind exactly one encrypted DM. Accept only successfully decrypted events from the owner in that room. Verify current membership before execution and every send/retry; deny unknown membership, missing owner, and third-party joins/invites. Ignore bot events and duplicates. Discover owner-initiated private DMs/invitations across rooms; change the active chat only with no unsettled work and after authoritative owner/bot-only membership and encryption verification. Keep the original device, keys, history, and bound destination of pending work.
- Only administrators manage agents or secrets. Encrypt stored credentials, exclude secret values from responses/logs, and keep private runtime data outside version control with restrictive permissions. Attachments and message events must both be encrypted.
- Persist encrypted inbox events and run admission before advancing Matrix sync cursors (the upstream default loop advances too early). Persist completed outbox content and encrypted wire bytes with stable transaction IDs. Disable hidden HTTP retries; explicitly share keys only with owner/bot. Interrupted runs require review rather than implicit replay.
- Restart, new conversation, and Matrix identity reset are separate operations. Restore keys/history first and apply prompt edits between turns. Never reset for a decryption failure. Automatic reset needs a classified identity failure, administrator-confirmed impossible recovery, per-bot permission, reason, and unused one-shot guard; manual reset is separately confirmed. Retain old stores.
- Store private data under `--dir` (default `./data`) with a process lock and restrictive permissions. Credentials are encrypted; histories/prompts are not. Back up the stopped process and preserve the external master key. Host/schema administrators are trusted; no workspace provides OS isolation. See `docs/architecture.md` and `docs/operations.md`.

## Deployment checks
- Match deployment to the actual init system and network namespace. In s6-managed containers, use s6 rather than assuming systemd is available. Keep service launchers root-owned and run Pith Post as the existing non-root data owner, preserving the original data directory and master key.
- Container process supervision, host container restart policy, and Tailscale routing are separate checks. A container-local health check or process restart does not verify host boot or tailnet access. Host Tailscale Serve cannot automatically reach a container's loopback listener. Preserve existing services and forwards; check ports before changing them.
- Service definitions installed in a container's writable layer survive a restart of that container, not container recreation. Read-only host-mounted startup directories must be changed from the host, not remounted or overwritten from the container.

## Verified commands (Linux, Go 1.27.2)
- `make build` → `bin/pith-post` (CGO-free, `goolm`; no libolm or Node build).
- `make test`, `make vet`, `make race` (race needs a C compiler).
- `CGO_ENABLED=0 go test -tags goolm ./...`.
- `make smoke` (Python 3): disposable real-binary startup/restart, CRUD, auth, secrets, and locking.
- With the original `PITH_POST_MASTER_KEY` exported: `./bin/pith-post superuser create EMAIL PASSWORD --dir=./data` while stopped; `./bin/pith-post serve --http=127.0.0.1:8090 --dir=./data`. See README for safe provisioning. UI: `/` (also `/post/`); advanced CRUD: `/_/`.
- Offline tests use real SDK/crypto with test doubles. Live checks have covered Tailscale HTTPS, Matrix profiles, device continuity and encrypted reply delivery. They do not substitute for the full deployment-specific checklist in `docs/testing.md`; keep that distinction explicit.

## Product interface invariants
- The product has exactly one Matrix server, people, and each person's agents. Its UI is blue and white with People and Settings navigation only. Agents are edited directly under their person with display name and image upload; there is no agent dashboard, setup wizard, activity tabs, chat launcher, model configuration UI, or backup/account-maintenance pages.
- Matrix server lives in Settings as a single shared connection. It cannot be changed until both people and agent configurations are empty; enforce this in the save transaction. Probe the public Matrix client versions endpoint before saving a changed address, and allow a connection check at any time without credentials or redirects; new agents cannot override it. Model/runtime configuration is provisioned separately by the operator; retain the existing backend model and prompts during appearance edits.
- Person identity and agent ownership remain immutable. Creating an agent under a person supplies the owner implicitly. Account ID/password are required only for initial connection; never repeat server configuration in agent forms.
- Avatar uploads are authenticated and CSRF-protected, at most 2 MiB and 4096 × 4096 source pixels, normalized to a metadata-free 256 × 256 PNG. Store private image data outside Git. Desired display name/avatar must synchronize to the existing Matrix profile using its original device/token; show pending/failure honestly and support retries. Never reset crypto for profile edits.
- Browser authentication uses revocable HttpOnly sessions plus CSRF, never local-storage tokens. Keep cancellation and failed-form contents intact. Stable creation request IDs prevent duplicate agents after uncertain requests.
- Profile jobs run within the manager lifetime and finish before its database closes. Runtime status reads must not block on a Matrix login; connection happens without freezing other people/forms.
- Preserve per-agent encryption, original identity/history, owner-only DM validation, safe delivery, and explicit interrupted-run review. An owner's new private invitation can reconnect an abandoned chat after verification with no unsettled work.
- Initial administrator provisioning, model/runtime setup, full stopped-directory backups, and other maintenance remain operator work. Do not add product pages for these unless explicitly requested.
- Browser check: start `scripts/ui-fixture.py bin/pith-post`, feed its JSON plus the synthetic `images` PNG fixtures to `scripts/browser-smoke.cjs` under Node/Playwright, and terminate the fixture afterward. The test refuses non-loopback URLs and non-fixture accounts.

- Persist Matrix sync filter IDs in application state: the SDK crypto store does not retain them. A limited timeline is a continuity/resend warning, not an authorization failure; it must not permanently pause an otherwise verified owner-only chat. Only the specific legacy continuity hold can clear after authoritative membership/encryption verification; real membership holds stay explicit.

- Bot device verification bootstraps cross-signing only for a sole device with no existing account identity, persisting private seeds in the encrypted secrets envelope before publication. Existing account public keys must match local private seeds; never reset unknown identities. Sign and cryptographically verify the current device/master/self-signing chain and reuse the same device and keys on restart. Do not expose private seeds or account passwords.

- People are configured with Matrix ID only. Their names are a read-only cache of the Matrix display name, refreshed automatically (60-second success cache, short retry after failure). Preserve the cached name on network/auth failure; use the Matrix ID when no name is available. Never write a person’s profile or require a local name alias. Metadata-only person-name refresh must not invalidate unrelated agent edit revisions.

- People have no edit/refresh form: click their name for read-only identity details and removal; avoid repeating a fallback Matrix ID. Keep Sign out in Settings. Show Check connection for the saved server, or Save server (which probes first) for a changed address; never show an unusable save action. Preserve the explicit empty-people-and-agents requirement for server changes.
- Appearance revisions cover only agent ID/name. Runtime/model changes must not block independent appearance edits. Count display-name limits in Unicode characters. Skip unchanged name writes on image-only saves. Connection/profile retries must retain unsaved appearance edits; do not offer Connect while already connecting, and keep interrupted-reply review reachable even when off.
- Confirmed agent removal stops the worker under the same lock as starts, then deletes only its configuration. Keep credentials, crypto, unfinished tasks and delivery/history archives; removed agents cannot replay or deliver them. No separate disable/stop/review sequence is required to remove configuration.

- People display both Matrix name and avatar, fetched together from the read-only profile endpoint. Cache normalized PNG avatars privately and serve them through the authenticated same-origin API. Download MXC media only through the configured homeserver with redirects disabled; never expose bot tokens or remote image URLs to the browser. Preserve cached avatars on lookup/media failure, and clear them when Matrix explicitly reports no avatar. Reuse unchanged MXC media without repeat downloads.
