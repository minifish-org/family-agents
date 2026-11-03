# Setup

Pith Post manages one Matrix server, people, and their agents. Conversations happen in a Matrix client.

## Operator preparation

Build the single binary, preserve its external master key, and provision an administrator as described in README. In **Settings → Model**, choose a provider, enter its API key, choose a model from the Pith catalog and select a supported thinking strength. This single selection applies to all agents from their next reply. Previously configured services and keys remain available; compatible custom services also show their service address. There are no per-agent model choices or advanced model controls.

Create dedicated Matrix accounts on the one homeserver before adding agents. Never share a person's own login or a bot account between services. Run only one Pith Post instance against a given data directory and set of bot identities.

## Product setup

1. Sign in and configure the one **Matrix server** in **Settings**. An existing deployment's common server is reused automatically. Check connection tests the saved server’s public Matrix client endpoint without changing settings. When the address is edited, Save server replaces this action and checks before saving. Sign out also lives in Settings. Saving a changed address also checks it first; a failed check preserves the previous address. Remove all agents and people before changing the server; there are no per-agent server overrides.
2. On **People**, add the person's full Matrix ID. The display name and avatar are read from Matrix automatically.
3. Under that person, choose **+ Agent**. Enter its display name, choose an optional image, optionally set its **Persona** (role, tone and instructions), and provide the dedicated Matrix account and password. The person and server are inherited.
4. The account connects in the background. Accept its invitation in the person's Matrix client or invite the agent to an encrypted two-person DM.

Click an agent to change its display name, image or **Persona**. The existing persona is shown in full. Leave it blank to use the standard helpful-assistant default. Persona edits apply from the next reply without restarting the agent or clearing conversation history. These changes are saved locally and synchronized to its real Matrix profile using the original device/token. Uploads support PNG, JPEG, GIF and WebP up to 2 MiB and 4096 × 4096 source pixels. Images become a centered 256 × 256 PNG with source metadata removed. The UI reports pending or failed Matrix updates and allows retrying. Cancel closes without saving.

To connect an existing assistant, reuse its original account and data. A profile edit never changes its model, instructions, conversation, device, room, credentials, or crypto store. Removing an agent requires one confirmation, stops its worker, and retains its Matrix account and private archives, including unfinished tasks that will no longer run. It is not secure data erasure.

## Private DM connection

The configured person can invite the bot to a private DM. Only owner-initiated, verified two-person rooms qualify; pending work retains its original destination. Encryption is enabled before content is processed or sent. If the bot lacks permission to enable it, the room creator must enable encryption. Resend an initial plaintext message after encryption is active. Groups and strangers are excluded.

First initialization, backup and forgotten-password recovery are operator tasks. The advanced PocketBase UI remains available at `/_/`; ordinary product configuration uses the People/Settings interface.

People have no manually maintained name in Pith Post. Names and avatars are refreshed from the configured Matrix server with a short cache. Images appear next to the person in their card, details and agent owner summary; no separate image configuration is needed. A failed image fetch keeps the last cached image; removing an avatar in Matrix clears it locally. People without an image use an initial. A failed lookup preserves the last known name; accounts without a display name use their Matrix ID. Click a person’s name to view their Matrix ID or remove the person after their agents are removed. There is no separate name-edit or manual-refresh step. This is read-only and never changes the person’s Matrix profile or agent ownership.
