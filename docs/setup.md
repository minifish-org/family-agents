# Setup

## 1. Prepare external services

Keep the existing Tuwunel installation. Provision a dedicated Matrix bot account for each agent using your homeserver's normal administration procedure. Do not reuse a person's account or share a bot account across agents/services. Obtain the owner's **full** MXID, for example `@alex:matrix.example.org`, not an Element display name.

The service needs outbound HTTP(S) access to Tuwunel and the configured model API. Prefer HTTPS, except for a trusted loopback/private model endpoint. Model endpoints are administrator-controlled URLs; credentials belong in the write-only credential form, never in URLs, prompts, collection fields, or logs.

Supported model APIs: `openai-completions`, `openai-responses`, and `anthropic-messages`. Supply the provider's API base URL (for example `http://127.0.0.1:11434/v1` for a compatible local service), exact model ID, context window, and output token limit. An empty model key sends the explicit placeholder `local-no-key` rather than discovering ambient credentials.

## 2. Bootstrap Pith Post

Use the build, persistent master-key, superuser, and serve commands in [README.md](../README.md). Keep the `--dir` path and master key unchanged on every invocation. Go dependencies are pinned in `go.mod`/`go.sum`. `make build` produces a single CGO-free `bin/pith-post` binary, with all UI assets embedded.

The data directory is process-locked and created with private permissions. Do not run the service as root. The example [systemd unit](../deploy/pith-post.service) adds host-level hardening; the application workspace itself is not a sandbox. Make a dedicated `pith-post` OS user, install the binary to `/usr/local/bin/pith-post`, and provide a root/service-readable `/etc/pith-post/environment` file (mode 0600):

    PITH_POST_MASTER_KEY=<the original base64-encoded 32-byte key>

Do not generate a fresh key in the unit's startup command. Put a TLS reverse proxy in front of loopback binding if remote administration is necessary. Disable request-body/header logging at that proxy. PocketBase's authentication/rate-limit/MFA settings are available in its dashboard; enable the settings appropriate for your administrators.

## 3. Configure one owner and one agent

Sign into `/_/` as a superuser. Create an `owners` record:

| Field | Example |
| --- | --- |
| name | Alex |
| mxid | @alex:matrix.example.org |

Create an `agents` record:

| Field | Example / meaning |
| --- | --- |
| name | Family helper |
| owner | Relation to Alex's owner record |
| bot_mxid | @alex-helper:matrix.example.org |
| homeserver | https://matrix.example.org |
| system_prompt | You are Alex's helpful personal assistant. |
| model | Exact ID served by your model endpoint |
| model_url | http://127.0.0.1:11434/v1 |
| model_api | openai-completions |
| context_window | 8192 (use the actual model capacity) |
| max_tokens | 1024 |
| auto_start | false initially; enable after validation |
| auto_reset | false; recommended unless you understand the recovery policy |

Every agent needs its own bot MXID. Owner MXIDs and agent ownership/homeserver/bot fields are immutable. To transfer ownership, create a new agent; never retarget an existing history to a different person.

Open `/post/` and sign in with the same superuser account. Select **Credentials** while the agent is stopped. Enter the bot password and, if needed, the model API key. Values are encrypted with AES-256-GCM and never returned. Blank UI fields preserve existing values. The API can explicitly clear a password or model key with an empty string.

Alternatively supply an access token from a **new, not-yet-E2EE-initialized device**. The token's MXID and device are checked with `/whoami`. Importing an already-used E2EE device also requires restoring its original local crypto store; a token alone is not an encryption identity.

## 4. First encrypted exchange

1. Press **Start**. Pith Post logs in once, persists the device/token, initializes that device's crypto store, creates a private encrypted room, and invites only Alex. The bot alone has invitation/state-change power.
2. In Element, Alex accepts the invitation. Use this room, not a separately created DM. In the admin view press **Resume** if membership is paused. The owner must have joined, not merely been invited.
3. Send an ordinary text message, for example “Remember that my bicycle is blue.” Pith Post rejects plaintext Matrix events, edits, structured mentions, non-owner messages, unbound rooms, and unsafe membership. Incoming attachments are not model inputs in this first version.
4. Wait for the encrypted reply. Check **History** and note the device/room values in the admin view.
5. Restart the agent or the service. Send “What color is my bicycle?” The same persistent conversation, room, and device must be used. Enable `auto_start` if you want the agent to start with the service; otherwise press **Start** after a service restart.

Element may display the bot as an unverified device. This implementation authenticates known owner device keys and MXIDs, but does not provide an interactive SAS/cross-signing verification UI. Use trusted homeserver/device provisioning, and do not interpret the lack of a verification badge as plaintext delivery.

## 5. Add another agent and proactive tasks

Create a second agent related to the same owner, using another bot MXID and a different prompt. Initialize its credentials and accept its separate invitation. Restarting either agent leaves the other running. Prompt/model edits apply on the next turn without a Matrix login.

Use **Proactive task** to queue a Pith task without an inbound DM. The task has a durable idempotency key; programmatic callers must reuse that key when retrying the HTTP request. This release supplies an authenticated trigger API, not a scheduler. A trusted external scheduler can call it.

For attachments, Pith can return the structured content envelope described in [operations](operations.md). Only content goes to the delivery layer; neither a model nor a trigger request can choose a destination.
