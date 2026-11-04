# Family Agents

Source repository: [minifish-org/family-agents](https://github.com/minifish-org/family-agents).

A small private LAN control panel for family Matrix AI agents. Pick a Person, manage their Agents, and chat with those Agents from an existing Matrix client. The control panel intentionally has no login, administrator account, roles, or chat UI. Anyone who can reach it can manage all local configuration.

The application consists of one Node.js/TypeScript process (Hono, SQLite, the official Pi SDK, and a React UI) and one supervised Rust process (official matrix-rust-sdk). Tuwunel remains an independent external homeserver. No Go backend or previous runtime is required.

## Install and build

Use Node.js 24 or later, npm, Rust 1.96 or later, a C/C++ compiler, and pkg-config. On Debian/Ubuntu, the native build dependencies are `build-essential pkg-config libssl-dev`.

```sh
npm ci
npm run check
npm test
npm run build
cargo test --locked --manifest-path gateway/Cargo.toml
cargo build --locked --release --bins --manifest-path gateway/Cargo.toml
npm start
```

The build includes a corresponding-source download linked from the UI footer. It uses an explicit source allowlist and excludes private runtime data.

The UI is served at `http://127.0.0.1:18090`. `GET /api/health` reports readiness and individual Agent status. Set `DATA_DIR`, `HOST`, `PORT`, and optionally `GATEWAY_BIN` through the service environment. Keep the listener on loopback behind the existing private network proxy, or bind only a designated private interface. Do not expose this unauthenticated management panel to the public Internet.

For development, build the Gateway once, run `npm run dev`, and start Vite with `npx vite --host 127.0.0.1`. Vite forwards `/api` to the local backend.

## Configure

1. Open Settings, enter the Matrix Server URL, and open Providers.
2. Use Configure Provider for the built-in provider's complete native API-key setup, or Sign In for a supported account authorization flow. Official services should use their built-in provider, with custom model overrides under that provider only when needed. For custom providers/models, expand Advanced Provider Configuration to use the structured shortcut and complete native JSON editor. Official provider connections do not require this section. The linked schema is the exact schema shipped by the pinned SDK. Stored keys, tokens, and custom header values are masked and preserved when saving their placeholders.
3. Choose the global default model from the available models of configured providers and select a supported thinking level, then save Settings. Unconfigured providers do not populate the model dropdown. All Agents use these defaults at the next turn boundary.
4. Choose `+ Add Person` in the Person dropdown and enter their full Matrix ID. The public Matrix display name is fetched when possible; otherwise their Matrix ID is used.
5. Create an Agent with its dedicated existing Matrix account/password, display name, optional image, and optional instructions. Use an existing encrypted one-to-one DM or invite it from its owner's Matrix client. Existing direct conversations are discovered automatically after membership and direct-state validation.

The Agent account must already exist; this application does not enumerate or administer homeserver users. New authentication errors are shown on the Agent. Leave Password blank during editing to retain its credentials. A changed homeserver reinitializes Matrix connections, archives previous stores, and isolates old pending work; reenter credentials if the new server requires it.

Providers retain Pi's full native configuration, including built-in overrides, custom model definitions, compatibility, headers, pricing, modalities, limits, and thinking mappings. Supported thinking levels come from the effective model and SDK rather than provider-specific application rules. OAuth setup may request a browser URL, device code, choice, or secret according to the provider.

## Behavior and storage

Only decrypted owner messages in encrypted, invite-only one-to-one rooms recorded as direct messages are accepted. Current membership is checked before execution and every send, including retries. Group rooms, invitations from strangers, self messages, and duplicate event IDs do not execute Agent turns. Different Agents can run concurrently; each Agent's messages and lifecycle operations are serialized.

Pi automatically restores each Agent's persistent conversation and uses automatic compaction. Instructions extend the runtime system prompt. There is no shell, filesystem, or arbitrary network tool. The fixed image tool can return an image from the current incoming message. Images require a global default model with image input support; unsupported-model errors are explicit. The backend also supports proactive owner-room text/image delivery at `POST /api/agents/:id/send` with `{room_id,txn_id,text}` or `{room_id,txn_id,media:{data,mime_type}}`; reuse the same transaction ID when retrying an unchanged request.

Private runtime data is kept outside Git in `data/` (0700; private files 0600):

| Location                                   | Owner                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `application.sqlite` and `credentials.key` | Application metadata, encrypted Matrix passwords, optimistic versions, durable inbox/outbox |
| `pi/models.json`, `pi/auth.json`           | Native Pi provider/model configuration and credentials                                      |
| `agents/<id>/sessions/`                    | Native Pi conversation files                                                                |
| `matrix/<id>/`                             | SDK SQLite crypto/state, device login, sync cursor, unacknowledged events                   |
| `matrix-archives/`                         | Stores isolated after identity/server changes                                               |

Back up the complete stopped data directory. Restoring only the application database without its key, Pi files, or Matrix stores is incomplete. Pi transcripts, Matrix crypto databases, and native auth/config files are protected by local permissions; use encrypted storage/backups when required. Normal restarts preserve Matrix devices and their existing cross-signing identity. Private native signing bundles are stored as `matrix/<id>/identity-secrets.json`; recovery imports must match the server's existing public identity before the current device is signed. An account with an existing signing identity requires its original signing secrets to verify a replacement device; a password alone is not proof of those secrets. Classified local corruption triggers one bounded recovery attempt and retains the old state. Interrupted model runs are not replayed automatically; the Agent shows a warning and can accept a fresh message. Completed replies use persistent transaction IDs and retry delivery without rerunning Pi.

## Existing deployment

The repository remains in `/config/work/pith-post` inside `webtop-desktop`, backed by `/srv/webtop/config/work/pith-post` on the host. The application runs as the existing `abc` user. `deploy/family-agents.run` is installed root-owned at `/srv/webtop/custom-services/family-agents`, so the existing custom-service startup restores it after container recreation. s6 supervises Node; Node supervises the single Rust Gateway.

From the host, restart with:

```sh
sudo docker exec webtop-desktop /command/s6-svc -r /run/service/family-agents
```

After container recreation, the generated s6 service is named `custom-svc-family-agents`; use that path instead. Stop it with `s6-svc -d` before production rebuilds, and start with `s6-svc -u`. The existing tailnet-only endpoint is `https://minifish-lab.taila2cd17.ts.net:8456/` (also port 8450). Tuwunel and unrelated services are not part of the application restart.

The pre-rewrite Git checkpoint is `checkpoint/pre-v2-20261104`. An operator recovery snapshot was saved outside this checkout. It is not used by V2.

## Verification

`npm test` covers SQLite transactions/credentials/conflicts/deduplication, owner/DM routing, lifecycle serialization and delivery, and the actual Pi SDK against a local streaming model fixture. `cargo test` covers Gateway membership, media, protocol, and bounded recovery policies. `make check` additionally runs Rust Clippy. The standalone `matrix-probe` binary is an operator test client for live encrypted DM checks; its private config and credentials must remain outside Git.

See `VALIDATION.md` for the deployment-specific verification and remaining limitations. Read `AGENTS.md` before modifying architecture or routing.

## License

GNU AGPL v3. The bundled LICENSE applies. Operators must provide corresponding source as required by the license.
