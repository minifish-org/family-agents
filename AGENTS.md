# Family Agents V2

Family Agents is a private LAN control panel for family-owned Matrix AI accounts. People use their existing Matrix clients to chat. The web UI has no login, administrator, roles, or chat interface. Write all source, comments, documentation, UI labels, and commits in English. Never commit private data or credentials.

## Architecture and boundaries

Exactly one Node.js/TypeScript process serves Hono and the React UI, owns SQLite metadata, supervises one Rust child, and runs the official Pi TypeScript SDK. The Rust child uses the official matrix-rust-sdk for all Agent accounts, authentication, sync, E2EE, profiles, and media. IPC is versioned JSONL on stdin/stdout; logs belong on stderr. Never move Pi logic into Rust or introduce another agent runtime.

Each Person has a unique full Matrix ID. Each Agent belongs to one Person and has a dedicated Matrix account. Accept only decrypted messages from that owner, in an encrypted invite-only one-to-one room recorded in Matrix direct-message account data. Check authoritative active membership, including invitations, before execution and every send. Ignore self/outsider/group messages. Never trust frontend state for routing.

Global settings contain the homeserver, default provider/model, and thinking level. Agents contain only Matrix ID/password, display name, avatar, and instructions. Pi owns native provider/auth configuration, its catalog, capability-derived thinking levels, persistent sessions, and automatic compaction. Keep all native schema properties through JSON edits and redact secrets in every response/error. Use Pi's capability helpers, including custom thinking maps and Max support. Apply global model/thinking changes between turns.

No shell, filesystem, network, MCP, or automatically discovered extension tools are available to Agents. The fixed `send_image` tool can only return an image attached to the current message. Instructions append to Pi's essential prompt.

## Storage and consistency

`DATA_DIR` defaults to `data/`, with mode 0700 and files 0600:

- `application.sqlite`: People, Agent metadata, optimistic versions, global settings, durable inbox/outbox. Matrix passwords are in a separate encrypted credentials table; `credentials.key` must be backed up with it.
- `pi/models.json`, `pi/auth.json`: Pi-native configuration and authentication, accessible only to the service account.
- `agents/<id>/sessions/`: Pi-native persistent conversation files; restore automatically. No session state is duplicated in SQLite.
- `matrix/<id>/`: SDK SQLite state/crypto stores, original device session, sync cursor, and durable pending-event spool. Acknowledge spool events only after SQLite admission commits. Restore normal devices; classified corruption recovery is bounded and archives the previous state.

Serialize messages and lifecycle changes per Agent; different Agents run concurrently. Check record versions under the same lock as mutation. Settings/provider configuration/authentication reject stale writes. Persist event deduplication and outbound transaction IDs. Never rerun interrupted model executions automatically. Retry completed delivery with the original transaction ID after revalidating routing. One process lock protects each data directory.

## Build, tests, deployment

Requirements: Node.js >=24, npm, Rust >=1.96, a C/C++ compiler and pkg-config. Run `npm ci`, `npm run check`, `npm test`, `npm run build`, and `cargo test --manifest-path gateway/Cargo.toml`. Build the Gateway with `cargo build --locked --release --bins --manifest-path gateway/Cargo.toml`; run `npm start`. `HOST` defaults to loopback, `PORT` to 18090; `GATEWAY_BIN` overrides the child executable. `/api/health` reports core readiness and Agent status.

The existing deployment is the `webtop-desktop` container. Its `/config/work/pith-post` is the existing repository (host bind mount `/srv/webtop/config/work/pith-post`). Run as `abc` (UID 1000), using the existing Node binary. `deploy/family-agents.run` is installed root-owned at `/srv/webtop/custom-services/family-agents`; s6 supervises it. Never restart or change the external Tuwunel homeserver. Stop Family Agents before builds that replace running executables; verify `/api/health`, both process identities, private-tailnet accessibility, and a real encrypted DM after restart. See README for the current restart commands.

## Non-goals

No replacement homeserver, Matrix chat UI, administrator/login/RBAC, configurable workspaces, per-Agent models or thinking levels, session/history/reset controls, custom memory/RAG, custom compaction, E2EE dashboard, general orchestration platform, migration/compatibility layers, or additional infrastructure. Do not reintroduce the removed Go/PocketBase/Pith/mautrix architecture.
