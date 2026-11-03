# Verification guide

## Repeatable offline checks

From the repository root, with Go 1.27+ and Make:

    make build
    make test
    make vet
    make race
    make smoke

`make race` additionally needs a C compiler. `make smoke` uses Python 3's standard library, starts the actual binary twice on a disposable loopback port, generates synthetic credentials in memory, uses a temporary data directory, and removes it afterward. No Matrix or paid model credentials are needed. It tests bootstrap, embedded UI, CRUD, admin authorization, credential non-disclosure/persistence, restart, and the data-directory lock.

The binary build explicitly uses `CGO_ENABLED=0` with `-tags goolm`. The Matrix database is explicitly opened through modernc SQLite; cryptohelper's CGO-only filename shorthand is not used. To check that path independently:

    CGO_ENABLED=0 go test -tags goolm ./...

Useful focused tests:

    go test -tags goolm ./internal/agent -run 'TestServiceRestart|TestTwoAgents|TestMembership|TestUnauthorized|TestLostAcknowledgement'
    go test -tags goolm ./internal/matrix -run 'TestMautrix|TestRealMegolm|TestInbound'
    go test -tags goolm ./internal/pith -run 'TestRealSDK|TestModelRequestedShell'
    go test -tags goolm ./internal/admin ./internal/store

### Actual browser workflow

Start `python3 scripts/ui-fixture.py bin/pith-post` and feed its single JSON output line to `node scripts/browser-smoke.cjs`. The fixture includes synthetic login credentials and PNG images; it provisions a synthetic runtime model outside the product UI. Set `PLAYWRIGHT_MODULE` when the Playwright module is outside normal lookup paths. The browser and fixture must share loopback networking. Terminate the fixture with SIGTERM afterward.

The test refuses non-loopback targets and non-fixture accounts. It exercises one-server setup, people and their nested agents, name edits, actual avatar uploads/normalization/persistence/removal, failed-upload retry, cancellation, owner isolation, deletion, cookie login/refresh/logout, blue-white styling under dark OS preference, and desktop/mobile overflow. It calls the real disposable HTTP backend and never sends to a live Matrix account. Real Matrix profile API behavior, identity preservation and provider-failure retry are additionally covered by `internal/matrix/profile_test.go` against an HTTP server double.

### Coverage map

| Acceptance area | Offline evidence |
| --- | --- |
| First owner conversation and process-manager recreation | Real Pith SDK, persistent JSONL, local OpenAI-compatible streaming HTTP double; duplicate event after restart does not regenerate |
| Two agents / isolation / prompt changes | Separate paths, prompts, histories and crypto-store names; restarting one leaves the other available |
| Owner-only authorization | Real adapter rejects plaintext, unknown/forwarded keys, non-owner/bot events, wrong rooms and edits; worker tests reject unsafe membership before model invocation |
| Membership change during a task | Hold model execution, introduce a third-party invitation, release result; persisted result cannot send until explicit safe Resume |
| Proactive image / retry | Proactive model output enters durable outbox; lost acknowledgement reuses identical payload/transaction, including after service-manager recreation |
| Actual encryption | Real mautrix Megolm round trip and Matrix v2 image attachment encryption against a local HTTP server double; upload is not plaintext |
| Inbound encryption and durable admission | Real owner Megolm event/device key and HTTP sync loop; failed admission retains ciphertext and the old cursor; success advances the cursor only after admission |
| Device continuity | Real SQLite crypto store reopened; same identity/signing keys and no second login; undecryptable event preserves identity |
| Reset / interruptions | Running rows become interrupted; review required; reset requires permission, confirmed impossible recovery, classified crypto failure, and unused loop guard |
| Secrets / admin UI | AES-GCM round trip and wrong-key/cross-agent rejection; every custom operation denies guests and non-superusers; configured secrets absent from responses |
| Tools disabled | Real SDK request contains no tools; model-requested bash cannot create a file; parent instruction files are not discovered |

The Matrix server double is not Tuwunel. Its idempotency handling proves the client reuses transaction IDs; it does not certify a particular live homeserver version. The fake HTTP model is not a live provider. Do not describe these tests as a live Element deployment test.

## Shortest live Tuwunel validation

Use disposable dedicated bot accounts and an existing test owner in Element. Do not inspect or export other people's rooms or credentials. Keep tokens, passwords, recovery material, and captured HTTP bodies out of Git and logs.

1. **One agent:** follow [setup](setup.md), start the bot, accept its invitation in Element, and Resume. Confirm the room has exactly owner + bot and `m.room.encryption.algorithm = m.megolm.v1.aes-sha2`. Send “Remember that my bicycle is blue.” Check an encrypted reply and one completed run in History.
2. **Restart:** note device/room/conversation numbers; restart the process with the same data directory/key, then start the agent (or use `auto_start`). Ask “What color is my bicycle?” Confirm the remembered answer, unchanged device/room, and no new login/device in Tuwunel/Element.
3. **Second agent:** use the same owner relation, another bot account, and a different distinctive prompt. Repeat a different memory. Restart only the first agent while messaging the second. Confirm independent answers and separate conversation/crypto paths.
4. **Unauthorized input and membership:** invite a bot into a different DM/group and mention it there. Send a plaintext custom event in the bound test room. Confirm no additional run/model call. With a delayed model response in progress, have the owner leave; confirm the result remains pending and unsent. Rejoin and explicitly Resume after review. Newly created rooms intentionally forbid owner-issued third-party invites; use the offline tests or a disposable administrator-controlled room to test an actual third-party join/invite, not a production family room.
5. **Proactive encrypted image:** without sending a new owner DM, use Proactive task and ask Pith to return exactly the following content envelope. Confirm an image appears in Element. The underlying message event must be `m.room.encrypted`; the decrypted content must have `file`, not an unencrypted `url`. Downloading the MXC bytes directly should yield encrypted bytes, not the PNG.

       {"pith_post":[{"kind":"image","name":"pixel.png","mime":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6sAAAAASUVORK5CYII="}]}

6. **Lost acknowledgement:** on a disposable test proxy used only by this bot, forward one encrypted `/rooms/.../send/m.room.encrypted/{txn}` request upstream but return 502 downstream. Let Pith Post retry. Confirm the same transaction ID and exactly one visible event. Do not enable proxy body/header logging. Also submit a proactive API request twice with the same `key` and confirm one model run.
7. **Decryption failure:** send one deliberately malformed encrypted event using test-client tooling, then a valid encrypted owner message. Confirm no identity reset or plaintext reply, unchanged device/signing keys, and successful handling of the valid message. Test restore/reset only after an offline backup, on disposable accounts.

Record the Tuwunel/Element/model versions and pass/fail results in your private deployment notes, without secrets. Cross-signing UX, live token replacement, TLS/proxy behavior, and whole-directory backup restore still need that deployment-specific validation.

## Delivery verification record

Verified in the implementation environment (Linux amd64, Go 1.27.2): build, ordinary tests, CGO-free tests, race-detector tests, vet, and the disposable binary smoke test. A source-only staged checkout is also built/tested/smoke-tested before delivery. The redesigned UI additionally passed the disposable Chromium workflow above. These tests do not certify a live message exchange; the live checklist above remains separate.
