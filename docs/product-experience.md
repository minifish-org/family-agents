# Pith Post product experience

Pith Post connects people with their personal agents through encrypted Matrix DMs. The embedded application at `/` and `/post/` manages configuration; conversations happen in the person's existing Matrix client.

## Product objects

- One Matrix server, shared by everyone.
- People, configured with only their full Matrix ID. Names and avatars follow their Matrix profiles automatically.
- Each person's agents, with a display name, avatar and dedicated Matrix account. Ownership and server are inherited when adding an agent.

## Interface

The blue-and-white interface has only **People** and **Settings** navigation. Its browser icon matches the blue `p` brand mark.

People is the home page. Each person's card shows their name, avatar and agents. Click their name for read-only identity details or removal. Click an agent to edit its display name and image. Do not repeat an ID when it is already the fallback name. Do not add manual person-name or avatar configuration.

Settings contains the one Matrix server and Sign out. Check connection tests the saved address. Editing the address replaces that action with Save server, which checks the new connection before saving. All people and agent configurations must be removed before switching servers; the backend enforces the same requirement.

Agent account credentials are entered once at creation. Failed image uploads can be retried without entering credentials again or creating another agent. Image-only changes skip unchanged name writes, and independent model/runtime edits do not invalidate appearance edits. Connection and profile retries retain unsaved appearance changes. Unchanged forms do not require saving or trigger an unnecessary leave-page warning.

Show only the relevant connection or recovery action. Do not offer Connect while already connecting. Interrupted-reply review remains accessible when an agent is off. Explicitly removing an agent stops its worker and removes its configuration while retaining its Matrix account, crypto identity, history and unfinished-task archives; archived work is not replayed or sent.

## Boundaries

There is no dashboard, setup wizard, chat launcher, activity tab, model selector, password-maintenance page or backup page. Operator provisioning, model/runtime configuration, full-directory backups and recovery remain documented operator procedures. PocketBase administration at `/_/` is separate from the product interface.

Profile updates preserve the existing bot/device, crypto keys, conversations, model and instructions. Owner-only encrypted chat validation, delivery safeguards and explicit interrupted-run review remain in force. Person profiles are read-only, and failed lookups retain the last cached name/image.

See [setup](setup.md), [operations](operations.md) and [testing](testing.md) for current behavior and validation procedures.
