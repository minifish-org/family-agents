# Family Agents

Self-hosted AI assistants for your family, available through your existing Matrix clients.

Family Agents gives each family member their own AI assistants, each with a dedicated Matrix account, name, avatar, and instructions. Use the web control panel to configure them, then chat in encrypted direct messages from your usual Matrix client.

- **Personal assistants:** each Agent belongs to one Person and responds only to that owner's verified direct messages.
- **Familiar chat:** conversations happen in Matrix; the web panel manages People, Agents, and shared settings.
- **Your choice of model:** configure providers through the Pi SDK, including API keys and supported account sign-in flows.
- **Persistent conversations:** each Agent keeps its own conversation across restarts, with automatic context compaction.
- **Text and images:** use an image-capable model for image input; the fixed image tool can return an image attached to the current message.

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

Matrix encryption protects messages in transit between clients. The Agent decrypts accepted messages and sends their content to the configured model provider for a response. Agents have no shell, filesystem, MCP, or arbitrary network tools.

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
| Other tools | Git and `tar` |

On Debian/Ubuntu, install the native build dependencies with:

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config libssl-dev git tar
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
npm start
```

Run these commands from the repository root. The first Rust build compiles the Matrix SDK and may take some time.

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

## Configuration

Set environment variables in the shell or service manager that starts the application:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address for the control panel listener. |
| `PORT` | `18090` | Control panel port. |
| `DATA_DIR` | `data/` | Private data directory, resolved from the working directory. |
| `GATEWAY_BIN` | `gateway/target/release/family-matrix-gateway` | Path to the Rust Gateway executable, relative to the working directory unless absolute. |
| `PUBLIC_ORIGIN` | Unset | Exact allowed browser origin, such as `https://agents.example.org`, when a reverse proxy changes the request host. This does not add authentication. |

For example, to use a different port and an absolute data directory:

```sh
DATA_DIR=/absolute/path/to/family-agents-data PORT=18091 npm start
```

The application reads environment variables from its process; it does not automatically load a `.env` file. Only one application process may use a data directory at a time.

For continuous operation, use your service manager to run `npm start` from the repository root, with the same service user and persistent data directory on every restart. Keep the panel behind trusted private access. The included [`deploy/family-agents.run`](deploy/family-agents.run) is an example for an existing s6/webtop installation; its paths and user are specific to that deployment.

Changing the Matrix Server setting reinitializes Agent connections, archives previous Matrix stores, and isolates pending work from the old server. Reenter credentials if the new server requires them.

## Data and backups

By default, private data lives in `data/`, which is excluded from Git. The application creates private directories with mode `0700` and private files with mode `0600`.

| Location inside `DATA_DIR` | Contents |
| --- | --- |
| `application.sqlite` | People, Agent metadata, shared settings, encrypted Matrix passwords, and pending messages. |
| `credentials.key` | Key needed to decrypt stored Matrix passwords. |
| `pi/models.json`, `pi/auth.json` | Pi provider configuration and authentication. |
| `agents/<id>/sessions/` | Each Agent's persistent conversation. |
| `matrix/<id>/` | Matrix device session, encryption keys, sync state, and pending events. |
| `matrix-archives/` | Matrix stores archived after identity/server changes or recovery. |

**Stop the application and back up the entire data directory together.** Restore it with its ownership and private permissions intact. A database without its credential key, Pi files, and Matrix stores is not a complete backup. Treat backups as secrets: they contain credentials, conversation content, and encryption keys.

Normal restarts preserve Matrix devices and conversation state. Do not delete Matrix stores to troubleshoot a login error. An account with an existing signing identity needs its original signing secrets to verify a replacement device; a password alone is insufficient. Family Agents preserves native signing secrets separately and does not replace an unknown account identity.

Interrupted model executions are not replayed automatically; send a fresh message to continue. Completed replies awaiting delivery are retried without rerunning the model, after rechecking room membership.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Application fails to start or the Gateway is unavailable | Run from the repository root, run `npm run gateway:build`, and check `GATEWAY_BIN` if overridden. Read the terminal output for the startup error. |
| Matrix Server cannot be saved | Use the homeserver's HTTP(S) base URL, not its web client URL. Check that the application can reach `/_matrix/client/versions` on that server. |
| No models are available | Configure a provider first, return to Settings, and select an available model. An unavailable saved model is kept visible as an explanatory message. |
| Agent shows Error | Open its details and check the reported error, Matrix account credentials, and provider configuration. Correct the problem before restarting it. |
| Agent does not reply | Check that it is Running, the sender matches its owner's full Matrix ID, and the room is encrypted, invite-only, and a direct conversation containing only those two accounts, with no third-party invitations. |
| Images fail | Select a model with image input support. The Agent's image tool can only return an image from the current incoming message. |
| Changes are rejected as stale | Another browser changed the record. Load the latest version, review your edits, and save again. |

Check service readiness with:

```sh
curl --fail http://127.0.0.1:18090/api/health
```

The endpoint returns core readiness and individual Agent statuses. A ready Gateway does not mean every Agent or model provider is configured successfully.

## Development

The application has two components:

- **Node.js/TypeScript:** Hono API, React UI, SQLite metadata, the official Pi SDK, and supervision of the Gateway.
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

The optional live driver, `scripts/live-e2e.mjs`, needs dedicated test accounts and private external credentials. It changes settings, restarts the application, and deliberately corrupts a temporary test Agent's crypto store. Follow `VALIDATION.md`; it is not part of ordinary installation or automated tests.

### Existing deployment reference

<details>
<summary>s6/webtop operations for the existing installation</summary>

The existing installation uses `/config/work/pith-post` inside `webtop-desktop`, backed by `/srv/webtop/config/work/pith-post` on the host. It runs as `abc`. The launcher is installed root-owned at `/srv/webtop/custom-services/family-agents`; s6 supervises Node, and Node supervises the Rust Gateway.

From the host, restart with:

```sh
sudo docker exec webtop-desktop /command/s6-svc -r /run/service/family-agents
```

After container recreation, the generated service is named `custom-svc-family-agents`; use `/run/service/custom-svc-family-agents` instead. Stop the service with `s6-svc -d` before rebuilding running executables, and start it with `s6-svc -u` afterward. Verify `/api/health`, the Node/Gateway process identities, private-network access, and a real encrypted owner DM. The external Tuwunel homeserver and unrelated services must remain running.

The pre-rewrite checkpoint is `checkpoint/pre-v2-20261104`. Its operator recovery snapshot is outside this checkout and is not needed for installation.

</details>

## License

Family Agents is licensed under the [GNU Affero General Public License v3.0](LICENSE). The production build includes a corresponding-source archive at `/source.tar.gz`, linked as **Source Code** in the UI footer. The archive uses an explicit source allowlist and excludes private runtime data.
