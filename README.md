# Family Agents

Self-hosted AI assistants for your family, available through your existing Matrix clients.

Family Agents gives each family member their own AI assistants, each with a dedicated Matrix account, name, avatar, and instructions. Use the web control panel to configure them, then chat in encrypted direct messages from your usual Matrix client.

- **Personal assistants:** each Agent belongs to one Person and responds only to that owner's verified direct messages.
- **Familiar chat:** conversations happen in Matrix; the web panel manages People, Agents, and shared settings.
- **Your choice of model:** configure providers through the Pi SDK, including API keys and supported account sign-in flows.
- **Two runtimes:** select Pi Coding Agent or Codex App Server globally in Settings, with independent saved defaults and conversation state.
- **Persistent conversations:** each Agent keeps its own conversation across restarts, with automatic context compaction.
- **Text and images:** use an image-capable model for image input; the fixed image tool can return an image attached to the current message.
- **Everyday tools:** save reminders, request daily briefings, export CSV/PDF documents, and analyze table data with local Python statistics and charts.

> The control panel has **no login or access controls**. Anyone who can reach it can manage all local configuration. Keep it on loopback or a trusted private network; do not expose it to the public Internet.

[Requirements](#requirements) · [Installation](#installation) · [First conversation](#first-conversation) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Development](#development)

## How it works

A **Person** identifies a family member by their full Matrix ID, such as `@alice:example.org`. An **Agent** belongs to that Person and uses a different Matrix account, such as `@alice-assistant:example.org`. One Person can have multiple Agents.

```text
Family member's Matrix client
           │ encrypted direct messages
           ▼
Existing Matrix homeserver
           │
           ▼
Family Agents ─── model provider
      ▲
      │ configuration
Private web control panel
```

Only encrypted, invite-only, one-to-one direct messages between an Agent and its owner are accepted. Group chats, outsiders, and self messages do not trigger replies. Existing eligible direct conversations are discovered automatically.

Matrix encryption protects messages in transit between clients. The Agent decrypts accepted messages and sends their content to the configured runtime's model provider for a response. Pi and Codex share a fixed set of application tools with owner and room checks. Neither exposes general shell, filesystem, or network execution. Codex denies native filesystem access and disables extension discovery, while retaining native live web search when supported by the model and account. Its application tools use an authenticated loopback bridge inside the existing Node process; no external tool server or discovery is enabled.

## Requirements

Before installing, prepare:

- An existing Matrix homeserver reachable from the machine running Family Agents. Family Agents does not install or administer a homeserver.
- A Matrix account for each family member, and a separate existing Matrix account and password for each Agent. Create Agent accounts through your homeserver's normal process.
- A Matrix client that supports encrypted direct messages.
- Credentials for a model provider supported by the bundled Pi SDK.

To build from source, install:

| Tool | Requirement |
| --- | --- |
| Node.js | 24 or later, with npm |
| Rust and Cargo | Rust 1.96 or later |
| Native build tools | C/C++ compiler, `pkg-config`, and OpenSSL development files |
| Document and chart tools | Python 3 with `venv`, the pinned Python packages below, and Poppler's `pdftotext` |
| Other tools | Git and `tar` |

On Debian/Ubuntu, install the native build dependencies with:

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config libssl-dev git tar python3 python3-venv poppler-utils
```

Install Node.js and Rust separately at the versions above. The commands below use a Unix shell.

## Installation

Clone the repository, install dependencies, and build both application components:

```sh
git clone https://github.com/minifish-org/family-agents.git
cd family-agents
npm ci
npm run build
npm run gateway:build
```

Run these commands from the repository root. The first Rust build compiles the Matrix SDK and may take some time.

Install the pinned local PDF/chart dependencies into a virtual environment, then start the application with that interpreter:

```sh
python3 -m venv "$HOME/.local/opt/family-agents-python"
"$HOME/.local/opt/family-agents-python/bin/python3" -m pip install -r deploy/python-requirements.txt
export FAMILY_PYTHON_BIN="$HOME/.local/opt/family-agents-python/bin/python3"
npm start
```

The Python worker runs fixed local operations; it does not accept Python programs from chat. CSV export and saved reminder delivery do not require Python. The worker uses the interpreter selected by `FAMILY_PYTHON_BIN`, so keep this setting in your service environment after installation.

Open **http://127.0.0.1:18090** on the same machine. Keep the terminal running; press `Ctrl+C` to stop the application gracefully. Node starts and supervises the Rust Gateway automatically.

To open the panel from another computer without changing its loopback listener, use an SSH tunnel:

```sh
ssh -N -L 18090:127.0.0.1:18090 user@your-server
```

Then open `http://127.0.0.1:18090` on your computer. The server must be running Family Agents, and local port 18090 must be free.

## First conversation

### 1. Configure Matrix and a model provider

1. Open **Settings** and enter your **Matrix Server** URL, for example `https://matrix.example.org`.
2. Open **Configure Providers**. Find your provider and use **Configure Provider** to enter its API-key settings, or **Sign In** where account authorization is supported. Follow any prompts shown.
3. Return to Settings, choose a **Default Model** and a supported **Thinking Level**, then save your settings.

The model list shows available models from configured providers. Model and thinking settings are shared by all Agents; changes take effect between turns. Ordinary provider setup does not require editing JSON. For custom providers or model overrides, expand **Advanced Provider Configuration** in the Providers screen.

### 2. Add a Person and an Agent

1. Return to the home screen, choose **+ Add Person**, and enter the family member's full Matrix ID. Their public display name is fetched when available.
2. With that Person selected, choose **+ Add Agent**.
3. Enter the Agent's dedicated Matrix ID, account password, and display name. Optionally upload an avatar and add instructions, such as “Help me practice English with short, friendly replies.”
4. Choose **Create Agent** and wait for its status to become **Running**. If it shows **Error**, open the Agent to see the message.

The Person and Agent must use different Matrix accounts. Family Agents signs in to the Agent's account; it does not need the Person's password.

### 3. Send a message in Matrix

From the Person's Matrix client, open an encrypted, invite-only direct message with the Agent's Matrix ID and send a message. You can use an existing eligible conversation or create a new direct conversation. Keep the room limited to the owner and Agent, with no other members or pending invitations.

The Agent replies in the same Matrix room. Conversation state is restored after normal restarts. To send images, select a global default model that supports image input.

Open an Agent in the web panel to edit its details or use **Start**, **Stop**, and **Restart**. Leave the password blank while editing to keep the stored password.

### Tools in your Matrix conversation

Ask in ordinary language, for example:

- "Remind me in 20 minutes to take the bread out of the oven."
- "Show my reminders." Then: "Cancel reminder [the ID from the list]."
- "Every day at 08:00 Asia/Singapore, send me a briefing about major technology news."
- "Show my briefing subscriptions." Then: "Cancel briefing [the ID from the list]."
- "Export this household budget as a CSV," or "Make a PDF of this summary."
- "Using this CSV, calculate monthly totals and draw a bar chart."

Both runtimes expose these eight fixed application tools:

| Tools | Purpose |
| --- | --- |
| `reminder_create`, `reminder_list`, `reminder_cancel` | Save, view, and cancel one-time reminders in the current owner conversation. |
| `briefing_subscribe`, `briefing_list`, `briefing_cancel` | Subscribe to, view, and cancel a daily briefing at a local time. |
| `export_file` | Create a CSV table or a PDF containing text and tables. |
| `python_analyze` | Calculate descriptive statistics, grouped sums/means/counts, or correlations; optionally return a bar, line, scatter, or histogram chart as a Matrix image. |

Daily briefings currently require **Codex App Server** with **Codex Native Login** and native live web search. The other application tools work with either runtime, including the new Sign in with ChatGPT connection. A briefing is delivered only after the runtime reports a successful native search with usable results; a model's claim that it checked the news is insufficient. Search failures pause the subscription and report the problem. After restoring search access, cancel and recreate a paused subscription.

Schedules are created only from the owner's explicit request. The confirmation contains the saved ID and resolved local date, time, and timezone. The default timezone is `Asia/Singapore`; ask for an IANA timezone such as `Europe/London` when needed. Reminders can be from one second to 365 days ahead. Briefings run daily at `HH:mm`, follow local daylight-saving changes, and do not offer arbitrary cron expressions. Each Agent can have 20 active schedules, including paused schedules that need attention.

Saved schedules survive restarts and remain bound to the original homeserver, Agent account, owner account, and room. Listing and cancellation use that same scope. Stop pauses delivery; Start resumes due work. Late reminders are marked as late. Briefings skip missed repetitions instead of sending a burst. A briefing interrupted during model execution needs attention and is never automatically run again. Reminder delivery uses the saved text without calling a model and can continue while a model connection has an error, provided the Agent is started and Matrix is connected. A long model reply does not block due reminders.

The Agent shows a typing indicator while processing and sends a progress notice for a slow reply. Send `cancel` or `取消` in the same owner conversation to stop the current reply. Already saved schedules remain saved; cancel a particular schedule by its ID. Failures produce a message in the owner conversation when delivery is available. Completed files and charts arrive as encrypted Matrix attachments after the reply.

Exports and analysis accept at most 2 MiB of structured input, 30 columns, and 5,000 rows; PDF tables are limited to 1,000 rows and PDF text to 48,000 characters. Table cells can contain up to 4,096 characters. Grouped analysis accepts at most 100 groups. Each analysis call can produce one PNG chart; bar charts display the first 100 records while statistics still use all rows, and histograms accept 5–100 bins. Each generated file or chart is limited to 8 MiB; a reply can contain at most four files, with 16 MiB total across files and images. The tools accept data and named operations, never arbitrary code, local paths, shell commands, or URLs to execute.

## Configuration

Set environment variables in the shell or service manager that starts the application:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address for the control panel listener. |
| `PORT` | `18090` | Control panel port. |
| `DATA_DIR` | `data/` | Private data directory, resolved from the working directory. |
| `GATEWAY_BIN` | `gateway/target/release/family-matrix-gateway` | Path to the Rust Gateway executable, relative to the working directory unless absolute. |
| `CODEX_BIN` | `codex` | Optional Codex CLI executable for Codex App Server; install on the same host as the service. |
| `FAMILY_PYTHON_BIN` | `python3` | Python interpreter for fixed PDF rendering, table statistics, and charts; use the virtual environment containing `deploy/python-requirements.txt`. |
| `FAMILY_TIME_ZONE` | `Asia/Singapore` | Default IANA timezone for reminder and daily briefing requests. |
| `PUBLIC_ORIGIN` | Unset | Exact allowed browser origin, such as `https://agents.example.org`, when a reverse proxy changes the request host. This does not add authentication. |

For example, to use a different port and an absolute data directory:

```sh
DATA_DIR=/absolute/path/to/family-agents-data PORT=18091 npm start
```

The application reads environment variables from its process; it does not automatically load a `.env` file. Only one application process may use a data directory at a time.

For continuous operation, use your service manager to run `npm start` from the repository root, with the same service user and persistent data directory on every restart. Keep the panel behind trusted private access. The included [`deploy/family-agents.run`](deploy/family-agents.run) is an example for an existing s6/webtop installation; its paths and user are specific to that deployment. It defaults to `/config/.local/opt/family-agents-python/bin/python3` for the Python environment and `Asia/Singapore` for scheduling.

Changing the Matrix Server setting reinitializes Agent connections, archives previous Matrix stores, and isolates pending work from the old server. Reenter credentials if the new server requires them.

### Agent Runtime

Existing installations continue using **Pi Coding Agent**. Its complete native provider configuration remains available under **Configure Providers**. Select **Codex App Server** in Settings to view its authentication and model configuration, then save to activate it for every Agent. Runtime selection and model fields are global; the Agent form stays unchanged.

Codex requires the official CLI package, including its matching `codex-code-mode-host` companion (protocol types currently generated with `codex-cli 0.166.0`). Responses Lite models use that isolated host to invoke native tools; local shell and browser tools remain disabled. Choose **Sign in with ChatGPT (New)**, **Codex Native Login**, or **API Key**. Each connection is saved separately; **Use Connection** explicitly activates a saved connection. Native ChatGPT OAuth and token refresh remain owned by Codex. ChatGPT plan authorization and credentials are kept separately under `DATA_DIR/codex/siwc`; none of these connections reuse desktop credentials or Pi's credential store. Model discovery lists the runtime's catalog and reasoning efforts; catalog presence alone does not guarantee account access to a model.

For the new ChatGPT sign-in, open the authorization link and approve access to your ChatGPT plan. If your browser is on another machine, its final `http://127.0.0.1:.../auth/callback` page may not load. Copy the entire address from the browser and paste it into **Final Browser URL**, then choose **Complete Sign In**. Keep the code and URL private. The app checks the authorization state, PKCE exchange, ID-token signature/identity/nonce, and granted plan-use scopes before replacing a working connection. Saved account registrations retain their own client IDs for future sign-in. A native Codex login does not authorize the new flow. For **Codex Native Login**, use **Sign In with Device Code** when your browser is on another machine, or the native browser flow when its loopback callback can reach the service. Existing native credentials can be selected with **Use Connection** without replacing the new connection. Sign-out clears only the active connection; other saved connections remain available.

Requests authorized through the new flow are sent through the documented Responses provider using a token in the child process environment. Tokens refresh before expiry; new turns wait while existing turns finish, then the App Server restarts with the refreshed token and resumes persistent threads. Signing out of the new flow clears its local tokens and attempts remote session revocation. Review usage and app access in [ChatGPT usage settings](https://chatgpt.com/settings/usage). Follow current OpenAI account and application eligibility requirements.

Switching validates installation, authentication, and model selection first. New Matrix messages remain in the durable inbox while active replies finish; turns exceeding the transition wait are safely cancelled without automatic replay. The target's per-Agent sessions are prepared before committing the selection. Failures retain or restore the previous runtime. Runtime switching preserves Matrix connections and E2EE stores. Switching back resumes each runtime's own conversation; histories are not converted or merged.

Codex uses one shared App Server process with independent persistent threads and developer instructions per Agent. It accepts text and images and returns final assistant text, source links, and attached images through the existing Matrix delivery path. Internal reasoning and tool diagnostics are not sent to Matrix. Unsupported approvals are declined and the limitation is reported. Native web search uses live mode, subject to runtime/model/account support; there is no additional search service. See the [official App Server protocol](https://learn.chatgpt.com/docs/app-server).

Native web search is a separate capability from model inference. The SIWC provider declares standalone search support, but the observed ChatGPT plan grant on 5 November 2026 was denied by `/v1/alpha/search` with HTTP 401, `hardened_oauth_rule_missing`. ChatGPT sign-in and ordinary conversation work with that grant; live news search remains unavailable until the provider authorizes that operation. Reconnecting or widening the local sandbox does not grant access to the search endpoint. The existing native ChatGPT connection was separately verified against its native search endpoint and returned HTTP 200 with search results. Choose **Codex Native Login**, then **Use Connection**, to use that connection. The app never automatically changes authentication after a search failure. Switching between the new and native providers continues from a native fork of the saved history, preserving the original thread without replaying previous messages. Account-specific search access can change.

The current Codex model can use local JavaScript calculations, data transformations, the native clock, and timezone conversion without web-search permission. Native web tools also cover public webpage reading, PDF screenshots, image search, weather, market quotes, and sports where the selected model/account authorizes that endpoint. The new Sign in with ChatGPT flow supports function/custom tools; the observed search denial is not a general tool ban. Its current public route does not support hosted image generation, file search, or Code Interpreter. See [OpenAI preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

Send an encrypted Matrix attachment to ask either runtime to summarize or analyze text/code, CSV/TSV, PDF, Word (`.docx`), or Excel (`.xlsx`). Each document is limited to 8 MiB. The application extracts text locally before supplying it to the model, without executing document scripts or spreadsheet macros. Long input is explicitly shortened to fit 48,000 characters, including the accompanying request. PDFs need selectable text; scanned pages can instead be sent as images to a model that accepts them. Python 3 and `pdftotext` (Poppler) must be installed on the service host for Office and PDF extraction.

Codex image generation is enabled for native/API-key connections when the model and account support it, and disabled for the new sign-in route. Ask for a new image or edits to images already in this conversation. Completed images return as encrypted Matrix images after the turn completes, with at most four generated images and 8 MiB total per reply. The named `family_agent` permission profile denies native local-file access; generation can use conversation images, while arbitrary local image paths are rejected. Shell, browser automation, and automatic MCP/extension discovery remain disabled.

Source links in assistant text are preserved. Codex is instructed to provide source names and plain HTTPS URLs because Matrix messages are plain text and cannot resolve opaque native citation markers or reliably render Markdown links.

## Data and backups

By default, private data lives in `data/`, which is excluded from Git. The application creates private directories with mode `0700` and private files with mode `0600`.

| Location inside `DATA_DIR` | Contents |
| --- | --- |
| `application.sqlite` | People, Agent metadata, shared settings, encrypted Matrix passwords, durable inbox/outbox, saved schedules, and schedule execution records. |
| `credentials.key` | Key needed to decrypt stored Matrix passwords. |
| `pi/models.json`, `pi/auth.json` | Pi provider configuration and authentication. |
| `agents/<id>/sessions/` | Each Agent's persistent conversation. |
| `codex/home/` | Codex-native credentials and persistent conversation state. |
| `codex/siwc/` | Sign in with ChatGPT registrations, stable host ID, and private renewable credentials. |
| `codex/agents/<id>/` | Private per-Agent working directories and atomic Codex thread mappings. |
| `matrix/<id>/` | Matrix device session, encryption keys, sync state, and pending events. |
| `matrix-archives/` | Matrix stores archived after identity/server changes or recovery. |

**Stop the application and back up the entire data directory together.** Restore it with its ownership and private permissions intact. A database without its credential key, Pi files, and Matrix stores is not a complete backup. Treat backups as secrets: they contain credentials, conversation content, and encryption keys.

Normal restarts preserve Matrix devices and conversation state. Do not delete Matrix stores to troubleshoot a login error. An account with an existing signing identity needs its original signing secrets to verify a replacement device; a password alone is insufficient. Family Agents preserves native signing secrets separately and does not replace an unknown account identity.

Interrupted model executions are not replayed automatically; send a fresh message to continue. Completed replies awaiting delivery are retried without rerunning the model, after rechecking room membership.

`ScheduleStore` commits reminder completion and its outbound message together, then retries delivery with the same Matrix transaction ID. An interrupted reminder can safely resume after restart. Interrupted briefing inference is marked as needing attention, because the application cannot assume whether that model execution completed. Schedule routing is checked again before delivery; jobs and queued messages from an earlier identity are never sent under a replacement account or homeserver.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Application fails to start or the Gateway is unavailable | Run from the repository root, run `npm run gateway:build`, and check `GATEWAY_BIN` if overridden. Read the terminal output for the startup error. |
| Matrix Server cannot be saved | Use the homeserver's HTTP(S) base URL, not its web client URL. Check that the application can reach `/_matrix/client/versions` on that server. |
| No models are available | Configure a provider first, return to Settings, and select an available model. An unavailable saved model is kept visible as an explanatory message. |
| Agent shows Error | Open its details and check the reported error, Matrix account credentials, and provider configuration. Correct the problem before restarting it. |
| Agent does not reply | Check that it is Running, the sender matches its owner's full Matrix ID, and the room is encrypted, invite-only, and a direct conversation containing only those two accounts, with no third-party invitations. |
| Images fail | Select a model with image input support. The Agent's image tool can only return an image from the current incoming message. |
| A reminder is late or not arriving | Start the Agent, check its Matrix connection and original owner-only room, then ask to list reminders. Model authentication is not needed to deliver a saved reminder. |
| A daily briefing is rejected or paused | Select Codex Native Login with working live search. Ask to list subscriptions; cancel and recreate a paused one after fixing access. |
| PDF export or charts fail | Install `deploy/python-requirements.txt` in the interpreter selected by `FAMILY_PYTHON_BIN`; check the input and attachment limits above. |
| Changes are rejected as stale | Another browser changed the record. Load the latest version, review your edits, and save again. |

Check service readiness with:

```sh
curl --fail http://127.0.0.1:18090/api/health
```

The endpoint returns core readiness and individual Agent statuses. A ready Gateway does not mean every Agent or model provider is configured successfully.

## Development

The application has two components:

- **Node.js/TypeScript:** Hono API, React UI, SQLite metadata, the thin Agent Runtime boundary, embedded Pi SDK, and supervision of Codex App Server and the Gateway.
- **Rust Gateway:** the official `matrix-rust-sdk` handles Agent authentication, sync, encryption, profiles, and media. Communication with Node uses versioned JSONL; see [`gateway/PROTOCOL.md`](gateway/PROTOCOL.md).

To work on the application after `npm ci` and `npm run gateway:build`, start the backend in one terminal:

```sh
npm run dev
```

Start the frontend in another terminal, also from the repository root:

```sh
npx vite --host 127.0.0.1
```

Open the URL printed by Vite. It forwards `/api` to the backend at `127.0.0.1:18090`. Rebuild the Gateway after changing Rust code. Use a separate `DATA_DIR` for development so it does not share a production instance's data.

Run the automated checks with:

```sh
npm run check
npm test
npm run build
cargo test --locked --manifest-path gateway/Cargo.toml
cargo clippy --locked --manifest-path gateway/Cargo.toml --all-targets -- -D warnings
cargo fmt --check --manifest-path gateway/Cargo.toml
```

Tests cover storage, credential handling, owner-only routing, lifecycle operations, persistent Pi sessions, and Gateway policies. Read [`AGENTS.md`](AGENTS.md) before changing architecture or routing, and [`VALIDATION.md`](VALIDATION.md) for deployment acceptance results and remaining limitations.

Regenerate version-matched Codex protocol types with `npm run codex:generate` after installing the target CLI version. Integration tests exercise a fake stdio server without model credentials. Native startup, authentication, live model inference, image understanding, and live search depend on the service host's CLI, credentials, and model access; do not claim those live checks passed without running them.

The optional live driver, `scripts/live-e2e.mjs`, needs dedicated test accounts and private external credentials. It changes settings, restarts the application, and deliberately corrupts a temporary test Agent's crypto store. Follow `VALIDATION.md`; it is not part of ordinary installation or automated tests.

### Existing deployment reference

<details>
<summary>s6/webtop operations for the existing installation</summary>

The existing installation uses `/config/work/pith-post` inside `webtop-desktop`, backed by `/srv/webtop/config/work/pith-post` on the host. It runs as `abc`. The launcher is installed root-owned at `/srv/webtop/custom-services/family-agents`; s6 supervises Node, and Node supervises the Rust Gateway. Before enabling PDF exports and charts, create `/config/.local/opt/family-agents-python` as a Python virtual environment owned by the service user and install the pinned `deploy/python-requirements.txt` into it. Keep that environment outside the source checkout, preserve it across restarts, and use its interpreter through `FAMILY_PYTHON_BIN`. This adds local libraries, not another service.

From the host, restart with:

```sh
sudo docker exec webtop-desktop /command/s6-svc -r /run/service/family-agents
```

After container recreation, the generated service is named `custom-svc-family-agents`; use `/run/service/custom-svc-family-agents` instead. Stop the service with `s6-svc -d` before rebuilding running executables, and start it with `s6-svc -u` afterward. Verify `/api/health`, the Node/Gateway process identities, private-network access, and a real encrypted owner DM. The external Tuwunel homeserver and unrelated services must remain running.

The pre-rewrite checkpoint is `checkpoint/pre-v2-20261104`. Its operator recovery snapshot is outside this checkout and is not needed for installation.

</details>

## License

Family Agents is licensed under the [GNU Affero General Public License v3.0](LICENSE). The production build includes a corresponding-source archive at `/source.tar.gz`, linked as **Source Code** in the UI footer. The archive uses an explicit source allowlist and excludes private runtime data.
