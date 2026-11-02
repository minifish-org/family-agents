# Operations and recovery

## Separate operations

| Operation | Conversation | Matrix device/keys | Preconditions |
| --- | --- | --- | --- |
| Stop / Start / Restart | Preserve | Restore original | Credentials and existing crypto store available |
| New conversation | Increment conversation number; retain old files/history | Preserve | Agent stopped; no unresolved runs or deliveries |
| Reset identity | Preserve | Create a new device and crypto-store generation; retain old store | Agent stopped; recovery confirmed impossible; recorded reason; no unresolved work; reset guard unused; password present |

Prompt/model edits in PocketBase apply between turns without restarting the Matrix client. An active turn finishes under its initial configuration. Credential replacement requires stopping the agent. A replacement access token must authenticate the same full MXID and original device and cannot be installed with unsettled work. Password changes alone do not discard a still-valid access token.

Stop is an in-memory lifecycle operation. `auto_start` is the persistent startup policy: switch it off in PocketBase if a stopped agent must remain stopped after a process restart. Configuration deletion requires a stopped agent with no unsettled work. Deletion intentionally retains private files and ledger data for operator-controlled archival/removal; it is not secure erasure.

## Membership pause

Owner leave/ban, third-party join/invite/knock, invalid encryption state, and unverifiable membership prevent execution/delivery. A later safe snapshot does not automatically clear the pause. Repair the room, have the owner join, then press **Resume**. Resume verifies membership again and releases pending completed replies; review those replies first if the room was compromised. Other DMs are never joined or adopted automatically.

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

All routes below require a PocketBase **superuser Authorization token**. Other accounts and unauthenticated requests are denied. Obtain tokens through PocketBase's standard authentication flow; do not put them in URLs or commit them. The custom UI keeps its token in tab memory, not local storage.

| Method/path (prefix `/api/post`) | Body / result |
| --- | --- |
| GET /agents | Config, runtime state, running/review/credential-presence flags; no secret values |
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
