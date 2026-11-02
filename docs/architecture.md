# Architecture and security boundaries

## Components

| Component | Responsibility |
| --- | --- |
| `cmd/pith-post` | Private process umask, single-instance data lock, PocketBase bootstrap and shutdown |
| `internal/store` | Locked owner/agent collections; encrypted credentials; durable inbox, runs, outbox, state, and audit |
| `internal/agent` | Per-agent lifecycle lock and serial worker, current configuration per turn, safety gates, proactive queue, retries |
| `internal/pith` | Direct coding-agent SDK embedding; explicit durable session; prepared literal prompt; explicit empty tool allowlist |
| `internal/matrix` | Device restoration/login, encrypted room binding, current membership checks, ciphertext inbox, crypto, uploads and delivery |
| `internal/admin` | Embedded static view and PocketBase-superuser-authenticated management API |

PocketBase is the source of configuration. Its `owners` and `agents` collections have nil CRUD rules: only superusers can manage them. The built-in dashboard handles normal CRUD. Lifecycle and credential changes use custom endpoints. Owners are identities, not PocketBase login accounts. Changing a collection schema or accessing the host is a trusted administrator capability, outside the untrusted-owner boundary.

## Isolation

An owner can have many agents; each agent has exactly one immutable owner relation and a unique immutable bot MXID. Runtime paths use generated PocketBase IDs, not names or caller-provided paths:

    data/
      data.db                         # PocketBase configuration and private post_* tables
      auxiliary.db                    # PocketBase auxiliary data, where applicable
      agents/<agent-id>/
        workspace/
        conversation-<number>.jsonl    # Explicit Pith persistent session
        crypto-<generation>.db        # Mautrix crypto, sync cursor, and state cache

The data directory and descendants are private to the service OS user. Credentials (Matrix password/token, model API key, random per-agent crypto pickle key) are AES-256-GCM encrypted with a fresh nonce and agent-bound authenticated data. The 32-byte master key comes from `PITH_POST_MASTER_KEY`. Credentials are not collection fields or API response properties. Library/provider errors and HTTP bodies are not written to application logs; fixed diagnostics replace them.

**Prompts, transcripts, queued inputs, and completed output content are plaintext on the host.** Use disk encryption, private backups, and trusted administrators. Matrix E2EE protects transport, not the server executing the agent or the external model service. Owners' content necessarily reaches their configured model provider.

Separate directories provide application-level organization, not OS isolation. Pith receives a non-nil empty tool allowlist, no discovered resources, no MCP services, and no custom tools. Literal prompts cannot become filesystem prompt sources. Malicious model tool requests cannot execute file/shell tools. Do not enable tools without a separate sandbox and external-effect review design.

A lifecycle mutex belongs to each agent, not the whole service. Different agents have separate workers, model calls, files, crypto stores, and Matrix clients. Stopping one cancels its model/sync work and waits for cleanup before allowing restart. A process-level flock prevents two binaries from sharing the same data directory.

## Inbound path

1. Restore the original device and crypto store; do not log in again on restart. Missing original stores/keys fail closed.
2. Create one private encrypted room if no room is bound. Persist a creation-intent flag before the non-idempotent Matrix createRoom call. An uncertain outcome requires administrator binding of the existing room, not repeated creation.
3. Sync only the bound room. Persist owner-originated encrypted events before advancing the sync cursor. Unlike mautrix's default sync loop, this service saves the cursor **after** handlers and inbox processing.
4. Decrypt using the restored crypto machine. Keep undecryptable ciphertext for later key arrival; request a missing Megolm session once per process/event. No event decryption failure enters the identity-reset path.
5. Require the bound room, exact owner sender, authenticated known device key, successful decryption, and ordinary text. Reject plaintext, unknown/mismatched/forwarded sender keys, edits, structured mentions, other rooms, bot messages, and non-owner events.
6. Fetch unfiltered authoritative membership and the encryption state. Both owner and bot must be joined; no other member may be joined, invited, or knocking. Unknown state fails closed. Insert the event ID into a uniquely constrained run ledger. Duplicate events cannot create another run.
7. Before execution, repeat the gate. Open the explicit Pith session file and apply the current prompt/model configuration. Only one turn per agent runs at a time.

Unsafe membership transitions are persisted as a pause latch, even when the room later becomes safe again. A security epoch prevents a concurrent unsafe transition from being erased by Resume. Membership changes are observed from both sync and fresh HTTP snapshots. A limited Matrix timeline pauses processing for review rather than silently treating a gap as a complete conversation; automatic historical backfill is not implemented.

## Outbound and crash path

A completed turn and its output items commit atomically to the outbox before any Matrix send. An administrator-triggered proactive task follows exactly the same pipeline, without an inbound DM. The model supplies content only; the Matrix layer supplies the destination.

Attachments use Matrix v2 attachment encryption. Only encrypted bytes are uploaded as `application/octet-stream`; the file key, hash, MIME type, filename, and MXC URL travel inside the encrypted message event. No plaintext thumbnails are uploaded. Generated filesystem paths and URLs are never followed.

The prepared encrypted message is persisted, then sent with a stable transaction ID derived from its outbox identity. Every prepare/send/retry checks membership again, including after long-running generation or upload. Hidden mautrix HTTP retries are disabled. Megolm sharing receives an explicit owner/bot recipient list rather than a mutable membership cache. Key-request sharing also passes the room gate and mautrix recipient-history checks.

After an accepted send with a lost acknowledgement, retrying the same persisted event and transaction produces one visible event on a conforming homeserver. Credential/device changes are prohibited while work is pending to avoid crossing transaction-deduplication scopes. A failed upload may leave orphaned **encrypted** media; it does not create another visible reply.

A crash between SDK session writes and outbox commit is not automatically replayed. Running rows become interrupted on process startup and block further model execution pending review. This deliberately covers the future case where a tool may already have caused an external effect, even though current tools are disabled. A completed outbox survives restart without a new model call. Explicit replay after review may append another user turn to a partially written session; inspect history first.

Membership checks and Matrix sends cannot be one atomic homeserver transaction. A server-side membership change in the final network race cannot be completely excluded; bot-only invite/state power and owner/bot-only key sharing reduce this exposure. A malicious homeserver, compromised owner device, hostile host administrator, and model-provider privacy are outside the E2EE transport guarantee.

## Deliberate first-version limits

No incoming media interpretation, automatic scheduler, interactive SAS/cross-signing UI, Matrix server-side key-backup import, automatic timeline backfill, tool execution, or automatic transcript compaction. Model context exhaustion requires review and, when appropriate, an explicit new conversation. Recover original identities by restoring their local store and matching credentials/pickle key. Keep offline backups; see [operations](operations.md).
