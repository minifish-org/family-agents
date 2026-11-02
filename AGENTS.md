# Pith Post — agent instructions

Read this file at the start of every task. Update it when lasting decisions or verified commands change.

## Language policy
All repository-authored code and documentation must be in English: identifiers, comments, tests, errors, logs, configuration examples, and default UI text included. Owners may configure prompts and converse in any language. Never commit credentials, access tokens, encryption keys, or recovery keys.

## Architecture and safety
- Ship one `pith-post` Go binary. `internal/store` owns PocketBase configuration/private ledgers; `internal/agent` owns serial workers; `internal/pith` embeds the SDK; `internal/matrix` owns E2EE; `internal/admin` embeds a static HTML/CSS/JavaScript UI. Tuwunel and model services are external.
- Embed the Pith coding-agent SDK with an explicit persistent session per agent and an explicit empty tool allowlist. Nil enables tools. A workspace is not an OS sandbox.
- Each agent has exactly one full-MXID owner, its own bot/device, prompt, model, workspace, session history, and mautrix-go crypto store. Serialize turns per agent; run different agents concurrently.
- Bind exactly one encrypted DM. Accept only successfully decrypted events from the owner in that room. Verify current membership before execution and every send/retry; deny unknown membership, missing owner, and third-party joins/invites. Ignore other rooms, bot events, and duplicates.
- Only administrators manage agents or secrets. Encrypt stored credentials, exclude secret values from responses/logs, and keep private runtime data outside version control with restrictive permissions. Attachments and message events must both be encrypted.
- Persist encrypted inbox events and run admission before advancing Matrix sync cursors (the upstream default loop advances too early). Persist completed outbox content and encrypted wire bytes with stable transaction IDs. Disable hidden HTTP retries; explicitly share keys only with owner/bot. Interrupted runs require review rather than implicit replay.
- Restart, new conversation, and Matrix identity reset are separate operations. Restore keys/history first and apply prompt edits between turns. Never reset for a decryption failure. Automatic reset needs a classified identity failure, administrator-confirmed impossible recovery, per-bot permission, reason, and unused one-shot guard; manual reset is separately confirmed. Retain old stores.
- Store private data under `--dir` (default `./data`) with a process lock and restrictive permissions. Credentials are encrypted; histories/prompts are not. Back up the stopped process and preserve the external master key. Host/schema administrators are trusted; no workspace provides OS isolation. See `docs/architecture.md` and `docs/operations.md`.

## Verified commands (Linux, Go 1.27.2)
- `make build` → `bin/pith-post` (CGO-free, `goolm`; no libolm or Node build).
- `make test`, `make vet`, `make race` (race needs a C compiler).
- `CGO_ENABLED=0 go test -tags goolm ./...`.
- `make smoke` (Python 3): disposable real-binary startup/restart, CRUD, auth, secrets, and locking.
- With the original `PITH_POST_MASTER_KEY` exported: `./bin/pith-post superuser create EMAIL PASSWORD --dir=./data` while stopped; `./bin/pith-post serve --http=127.0.0.1:8090 --dir=./data`. See README for safe provisioning. UI: `/post/`; CRUD: `/_/`.
- Offline tests use real SDK/crypto with test doubles. Live Tuwunel/Element/model validation is not yet verified; use `docs/testing.md`. Keep this distinction explicit.
