# Matrix Gateway IPC v1

Every stdin/stdout line is one JSON object with `v:1`. Stdout contains only protocol objects; diagnostics use stderr. Commands include `id` (unique correlation string), `op`, and `agent_id` except global status and shutdown. Response: `{v:1,id,ok:true,result:{...}}` or `{v:1,id,ok:false,error:{code,message}}`.

- `start`: `agent_id`, `homeserver`, `matrix_id`, `password`, `owner_id`, `store_path`, optional `display_name` and `avatar:{data,mime_type}`. Data is base64. Restores a saved device and SQLite state; authenticates only if restoration is unavailable/invalid. Repeated start is idempotent.
- `stop`: stop sync for one account without logging out or deleting state.
- `reconnect`: stop and reconnect using the original start configuration, retaining persisted device/state.
- `update_profile`: optional `display_name`, `avatar:{data,mime_type}`. An omitted avatar preserves it; `avatar:null` clears it. This also applies to `start`.
- `send_message`: `room_id`, `text`, `txn_id` (caller-persisted Matrix transaction ID), optional `markdown:true`. The gateway adds sanitized Matrix HTML when it fits the encrypted message budget and keeps `text` as the plain-text fallback.
- `send_media`: `room_id`, `data`, `mime_type`, `filename`, `txn_id`.
- `send_file`: the same fields as `send_media`, restricted to UTF-8 CSV and PDF exports up to 8 MiB. Filenames must be safe Unicode basenames with the matching extension. Files are uploaded encrypted, the room is validated again after upload, and the persisted transaction ID is reused when delivery is retried.
- `set_typing`: `room_id`, `typing:true|false`. Sends an ephemeral typing notice only after the same authoritative encrypted owner-DM validation; no transaction ID is needed.
- `validate_room`: `room_id`; returns `{is_direct,members,encrypted}`. Rejects if room is not an encrypted owner/agent-only DM.
- `status`: returns account status and device identity. Without `agent_id`, returns `{ready:true,agents:[...]}`.
- `ack_event`: `event_id`; acknowledges durable Node inbox storage. Unacknowledged messages replay on startup, in durable gateway arrival order.
- `shutdown`: stops all clients and exits after acknowledging.

`send_message`, `send_media`, and `send_file` accept `thread_root_id` and `reply_to_event_id` together. The caller uses the verified incoming thread root and owner message ID captured in the same room. The gateway requires distinct Matrix event IDs and sends an `m.thread` relation with an explicit reply target in the validated encrypted room. Outbound retries reuse the same relation and transaction ID.

Unsolicited events: `{v:1,event:"status",agent_id,status,error?}` and `{v:1,event:"message",agent_id,room_id,event_id,timestamp,sender,body,is_direct:true,members:[...],thread_root_id?,thread_root_body?,media?:{data,mime_type,filename},document?:{data,mime_type,filename},rejected?:string}`.

`thread_root_id` comes from an incoming `m.thread` relation. The gateway can also include up to 4,000 UTF-16 code units of `thread_root_body` from an original owner or Agent text message it can decrypt in the same room. Root lookup is bounded and optional. If the root text is unavailable, the gateway still emits the thread root ID.

Inbound `m.file` documents must have an encrypted media source. After authoritative owner/DM checks, the SDK downloads and decrypts supported text, source-code, PDF, DOCX, and XLSX attachments; declared and downloaded sizes may not exceed 8 MiB. `body` contains the file caption when present, and `document.filename` retains the original filename. Unsupported, unencrypted, or oversized files emit a bounded `rejected` reason without document bytes, so Node durably acknowledges the event and exposes the limitation instead of silently dropping it. Download failures retain the existing sync retry behavior. Node validates documents again and extracts bounded text before invoking either runtime; it never passes a local file path to the model. Outbound images and supported PDF/CSV files use encrypted media sources.

Only owner messages in encrypted, currently joined one-to-one rooms recorded in Matrix `m.direct` are emitted. Invite handling requires the owner to invite the agent to a private room containing only these two identities. The gateway marks validated invitations as direct. Membership and direct state are rechecked before inbound delivery and every outbound request. Application-level event deduplication, durable inbox/outbox and per-agent serialization remain Node responsibilities.

The SDK SQLite state, authentication session, pending event spool and committed sync cursor all live under the supplied private `store_path`. Session/spool/cursor files use atomic writes and mode 0600; the directory is mode 0700. The gateway commits its own sync cursor after event handlers finish durably spooling, and explicitly restores that cursor rather than trusting a cursor advanced inside the SDK before IPC delivery. Local SQLite corruption has one automatic reset attempt; original files are archived and a persistent marker prevents restart loops. A homeserver or Matrix account identity change requires the backend to archive the old store and supply a fresh directory.

## Disposable live probe

`matrix-probe PRIVATE_CONFIG_FILE` is a standalone integration test client, never part of the running application. The private configuration is `{homeserver,matrix_id,password,store_path}`. It restores its own test device and emits `{event:"ready",matrix_id,device_id}`, decrypted `{event:"message",room_id,event_id,sender,body,encrypted,thread_root_id?,reply_to_event_id?,is_falling_back?}` and invitations. Stdin is JSONL with an `id` and one operation:

- `create_dm`: `invite:[matrix_ids]`, optional `direct` (default true); creates an encrypted invite-only room.
- `send_message`: `room_id`, `text`, optional `thread_root_id` and `reply_to_event_id`. The reply target defaults to the root when opening a thread.
- `send_image`: `room_id`, base64 `data`, `mime_type`, and the same optional thread fields.
- `invite`: `room_id`, `matrix_id`.
- `join`, `leave`, `members`: `room_id`.
- `watch`: `room_id`; permits messages only from this test room to be emitted. Rooms created or joined through this probe are watched automatically. Historical messages from other rooms are suppressed.
- `status`: test account/device/room state.
- `shutdown`: exit.

Command responses are `{id,ok,result}` or `{id,ok:false,error}`. Use existing dedicated test accounts or operator-created accounts; never enable homeserver registration or change real users' credentials for testing.

Temporary membership/media/network read failures replay the same sync response with bounded backoff, rather than silently dropping a valid owner's message. Policy denials (group membership, missing direct state, public or unencrypted rooms) are ignored without executing an agent.

Spool events include a persisted `sequence` used for replay order, independent of event-ID ordering or equal server timestamps. Spool and cursor commits synchronize both file contents and the containing directory before delivery/advancement. A failed spool write is retried even when the event was already inserted into the in-memory map.

Existing joined owner DMs are discovered after authoritative membership, SDK membership consistency, invite-only encryption, and current/previous direct-member evidence are verified. Missing Agent-side `m.direct` entries are merged against current server account data, preserving unrelated conversations. A two-member room without direct evidence is not automatically reclassified.

A private SDK-native `identity-secrets.json` survives crypto-DB recovery. All three recovered signing public keys must match the server before import; the current device is then signed through the official SDK. Native signing bundles are persisted when the SDK has complete signing secrets. No account identity is silently reset.
