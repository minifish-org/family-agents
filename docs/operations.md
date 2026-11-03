# Operations and recovery

The current product surface is intentionally limited to one Matrix server, people, and their agents' display names and avatar images. See [setup](setup.md) and [interface coverage](interface-coverage.md). The maintenance APIs and operator procedures below remain available without adding pages to the product UI.

Avatar media is stored under the private data directory in `post_agent_profiles`; include it in stopped-service backups. Desired and applied Matrix profile states are separate so a failed provider update does not lose the saved image/name or incorrectly report success. Profile jobs share the manager lifecycle and cannot outlive its database. No credential, device, room or AI configuration is changed by an appearance edit.

## Separate operations

| Operation | Conversation | Matrix device/keys | Preconditions |
| --- | --- | --- | --- |
| Stop / Start / Restart | Preserve | Restore original | Credentials and existing crypto store available |
| New conversation | Increment conversation number; retain old files/history | Preserve | Agent stopped; no unresolved runs or deliveries |
| Reset identity | Preserve | Create a new device and crypto-store generation; retain old store | Agent stopped; recovery confirmed impossible; recorded reason; no unresolved work; reset guard unused; password present |

Instructions and shared-model edits in Pith Post apply between turns without restarting the Matrix client. An active turn finishes under its initial configuration. Credential replacement requires stopping the agent. A replacement access token must authenticate the same full MXID and original device and cannot be installed with unsettled work. Password changes alone do not discard a still-valid access token.

**Turn off** persists `auto_start=false` and drains the current reply before stopping. Queued work is retained; no new turn starts after disabling. **Turn on** persists the preference and starts immediately. Advanced **Stop now** disables and interrupts immediately. The low-level `stop` endpoint remains a temporary lifecycle operation for controlled recovery, so recovery forms stop, change, and restore the saved Enabled preference. Configuration deletion requires a stopped agent with no unsettled work. Deletion intentionally retains private files and ledger data for operator-controlled archival/removal; it is not secure erasure.

## Membership pause

Owner leave/ban, third-party join/invite/knock, invalid encryption state, and unverifiable membership prevent execution/delivery. A later safe snapshot does not automatically clear the pause. A newly created encrypted room with only the joined bot and invited owner is shown as **Waiting for invitation**, without creating a security hold. Repair any actual membership issue, have the owner join, then use **Resolve → Check and resume**. Resume verifies membership again and releases pending completed replies; review those replies first if the room was compromised. Only the configured owner’s private invitations/DMs may reconnect the assistant. They are verified, encrypted, and adopted with no unsettled work; the original Matrix device, keys and history remain. A verified new private chat can release the hold left by an abandoned old room. Group chats and other users are excluded.

Only the bot has invitation/state-change power in newly created rooms. If a room-creation request times out or the process dies before binding, do not keep creating rooms. Accept the existing invitation as owner and use `bind-room` while stopped. Binding requires encrypted owner-only joined membership and is permitted only when no room is already bound.

## Backup and restore first

1. Stop the **whole process**, not only an agent. Do not rely on PocketBase's online ZIP backup for an atomic snapshot spanning independent crypto databases and SDK files.
2. Copy the entire data directory, including SQLite sidecars if present, and encrypt the backup. Keep the original master key separately in a secret manager/offline secure copy. Test restoration regularly.
3. Restore to a private directory with the same agent IDs and original master key. Never run the restored copy at the same time as the original against the same Matrix accounts.
4. For per-agent crypto recovery, with the process stopped, restore that agent's matching `crypto-<generation>.db` and sidecars from a consistent backup. Preserve its original device ID, token, and pickle key. Restoring only a crypto DB while retaining the current run ledger avoids rolling back deduplication. Restore the whole matching backup if credentials/state were also lost, and review the possible replay window before resuming.
5. Start normally to attempt restoration. A missing/corrupt store, missing pickle key, invalid token, or device mismatch never authorizes plaintext fallback. A token from a fresh device is not a replacement for original encryption keys.

The master key is not regenerated automatically. Losing it prevents reading stored credentials and crypto pickle keys. This release does not rotate the master key or import Element recovery keys/server-side Matrix backups. If the matching original data cannot be recovered, provision fresh credentials/agents under a consciously reviewed new deployment rather than silently discarding the encrypted secret store.

## Confirmed impossible recovery and reset guard

A single undecryptable event only records a fixed diagnostic and retains ciphertext for future key arrival. It does **not** reset anything. Fresh events may still work with the original identity.

Manual **Reset encryption identity** is an explicit administrator action. Record why the original identity cannot be recovered (10–500 bytes; no secrets) and confirm that recovery is impossible. The operation retains the old crypto file and conversation, commits its reset intent, and consumes the durable one-shot guard **before** the next network login. Start the agent afterward. The new device may not read old messages; send a fresh owner message after it is initialized.

For optional automatic reset, both of these administrator decisions are required:

- Enable that agent's `auto_reset` configuration flag.
- While stopped, call `confirm-recovery-impossible` with the explicit confirmation and reason after exhausting backup recovery.

Start still attempts the original identity first. Only a classified crypto-identity failure, the confirmation, the enabled flag, and an unused guard allow one automatic reset. Generic network/login/room errors do not. There is no repeated-reset timer, and a failed replacement initialization does not consume a second identity. Further identity replacement requires operator investigation and a newly provisioned agent, not clearing the guard casually.

Cancel queued runs with `cancel-run` if initialization cannot be recovered and they cannot safely execute. Review interrupted runs separately. Resolve pending sends before resetting or replacing a token. The server might already have accepted an unacknowledged send. `discard-delivery` is an audited administrator escape hatch, not proof that the event was never visible.

## Interrupted execution

Interrupted or failed generation blocks new model runs until reviewed. Stop the agent, inspect **History** and the private SDK session file, and assess any possible effects before choosing review-without-replay or explicit replay. Current chat-only execution has no tool effects, but this rule intentionally remains strict. A normal restart is never an implicit replay decision. New conversation also requires resolving pending work. Delayed ciphertext from an earlier conversation is discarded rather than admitted into the new conversation when keys eventually arrive.

## Authenticated API

All routes below require a PocketBase **superuser Authorization token** or the UI's revocable browser session. Other accounts and unauthenticated requests are denied. Login exchanges a transient PocketBase token for a 12-hour HttpOnly, SameSite=Strict cookie, secure over remote HTTPS. Browser mutations require the session CSRF header and same-origin requests. Logout revokes the session; changing the administrator token key invalidates it. No authentication token is kept in browser storage. Programmatic clients may continue using Authorization tokens, never in URLs.

| Method/path (prefix `/api/post`) | Body / result |
| --- | --- |
| POST /session; GET /session; DELETE /session | Exchange a bearer login, restore session and CSRF token, or revoke session |
| GET /owners | People with Matrix-derived names and avatar cache hashes |
| POST /owners; PATCH, DELETE /owners/{id} | Create by full Matrix ID; names/images follow Matrix automatically, identity is immutable, only unused people can be removed |
| GET /account; POST /account/password | Password requirements; verify current password, save a new password, revoke all of that administrator’s sessions |
| POST /assistants | Atomic assistant/person/credential creation; stable `request_id` makes retries idempotent |
| PATCH /assistants/{id}; DELETE /assistants/{id} | Edit name, prompt, connection with revision check; explicitly stop and remove configuration, retaining unfinished-work and identity/history archives |
| GET, POST /connections; PATCH, DELETE /connections/{id} | Shared model configuration; `key` is write-only; referenced connections cannot be removed |
| POST /connections/{id}/check | Request saved model list; do not follow redirects or generate |
| GET, POST, DELETE /draft | Administrator-specific nonsecret setup progress |
| GET, POST /profile | Optional personal Matrix ID for chat links; grants no room access |
| GET /agents | Config, state, counts, desired/actual availability, credential-presence flags, revision; no secret values |
| POST /agents/{id}/enable, disable, stop-now | Persistent availability; disable drains, stop-now interrupts |
| GET /agents/{id}/history | Last 100 runs and outbox entries; attachment bytes and encrypted wire payload omitted |
| POST /agents/{id}/start, stop, restart, resume, new-conversation | Empty object |
| POST /agents/{id}/credentials | Optional `password`, `access_token`, `model_key` strings; omitted preserves; empty password/model key clears |
| POST /agents/{id}/trigger | `{"key":"caller-stable-id","prompt":"Prepare a message for the owner"}` |
| POST /agents/{id}/cancel-run | `{"run":"queued-run-id"}`; agent must be stopped; never cancels running/completed work |
| POST /agents/{id}/review | `{"run":"run-id","replay":false,"confirm_external_effects_reviewed":true}` |
| POST /agents/{id}/bind-room | `{"room":"!existing:example.org"}`; no prior binding allowed |
| POST /agents/{id}/confirm-recovery-impossible | `{"reason":"Backups checked; original keys unavailable","confirm_recovery_impossible":true}` |
| POST /agents/{id}/reset-identity | Same explicit confirmation/reason body |
| POST /agents/{id}/discard-delivery | `{"id":"outbox-id","reason":"Operator reviewed delivery uncertainty","confirm_may_already_be_visible":true}` |

A trigger's key identifies the entire logical task, not a network attempt. Reuse it with the same prompt on retries; a different prompt with the same key does not create another run. All content is delivered only to the configured bound room. Requests are capped at 128 KiB, input text at 24,000 bytes, and completed runs at eight content items, each attachment at 8 MiB.

### Pith content envelope

Ordinary output is text. To provide attachments, the Pith reply must be only a JSON object in this form (data is base64):

    {"pith_post":[
      {"kind":"text","text":"Here is your note."},
      {"kind":"file","name":"note.txt","mime":"text/plain","data":"SGVsbG8="}
    ]}

Use `kind: image` for PNG/JPEG/GIF/WebP. SVG and other types must be files. This protocol does not grant filesystem or URL-fetch access, and cannot supply a room ID. A model incapable of emitting the requested attachment bytes cannot generate arbitrary images by itself; connect a suitable model/content producer only after preserving these boundaries.

## Upgrade from the original operations UI

With the complete stopped data directory backed up and the original master key available, replace the binary and start it against the same data directory. Initialization creates one shared connection per existing assistant using its exact model configuration and encrypted model key. It preserves original bot credentials, device, room, crypto stores, conversations, queue, and security holds. Future model edits use the shared connection rather than legacy per-agent fields. Existing discarded deliveries are recovered from their audit records and displayed as discarded rather than delivered.

The root and `/post/` both serve the real embedded application. The former `/preview/` endpoint is removed and returns 404; remove any reverse-proxy static preview override when upgrading. Initial administrator provisioning remains a local CLI operation. Backups remain an operator procedure; activity currently shows the latest 100 tasks and deliveries rather than a full export.

## Owner-initiated chat reconnection

The sync filter includes owner invitations and other rooms so a new private DM can be discovered. Content admission and delivery still target only the active, verified encrypted private chat. A configured-owner invitation or fresh owner message in a verified two-person DM requests a transport restart. The old transport drains safely; pending tasks prevent a destination change. Historical room events cannot request another switch after the connection timestamp. A first limited timeline in a newly adopted room is initial history, not a gap in an existing monitored stream; subsequent gaps record a resend warning without pausing an otherwise verified private chat. Normal mentions in an authenticated owner's text are accepted.

The product UI manages people, agents and the shared Matrix connection. It has no chat launcher, personal Matrix profile, duplicate Overview tab, or intermediate chat-link dialog. Conversations happen in the Matrix client.

## Shared setup defaults

`GET /api/post/defaults` returns the shared Matrix server and default model connection. `POST /api/post/defaults` requires all people and agent configurations to be absent before changing the server. A changed address must pass a public Matrix client versions check before it is saved; the empty-configuration condition is checked again in the write transaction. `POST /api/post/defaults/check` checks a supplied address without saving it or sending credentials; redirects are not followed. All endpoints require administrator authentication, and browser writes require CSRF.

On upgrade, a single common existing homeserver is adopted automatically. Agents inherit the shared server and model connection; per-agent server overrides are rejected. People are configured by Matrix ID only. Their display names and avatars are read from Matrix with a short cache; errors preserve cached values and explicit avatar removal clears the cached image. `GET /api/post/owners/{id}/avatar` serves the authenticated, normalized PNG. Remote MXC media is fetched only through the configured homeserver, with no browser-visible tokens or external image URLs.

`PATCH /api/post/assistants/{id}/persona` accepts `prompt` and a persona-specific `revision`, updates only the system prompt, and applies from the next model turn. Empty or whitespace-only input restores the default persona. The agent does not restart and its identity, history and model remain intact.

`PATCH /api/post/assistants/{id}/appearance` updates only the display name using an appearance-specific revision. `GET`, `PUT` and `DELETE /api/post/assistants/{id}/avatar` manage a private normalized image; uploads accept PNG/JPEG/GIF/WebP up to 2 MiB and 4096 × 4096 pixels. `POST /api/post/assistants/{id}/profile-sync` retries synchronization using the existing Matrix account/device. These operations never change the agent's owner, model, instructions, encryption identity or conversation.

## Restart continuity

The application retains its all-room Matrix sync filter ID in `post_state`; the SDK crypto store intentionally does not save filter IDs. Limited timelines indicate possible missing history and produce a resend diagnostic, not an authorization hold. No missing task is silently replayed. The exact legacy timeline-gap hold can be cleared only after an authoritative encrypted owner/bot-only snapshot. Membership, encryption, key authentication, interrupted-run review and pending-delivery protections remain intact.

## Bot device verification

A bot with one device and no existing cross-signing identity can bootstrap its own account verification. Private cross-signing seeds are persisted in the existing AES-GCM secret envelope before public keys or signatures are uploaded. The original Olm device/keys, room and conversations remain unchanged. Reconnect imports the same seeds, checks that server public keys still match, and signs/verifies the device and account identity without resetting them. An existing account identity with unavailable private keys requires recovery rather than replacement. These signing seeds must be retained in backups and across rollbacks after publication. Matrix account password authorization is used only if the server requests it.

This removes the missing self-verification condition; a receiving client's independent trust of the bot's account identity is separate. Clients may need a key refresh before updating existing message indicators.

## Global model selection

`GET /api/post/model-catalog` exposes Pith's built-in API-key provider catalogs and per-model thinking strengths, plus compatible custom services. OAuth-only provider sign-in flows are outside this API-key configuration interface. `GET /api/post/model-settings` returns public saved-provider metadata, current selection and a revision; it never returns keys. `POST /api/post/model-settings` saves provider/model/thinking and an optional replacement API key under that revision, then selects it globally. Built-in model endpoint, API, capacities and compatibility come from Pith; custom services reuse their saved endpoint/capacities. All routes are administrator-only and browser writes require CSRF.

The global choice is stored separately from agent identity records and is read with its encrypted key between turns. Existing personas, Matrix identities, histories and the current in-flight reply remain intact. Historical Matrix continuity warnings stay in backend diagnostics and are not displayed as permanent agent-edit instructions. No Matrix slash command has been added.

## Automatic conversation compaction

Every model turn reopens the agent's existing persistent Pith session. The SDK's RunPolicy.Summarize hook now calls Pith GenerateSummary using the currently selected model and the same explicitly supplied saved API key. Pith handles token estimates, turn-boundary selection, summary prompting and append-only compaction checkpoints. The pre-prompt reserve also includes the current Persona/instructions and incoming message, alongside the model's output capacity. No new conversation, Matrix login or identity reset is required.

The active model context becomes the checkpoint summary plus the SDK's recent complete turn and subsequent messages. Original messages remain in the private JSONL history; reopening the session restores the checkpoint. Further compactions include the previous summary. This supports long conversations within a finite model context; summaries are lossy and do not guarantee perfect recall of every historical detail.

Compaction runs without tools or hidden HTTP retries. A cancelled, incomplete, empty or failed summary does not commit a checkpoint or rewrite historical messages. A compaction failure follows the existing interrupted-run review path; it does not silently replay the owner's request. Only the normal model reply enters the outgoing chat pipeline; compaction summaries are never sent as replies.
