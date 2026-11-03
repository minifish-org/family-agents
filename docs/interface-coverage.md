# Product interface

The product contains exactly:

1. One Matrix server.
2. People, identified by their Matrix ID, with display names and avatars read automatically from Matrix.
3. Each person's agents.
4. Agent Persona editing plus display-name and image editing, synchronized to the real Matrix profile.

The UI is blue and white, including when the OS prefers dark mode. The only navigation items are People and Settings. Add people by Matrix ID, click their names for read-only details, and edit agents in dialogs under their person. There is no separate agent list, wizard, activity tab, chat launcher, per-agent model selector, advanced model parameters, or infrastructure dashboard. Settings contains shared provider/model/thinking selection from Pith; API keys are write-only and saved providers can be selected again. Settings contains the shared Matrix server and Sign out. The homeserver can change only when both people and agents are empty; changed addresses are checked before saving, and saved connections can be checked at any time; there are no per-agent overrides. Bot account credentials are entered once at creation. An agent's existing AI prompt/model/history remain intact when changing its appearance. Persona edits update only its system prompt from the next turn; its model, Matrix identity and history remain intact.

Image uploads are authenticated, limited to 2 MiB and 4096 × 4096 source pixels, center-cropped/resized into a metadata-free 256 × 256 PNG, and saved privately. Matrix synchronization uses the original account token/device and reports pending/failure states. Avatar removal clears the actual Matrix profile when explicitly requested.

Administrator provisioning, backups, password recovery, raw data/schema/API settings, and other maintenance are operator work. The underlying authenticated maintenance APIs and PocketBase `/_/` remain separate from the product UI.
