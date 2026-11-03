# Pith Post

Private family AI agents, reached through encrypted Matrix DMs in Element.

One **pith-post** binary embeds PocketBase, the [Pith Go coding-agent SDK](https://github.com/minifish-org/pith), mautrix-go, and a small administration UI. Your existing Tuwunel homeserver and model service remain independent.

**Repository language:** all repository-authored code and documentation is English. Owners can use prompts and chat in any language. Read [AGENTS.md](AGENTS.md) before changing the project.

## What is implemented

- Multiple agents per full-MXID owner; separate bot devices, workspaces, persistent Pith conversations, and crypto databases.
- Encrypted owner-only DM creation, authenticated/decrypted inbound text, durable event deduplication, serial per-agent execution, and concurrent agents.
- Encrypted text/image/file delivery, including administrator-triggered proactive tasks; durable replies and stable retry transaction IDs.
- A minimal blue-and-white administration UI: one Matrix server, people, and their nested agents.
- People display the name and avatar from their existing Matrix profile automatically.
- Agent display names and uploaded avatar images synchronize to the real Matrix profile with the original account identity.
- Revocable administrator browser sessions, CSRF protection, and persistent availability.
- Separate restart, new-conversation, and one-shot identity-reset operations. Unsafe membership pauses delivery until administrator review and resume.

This is a **chat-only first implementation**, not an OS sandbox or general-purpose autonomous coding service. Tools are explicitly disabled. Proactive attachment bytes must be supplied by Pith's content envelope; the service does not fetch model-generated URLs or read model-generated file paths.

## Build and run

Requirements: **Linux/Unix, Go 1.27 or newer, Make**. Tests need no live credentials. The pure-Go build requires neither libolm nor a C compiler. A C compiler is needed only for race-detector tests. No Node/TypeScript build is needed: the small UI is authored as static HTML/CSS/JavaScript and embedded at Go build time.

Use these commands from the repository root:

	make build
	make test
	make vet

Create the master key **once**, outside the checkout, and preserve it for every restart and backup restore:

	test -d "$HOME/.config/pith-post" || install -d -m 700 "$HOME/.config/pith-post"
	test -f "$HOME/.config/pith-post/master.key" || (umask 077; openssl rand -base64 32 > "$HOME/.config/pith-post/master.key")
	export PITH_POST_MASTER_KEY="$(cat "$HOME/.config/pith-post/master.key")"

Create a PocketBase superuser while the service is stopped. In Bash, avoid storing the password in shell history:

	read -r -s -p "Administrator password: " ADMIN_PASSWORD; echo
	./bin/pith-post superuser create admin@example.org "$ADMIN_PASSWORD" --dir=./data
	unset ADMIN_PASSWORD
	./bin/pith-post serve --http=127.0.0.1:8090 --dir=./data

The CLI password is briefly visible in process arguments; run provisioning on a trusted host. The application deliberately does not print PocketBase installer tokens.

- Pith Post: **http://127.0.0.1:8090/** (also available at `/post/`)
- Advanced PocketBase administration: **http://127.0.0.1:8090/_/**
- Health: **http://127.0.0.1:8090/api/health**

Follow [setup](docs/setup.md) to add a person and configure their agent, accept its encrypted invitation, and continue the conversation after a restart. Never expose the dashboard without TLS and appropriate network restrictions.

## Verification and operations

- [Architecture and security boundaries](docs/architecture.md)
- [Recovery and administrative API](docs/operations.md)
- [Repeatable tests and shortest live Tuwunel validation](docs/testing.md)
- [Example configuration](examples/configuration.json)
- [Example systemd service](deploy/pith-post.service)

Offline tests exercise the real Pith SDK, a local model HTTP double, real Olm/Megolm and attachment encryption, a Matrix HTTP double, restart/deduplication paths, and API authorization. The live deployment has also been checked over Tailscale HTTPS for administrator login, Matrix profile reads, unchanged bot/device identity and encrypted reply delivery. The full deployment-specific checklist in [testing](docs/testing.md) remains separate from automated test coverage.

Back up the stopped service's entire data directory and keep the master key separately. Histories and prompts are private local data, not encrypted-at-rest by this application; use encrypted disks/backups. Run only one process per data directory. PocketBase schema administration and host access are trusted roles.

## License

[GNU AGPL v3](LICENSE). No warranty. Operators must offer the corresponding source of the deployed version to remote users; update the UI source link if deploying a fork.
