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
- The current real global model is `family-deepseek / deepseek-flash`, thinking Off, configured for text input. Image transport and the actual SDK image/tool path were verified using the controlled vision fixture; production image understanding requires selecting a real image-capable global model.
- Automatic compaction is enabled through Pi's native settings. A real-provider conversation was not extended to its full context limit solely to force compaction.
- Unrecoverable credentials and a second corrupt-store failure require correcting credentials/configuration or recreating the affected Agent; they remain visible Error states.

## Existing-DM and device-verification regression (5 November 2026)

The initial new-room-only acceptance missed an existing-conversation regression. The Agent-side direct index contained only the newly created test DM, and the replacement device lacked a signature from the account's existing self-signing key.

The gateway now discovers existing joined DMs only after checking the current owner/Agent pair, invite-only encryption, and direct membership evidence. It merges missing routing entries without weakening group/outsider rejection. Native signing secrets are kept separately from the crypto DB and must match the existing server identity before import and device signing.

Live checks cryptographically verified the unchanged original master → self-signing → current Dot device chain. The actual pre-existing owner room received an encrypted `ORIGINAL-DM-OK` response through Pi and the configured provider; no new room or replacement device was created. Temporary owner test credentials were logged out and deleted. Regression tests cover direct evidence, group denial, and wrong signing-key rejection.
