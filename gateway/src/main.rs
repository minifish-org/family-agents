#![recursion_limit = "512"]
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use matrix_sdk::{
    Client, Room, RoomMemberships, RoomState,
    authentication::matrix::MatrixSession,
    config::{RequestConfig, SyncSettings, SyncToken},
    deserialized_responses::EncryptionInfo,
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    ruma::{
        OwnedRoomId, OwnedTransactionId, OwnedUserId,
        api::client::{
            config::{get_global_account_data, set_global_account_data},
            keys::get_keys,
            membership::get_member_events,
            profile::set_avatar_url,
            state::get_state_event_for_key,
        },
        events::{
            GlobalAccountDataEventType, StateEventType,
            room::{
                ImageInfo, MediaSource,
                member::StrippedRoomMemberEvent,
                message::{
                    ImageMessageEventContent, MessageType, OriginalSyncRoomMessageEvent,
                    RoomMessageEventContent,
                },
            },
        },
    },
    store::RoomLoadSettings,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc},
    task::JoinHandle,
};

use matrix_sdk_crypto::{types::SecretsBundle, vodozemac::Ed25519SecretKey};

static DIRECT_UPDATES: Mutex<()> = Mutex::const_new(());

const MAX_MEDIA: usize = 8 * 1024 * 1024;
type Output = mpsc::Sender<Value>;
type Accounts = Arc<Mutex<HashMap<String, Arc<Mutex<Account>>>>>;

#[derive(Clone, Deserialize, Serialize)]
struct Media {
    data: String,
    mime_type: String,
    #[serde(default)]
    filename: String,
}

#[derive(Clone, Default)]
enum AvatarUpdate {
    #[default]
    Preserve,
    Clear,
    Set(Media),
}
impl<'de> Deserialize<'de> for AvatarUpdate {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        Ok(match Option::<Media>::deserialize(deserializer)? {
            Some(media) => Self::Set(media),
            None => Self::Clear,
        })
    }
}

#[derive(Clone, Deserialize)]
struct Start {
    agent_id: String,
    homeserver: String,
    matrix_id: String,
    password: String,
    owner_id: String,
    store_path: PathBuf,
    display_name: Option<String>,
    #[serde(default)]
    avatar: AvatarUpdate,
}

struct Account {
    config: Option<Start>,
    client: Option<Client>,
    task: Option<JoinHandle<()>>,
    pending: Arc<Mutex<BTreeMap<String, Value>>>,
}

impl Account {
    fn new() -> Self {
        Self {
            config: None,
            client: None,
            task: None,
            pending: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
    async fn stop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        self.client = None;
    }
}

fn emit_status(out: &Output, agent: &str, status: &str, error: Option<String>) {
    let _ = out
        .try_send(json!({"v":1,"event":"status","agent_id":agent,"status":status,"error":error}));
}

async fn private_dir(path: &Path) -> Result<()> {
    tokio::fs::create_dir_all(path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    }
    Ok(())
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("tmp");
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    drop(file);
    tokio::fs::rename(&temporary, path).await?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        tokio::fs::File::open(parent).await?.sync_all().await?;
    }
    Ok(())
}

fn event_sequence(event: &Value) -> u64 {
    event["sequence"]
        .as_u64()
        .or_else(|| event["timestamp"].as_u64())
        .unwrap_or(0)
}

async fn persist_pending(config: &Start, pending: &BTreeMap<String, Value>) -> Result<()> {
    atomic_write(
        &config.store_path.join("pending-events.json"),
        &serde_json::to_vec(pending)?,
    )
    .await
}

#[derive(Debug)]
struct RoutingDenied(&'static str);
impl std::fmt::Display for RoutingDenied {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for RoutingDenied {}
fn denied<T>(reason: &'static str) -> Result<T> {
    Err(RoutingDenied(reason).into())
}

fn active_members(raw: &[Value], owner: &str, agent: &str) -> Result<Vec<String>> {
    let mut members = Vec::new();
    for event in raw {
        let membership = event["content"]["membership"]
            .as_str()
            .context("Invalid room member state")?;
        if matches!(membership, "join" | "invite" | "knock") {
            let id = event["state_key"]
                .as_str()
                .context("Invalid member identity")?
                .to_string();
            // A third invited member also invalidates a DM, even before they join.
            if membership != "join" {
                return denied("Room contains an unjoined or invited member");
            }
            members.push(id);
        }
    }
    members.sort();
    members.dedup();
    if members.len() != 2
        || !members.iter().any(|m| m == owner)
        || !members.iter().any(|m| m == agent)
    {
        return denied("Only the owner and agent may belong to the direct conversation");
    }
    Ok(members)
}

fn direct_membership_evidence(members: &[Value], owner: &str, agent: &str) -> bool {
    members.iter().any(|member| {
        let id = member["state_key"].as_str();
        (id == Some(owner) || id == Some(agent))
            && (member["content"]["is_direct"] == true
                || member["unsigned"]["prev_content"]["is_direct"] == true)
    })
}

async fn validate_room(
    client: &Client,
    room: &Room,
    config: &Start,
    discover: bool,
) -> Result<Vec<String>> {
    if room.state() != RoomState::Joined {
        return denied("Agent has not joined this room");
    }
    let response = client
        .send(get_member_events::v3::Request::new(
            room.room_id().to_owned(),
        ))
        .await?;
    let members = response
        .chunk
        .iter()
        .map(|raw| serde_json::from_str(raw.json().get()))
        .collect::<std::result::Result<Vec<Value>, _>>()?;
    let direct_evidence = direct_membership_evidence(&members, &config.owner_id, &config.matrix_id);
    let members = active_members(&members, &config.owner_id, &config.matrix_id)?;
    // Key sharing uses SDK member state, so do not send while it disagrees with the server.
    let mut cached: Vec<String> = room
        .members(RoomMemberships::ACTIVE)
        .await?
        .iter()
        .map(|member| member.user_id().to_string())
        .collect();
    cached.sort();
    cached.dedup();
    if cached != members {
        bail!("Room membership is changing; retry after Matrix synchronization");
    }
    let join = client
        .send(get_state_event_for_key::v3::Request::new(
            room.room_id().to_owned(),
            StateEventType::RoomJoinRules,
            String::new(),
        ))
        .await?;
    let join: Value = serde_json::from_str(join.event_or_content.get())?;
    if join["join_rule"] != "invite" {
        return denied("Direct conversation must use invite-only membership");
    }
    if !room.latest_encryption_state().await?.is_encrypted() {
        return denied("Direct conversation must be encrypted");
    }
    // A direct flag is per account: existing owner DMs may only be indexed on the owner's side.
    // Establish our own routing state only after authoritative pair/private/encryption checks.
    let _update = DIRECT_UPDATES.lock().await;
    let user = client
        .user_id()
        .context("Matrix client is not authenticated")?;
    let response = client
        .send(get_global_account_data::v3::Request::new(
            user.to_owned(),
            GlobalAccountDataEventType::Direct,
        ))
        .await;
    let mut direct: Value = match response {
        Ok(response) => serde_json::from_str(response.account_data.json().get())?,
        Err(error) if error.to_string().contains("M_NOT_FOUND") => json!({}),
        Err(error) => return Err(error.into()),
    };
    let known = direct
        .get(&config.owner_id)
        .and_then(Value::as_array)
        .is_some_and(|rooms| {
            rooms
                .iter()
                .any(|id| id.as_str() == Some(room.room_id().as_str()))
        });
    if !known {
        if !discover || !direct_evidence {
            return denied("Room is not recorded as a direct conversation with the owner");
        }
        let map = direct
            .as_object_mut()
            .context("Invalid Matrix direct-message account data")?;
        let rooms = map
            .entry(config.owner_id.clone())
            .or_insert_with(|| json!([]));
        rooms
            .as_array_mut()
            .context("Invalid Matrix direct-message room list")?
            .push(json!(room.room_id()));
        client
            .send(set_global_account_data::v3::Request::new(
                user.to_owned(),
                &serde_json::from_value::<matrix_sdk::ruma::events::direct::DirectEventContent>(
                    direct,
                )?,
            )?)
            .await?;
    }
    Ok(members)
}

fn decode_media(media: &Media) -> Result<(Vec<u8>, mime::Mime)> {
    if media.data.len() > (MAX_MEDIA * 4 / 3) + 8 {
        bail!("Image exceeds the 8 MiB limit");
    }
    let content_type: mime::Mime = media
        .mime_type
        .parse()
        .context("Invalid image content type")?;
    if content_type.type_() != mime::IMAGE {
        bail!("Only images are supported");
    }
    let bytes = BASE64.decode(&media.data).context("Invalid base64 image")?;
    if bytes.len() > MAX_MEDIA {
        bail!("Image exceeds the 8 MiB limit");
    }
    Ok((bytes, content_type))
}

fn unsupported_profile_delete(error: &str) -> bool {
    error.contains("405") || error.contains("M_UNRECOGNIZED")
}

async fn profile(client: &Client, name: Option<&str>, avatar: &AvatarUpdate) -> Result<()> {
    if let Some(name) = name {
        client.account().set_display_name(Some(name)).await?;
    }
    match avatar {
        AvatarUpdate::Preserve => {}
        AvatarUpdate::Clear => {
            match client.account().set_avatar_url(None).await {
                Ok(()) => {}
                Err(error) if unsupported_profile_delete(&error.to_string()) => {
                    // Some homeservers advertise extended profile fields before DELETE is implemented.
                    #[allow(deprecated)]
                    let request = set_avatar_url::v3::Request::new(
                        client
                            .user_id()
                            .context("Matrix client is not authenticated")?
                            .to_owned(),
                        None,
                    );
                    client.send(request).await?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        AvatarUpdate::Set(avatar) => {
            let (bytes, mime) = decode_media(avatar)?;
            client.account().upload_avatar(&mime, bytes).await?;
        }
    }
    Ok(())
}

fn unauthorized(error: &str) -> bool {
    error.contains("M_UNKNOWN_TOKEN")
        || error.contains("M_MISSING_TOKEN")
        || error.contains("M_FORBIDDEN")
}

fn recoverable_store(error: &str) -> bool {
    let message = error.to_lowercase();
    message.contains("database disk image is malformed")
        || message.contains("file is not a database")
        || message.contains("mismatchedaccount")
        || message.contains("mismatched account")
}

async fn build_client(config: &Start) -> Result<Client> {
    let client = Client::builder()
        .homeserver_url(&config.homeserver)
        .sqlite_store(config.store_path.join("sqlite"), None)
        .request_config(
            RequestConfig::new()
                .disable_retry()
                .timeout(Duration::from_secs(30)),
        )
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: true,
            auto_enable_backups: true,
            backup_download_strategy: BackupDownloadStrategy::AfterDecryptionFailure,
        })
        .build()
        .await?;
    Ok(client)
}

async fn restore_or_login(config: &Start, client: &Client) -> Result<()> {
    let session_path = config.store_path.join("session.json");
    let device_path = config.store_path.join("device-id.json");
    let mut saved_device: Option<String> = tokio::fs::read(&device_path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    if let Ok(bytes) = tokio::fs::read(&session_path).await {
        let stored: Value = serde_json::from_slice(&bytes)
            .context("Saved Matrix authentication state is corrupt")?;
        if stored["homeserver"].as_str() == Some(config.homeserver.as_str()) {
            let session: MatrixSession = serde_json::from_value(stored["session"].clone())?;
            if session.meta.user_id.as_str() != config.matrix_id {
                bail!("Stored Matrix identity does not match the configured account");
            }
            saved_device = Some(session.meta.device_id.to_string());
            client
                .matrix_auth()
                .restore_session(session, RoomLoadSettings::default())
                .await?;
            match client.whoami().await {
                Ok(identity) => {
                    if identity.user_id.as_str() != config.matrix_id {
                        bail!("Homeserver returned a different Matrix account");
                    }
                    return Ok(());
                }
                Err(error) if unauthorized(&error.to_string()) => {}
                Err(error) => return Err(error.into()),
            }
        } else {
            // The same crypto store cannot belong to two homeservers.
            bail!(
                "Homeserver changed: reinitialize this agent's Matrix store and reenter its password"
            );
        }
    }
    if config.password.is_empty() {
        bail!("Matrix password is required to authenticate this agent");
    }
    if saved_device.is_none() {
        let device = format!("FA-{}", uuid::Uuid::new_v4());
        atomic_write(&device_path, &serde_json::to_vec(&device)?).await?;
        saved_device = Some(device);
    }
    let mut login = client
        .matrix_auth()
        .login_username(&config.matrix_id, &config.password)
        .initial_device_display_name("Family Agents V2");
    if let Some(device) = saved_device.as_deref() {
        login = login.device_id(device);
    }
    let response = login.send().await?;
    if response.user_id.as_str() != config.matrix_id {
        bail!("Homeserver returned a different Matrix account");
    }
    let session = client
        .matrix_auth()
        .session()
        .context("Matrix login did not produce a session")?;
    atomic_write(
        &session_path,
        &serde_json::to_vec(&json!({"homeserver":config.homeserver,"session":session}))?,
    )
    .await?;
    Ok(())
}

async fn authenticated(config: &Start) -> Result<Client> {
    private_dir(&config.store_path).await?;
    let attempt = async {
        let client = build_client(config).await?;
        restore_or_login(config, &client).await?;
        Ok::<Client, anyhow::Error>(client)
    }
    .await;
    match attempt {
        Ok(client) => Ok(client),
        Err(error) if recoverable_store(&format!("{error:?}")) => {
            let marker = config.store_path.join("automatic-reset.json");
            if marker.exists() {
                bail!(
                    "Matrix store recovery was already attempted. Reenter credentials or remove the failed agent before retrying"
                );
            }
            atomic_write(&marker, b"{\"attempted\":true}").await?;
            let archive = config
                .store_path
                .join(format!("recovery-{}", uuid::Uuid::new_v4()));
            private_dir(&archive).await?;
            for name in [
                "sqlite",
                "session.json",
                "sync-token.json",
                "device-id.json",
            ] {
                let source = config.store_path.join(name);
                if source.exists() {
                    tokio::fs::rename(source, archive.join(name)).await?;
                }
            }
            let client = build_client(config).await?;
            restore_or_login(config, &client).await?;
            Ok(client)
        }
        Err(error) => Err(error),
    }
}

fn signing_key_matches(secret: &str, public: &Value) -> bool {
    let Ok(secret) = Ed25519SecretKey::from_base64(secret) else {
        return false;
    };
    let expected = secret.public_key().to_base64();
    public["keys"].as_object().is_some_and(|keys| {
        keys.len() == 1
            && keys
                .values()
                .any(|value| value.as_str() == Some(expected.as_str()))
    })
}

async fn verify_identity(client: &Client, config: &Start) -> Result<()> {
    let path = config.store_path.join("identity-secrets.json");
    if !path.exists() {
        client
            .encryption()
            .wait_for_e2ee_initialization_tasks()
            .await;
        client
            .encryption()
            .bootstrap_cross_signing_if_needed(None)
            .await?;
        if client
            .encryption()
            .cross_signing_status()
            .await
            .is_some_and(|status| status.is_complete())
        {
            // Keep the native identity separate from the crypto DB so bounded DB recovery can sign its replacement device.
            if let Some((user, bundle)) = matrix_sdk::encryption::export_secrets_bundle_from_store(
                config.store_path.join("sqlite"),
                None,
            )
            .await?
            {
                if Some(user.as_ref()) != client.user_id() {
                    bail!("Exported signing identity belongs to another account");
                }
                atomic_write(&path, &serde_json::to_vec(&bundle)?).await?;
            }
        }
    }
    if path.exists() {
        let bundle: SecretsBundle = serde_json::from_slice(&tokio::fs::read(&path).await?)
            .context("Cannot read private Matrix signing identity")?;
        let user = client
            .user_id()
            .context("Matrix client is not authenticated")?;
        let mut request = get_keys::v3::Request::new();
        request.device_keys.insert(user.to_owned(), vec![]);
        let keys = client.send(request).await?;
        for (secret, public) in [
            (&bundle.cross_signing.master_key, keys.master_keys.get(user)),
            (
                &bundle.cross_signing.self_signing_key,
                keys.self_signing_keys.get(user),
            ),
            (
                &bundle.cross_signing.user_signing_key,
                keys.user_signing_keys.get(user),
            ),
        ] {
            let public: Value = serde_json::from_str(
                public
                    .context("Matrix signing identity is missing on the server")?
                    .json()
                    .get(),
            )?;
            if !signing_key_matches(secret, &public) {
                bail!(
                    "Stored signing keys do not match this Matrix account. The existing identity was not replaced."
                );
            }
        }
        client.encryption().import_secrets_bundle(&bundle).await?;
        client.encryption().request_user_identity(user).await?;
        client
            .encryption()
            .get_own_device()
            .await?
            .context("Matrix device keys are unavailable")?
            .verify()
            .await?;
    }
    Ok(())
}

async fn start(account: &mut Account, config: Start, out: Output) -> Result<Value> {
    if account.client.is_some()
        && account
            .task
            .as_ref()
            .is_some_and(|task| !task.is_finished())
    {
        return Ok(json!({"status":"running"}));
    }
    if account.client.is_some() {
        account.stop().await;
    }
    let _: OwnedUserId = config
        .matrix_id
        .parse()
        .context("Invalid agent Matrix ID")?;
    let _: OwnedUserId = config.owner_id.parse().context("Invalid owner Matrix ID")?;
    if config.matrix_id == config.owner_id {
        bail!("Owner and agent must be different Matrix accounts");
    }
    account.config = Some(config.clone());
    emit_status(&out, &config.agent_id, "starting", None);
    let client = authenticated(&config).await?;
    verify_identity(&client, &config).await?;
    profile(&client, config.display_name.as_deref(), &config.avatar).await?;
    let pending_path = config.store_path.join("pending-events.json");
    if pending_path.exists() {
        *account.pending.lock().await =
            serde_json::from_slice(&tokio::fs::read(pending_path).await?)?;
    }
    let mut replay: Vec<Value> = account.pending.lock().await.values().cloned().collect();
    replay.sort_by_key(event_sequence);
    for event in replay {
        out.send(event).await?;
    }
    let pending = account.pending.clone();
    let failure = Arc::new(AtomicBool::new(false));
    let message_config = config.clone();
    let message_out = out.clone();
    let handler_failure = failure.clone();
    client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room, encryption: Option<EncryptionInfo>| {
        let config = message_config.clone();
        let out = message_out.clone();
        let pending = pending.clone();
        let failure = handler_failure.clone();
        async move {
            // A plain m.room.message injected into an encrypted room is never accepted.
            if event.sender.as_str() != config.owner_id || encryption.is_none() { return; }
            let process = async {
                let members = match validate_room(&room.client(), &room, &config, true).await {
                    Ok(members) => members,
                    Err(error) if error.is::<RoutingDenied>() => return Ok(()),
                    Err(error) => return Err(error),
                };
                let mut message = json!({"v":1,"event":"message","agent_id":config.agent_id,"room_id":room.room_id(),"event_id":event.event_id,"timestamp":event.origin_server_ts,"sender":event.sender,"body":event.content.body(),"is_direct":true,"members":members});
                match &event.content.msgtype {
                    MessageType::Text(_) | MessageType::Notice(_) => {},
                    MessageType::Image(image) => {
                        if !matches!(image.source, MediaSource::Encrypted(_)) { return Ok(()); }
                        let mime = image.info.as_ref().and_then(|info| info.mimetype.clone()).unwrap_or_else(|| "image/png".to_string());
                        if !mime.starts_with("image/") { return Ok(()); }
                        if image.info.as_ref().and_then(|info| info.size).is_some_and(|size| u64::from(size) > MAX_MEDIA as u64) { return Ok(()); }
                        let bytes = room.client().media().get_file(image, false).await?.context("Image has no media source")?;
                        if bytes.len() > MAX_MEDIA { return Ok(()); }
                        message["media"] = json!({"data":BASE64.encode(&bytes),"mime_type":mime,"filename":image.body});
                    },
                    _ => return Ok(()),
                }
                let mut pending = pending.lock().await;
                let key = event.event_id.to_string();
                let sequence = pending.values().map(event_sequence).max().unwrap_or(0).saturating_add(1);
                let message = pending.entry(key).or_insert_with(|| { message["sequence"]=json!(sequence); message }).clone();
                // Persist on duplicate delivery too: a previous filesystem failure may have left only an in-memory entry.
                persist_pending(&config, &pending).await?;
                out.send(message).await?;
                Ok::<(), anyhow::Error>(())
            }.await;
            if let Err(error) = process {
                failure.store(true, Ordering::SeqCst);
                emit_status(&out, &config.agent_id, "reconnecting", Some(format!("Inbound delivery failed: {error}")));
            }
        }
    });
    let invite_config = config.clone();
    client.add_event_handler(move |event: StrippedRoomMemberEvent, room: Room| {
        let config = invite_config.clone();
        async move {
            if room.state() == RoomState::Invited
                && event.state_key.as_str() == config.matrix_id
                && event.sender.as_str() == config.owner_id
                && event.content.is_direct == Some(true)
            {
                // Owner-created direct invites can be joined; no messages pass until full validation.
                if room.join().await.is_ok()
                    && let Some(joined) = room.client().get_room(room.room_id())
                {
                    let _ = joined.set_is_direct(true).await;
                }
            }
        }
    });
    let task_client = client.clone();
    let task_config = config.clone();
    let task_out = out.clone();
    let task = tokio::spawn(async move {
        let cursor_path = task_config.store_path.join("sync-token.json");
        let mut cursor: Option<String> = tokio::fs::read(&cursor_path)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let mut failures = 0;
        loop {
            let settings = SyncSettings::new()
                .token(SyncToken::from_optional_token(cursor.clone()))
                .timeout(Duration::from_secs(20));
            match task_client.sync_once(settings).await {
                Ok(response) => {
                    if failure.swap(false, Ordering::SeqCst) {
                        failures += 1;
                        if failures >= 8 {
                            emit_status(&task_out, &task_config.agent_id, "error", Some("Inbound delivery failed repeatedly; reconnect after correcting the reported error".to_string()));
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs((1u64 << failures.min(5)).min(30)))
                            .await;
                        continue;
                    }
                    for room in task_client.joined_rooms() {
                        let candidate = room.members(RoomMemberships::ACTIVE).await;
                        if let Ok(members) = candidate
                            && members.len() == 2
                            && members
                                .iter()
                                .any(|m| m.user_id().as_str() == task_config.owner_id)
                            && let Err(error) =
                                validate_room(&task_client, &room, &task_config, true).await
                            && !error.is::<RoutingDenied>()
                        {
                            emit_status(
                                &task_out,
                                &task_config.agent_id,
                                "reconnecting",
                                Some(format!("Cannot discover owner conversation: {error}")),
                            );
                        }
                    }
                    // Advance our cursor only after handlers have durably spooled messages.
                    if let Err(error) = atomic_write(
                        &cursor_path,
                        &serde_json::to_vec(&response.next_batch).unwrap(),
                    )
                    .await
                    {
                        emit_status(
                            &task_out,
                            &task_config.agent_id,
                            "error",
                            Some(format!("Cannot persist sync position: {error}")),
                        );
                        break;
                    }
                    cursor = Some(response.next_batch);
                    failures = 0;
                    emit_status(&task_out, &task_config.agent_id, "running", None);
                }
                Err(error) => {
                    failures += 1;
                    let text = error.to_string();
                    if unauthorized(&text) || failures >= 8 {
                        emit_status(
                            &task_out,
                            &task_config.agent_id,
                            "error",
                            Some(format!("Matrix synchronization failed: {text}")),
                        );
                        break;
                    }
                    emit_status(&task_out, &task_config.agent_id, "reconnecting", Some(text));
                    tokio::time::sleep(Duration::from_secs((1u64 << failures.min(5)).min(30)))
                        .await;
                }
            }
        }
    });
    let device = client.device_id().map(|device| device.to_string());
    account.client = Some(client);
    account.task = Some(task);
    Ok(json!({"status":"running","device_id":device}))
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("Missing string field: {key}"))
}

async fn command(request: &Value, accounts: &Accounts, out: &Output) -> Result<Value> {
    if request["v"] != 1 {
        bail!("Unsupported protocol version");
    }
    let op = string(request, "op")?;
    if op == "status" && request.get("agent_id").is_none() {
        let snapshot: Vec<_> = accounts
            .lock()
            .await
            .iter()
            .map(|(id, account)| (id.clone(), account.clone()))
            .collect();
        let mut agents = Vec::new();
        for (id, account) in snapshot {
            let account = account.lock().await;
            agents.push(json!({"agent_id":id,"status":if account.task.as_ref().is_some_and(|task| !task.is_finished()) {"running"} else if account.client.is_some() {"error"} else {"stopped"}}));
        }
        return Ok(json!({"ready":true,"agents":agents}));
    }
    let agent_id = string(request, "agent_id")?;
    if agent_id.is_empty() {
        bail!("Agent identifier is required");
    }
    let account = accounts
        .lock()
        .await
        .entry(agent_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(Account::new())))
        .clone();
    let mut account = account.lock().await;
    match op {
        "start" => {
            start(
                &mut account,
                serde_json::from_value(request.clone())?,
                out.clone(),
            )
            .await
        }
        "stop" => {
            account.stop().await;
            emit_status(out, agent_id, "stopped", None);
            Ok(json!({"status":"stopped"}))
        }
        "reconnect" => {
            let config = account
                .config
                .clone()
                .context("Agent has not been configured")?;
            account.stop().await;
            start(&mut account, config, out.clone()).await
        }
        "status" => Ok(
            json!({"status":if account.task.as_ref().is_some_and(|task| !task.is_finished()) { "running" } else if account.client.is_some() { "error" } else { "stopped" },"device_id":account.client.as_ref().and_then(Client::device_id).map(ToString::to_string)}),
        ),
        "ack_event" => {
            let config = account
                .config
                .as_ref()
                .context("Agent has not been configured")?;
            let mut pending = account.pending.lock().await;
            pending.remove(string(request, "event_id")?);
            persist_pending(config, &pending).await?;
            Ok(json!({}))
        }
        "update_profile" => {
            let client = account.client.as_ref().context("Agent is stopped")?;
            let avatar: AvatarUpdate = request
                .get("avatar")
                .map(|value| serde_json::from_value(value.clone()))
                .transpose()?
                .unwrap_or_default();
            profile(
                client,
                request.get("display_name").and_then(Value::as_str),
                &avatar,
            )
            .await?;
            Ok(json!({}))
        }
        "validate_room" | "send_message" | "send_media" => {
            let client = account.client.as_ref().context("Agent is stopped")?;
            let config = account
                .config
                .as_ref()
                .context("Agent has not been configured")?;
            let room_id: OwnedRoomId = string(request, "room_id")?
                .parse()
                .context("Invalid room ID")?;
            let room = client.get_room(&room_id).context("Unknown Matrix room")?;
            let members = validate_room(client, &room, config, false).await?;
            if op == "validate_room" {
                return Ok(json!({"is_direct":true,"members":members,"encrypted":true}));
            }
            let txn = string(request, "txn_id")?;
            if txn.is_empty() || txn.len() > 255 {
                bail!("A stable transaction ID is required");
            }
            let txn: OwnedTransactionId = txn.into();
            let event_id = if op == "send_message" {
                let text = string(request, "text")?;
                room.send(RoomMessageEventContent::text_plain(text))
                    .with_transaction_id(txn)
                    .await?
                    .response
                    .event_id
            } else {
                let media: Media = serde_json::from_value(request.clone())?;
                let (bytes, mime) = decode_media(&media)?;
                let length = bytes.len();
                let mut reader = std::io::Cursor::new(bytes);
                let file = client.upload_encrypted_file(&mut reader).await?;
                // Upload precedes a fresh membership check; uploaded bytes disclose no plaintext.
                validate_room(client, &room, config, false).await?;
                let mut info = ImageInfo::new();
                info.mimetype = Some(mime.to_string());
                info.size = Some((length as u32).into());
                let image = ImageMessageEventContent::encrypted(media.filename, file)
                    .info(Some(Box::new(info)));
                room.send(RoomMessageEventContent::new(MessageType::Image(image)))
                    .with_transaction_id(txn)
                    .await?
                    .response
                    .event_id
            };
            Ok(json!({"event_id":event_id}))
        }
        _ => bail!("Unknown operation: {op}"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();
    let (out, mut receiver) = mpsc::channel::<Value>(128);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = receiver.recv().await {
            let mut bytes = serde_json::to_vec(&value)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });
    let accounts: Accounts = Arc::new(Mutex::new(HashMap::new()));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut commands = tokio::task::JoinSet::new();
    while let Some(line) = lines.next_line().await? {
        let parsed: Result<Value> = if line.len() > MAX_MEDIA * 2 {
            Err(anyhow::anyhow!("IPC line exceeds limit"))
        } else {
            serde_json::from_str(&line).map_err(Into::into)
        };
        let request = match parsed {
            Ok(request) => request,
            Err(_) => {
                out.send(json!({"v":1,"id":null,"ok":false,"error":{"code":"invalid_request","message":"Malformed or oversized JSON request"}})).await?;
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        if request["op"] == "shutdown" && request["v"] == 1 {
            commands.abort_all();
            while commands.join_next().await.is_some() {}
            let snapshot: Vec<_> = accounts.lock().await.values().cloned().collect();
            for account in snapshot {
                account.lock().await.stop().await;
            }
            out.send(json!({"v":1,"id":id,"ok":true,"result":{}}))
                .await?;
            break;
        }
        if !id.is_string() {
            out.send(json!({"v":1,"id":id,"ok":false,"error":{"code":"invalid_request","message":"Request ID must be a string"}})).await?;
            continue;
        }
        let accounts = accounts.clone();
        let out = out.clone();
        commands.spawn(async move {
            let response = match command(&request, &accounts, &out).await {
                Ok(result) => json!({"v":1,"id":id,"ok":true,"result":result}),
                Err(error) => {
                    let message = error.to_string();
                    if let Some(agent) = request["agent_id"].as_str() { emit_status(&out, agent, "error", Some(message.clone())); }
                    json!({"v":1,"id":id,"ok":false,"error":{"code":"matrix_error","message":message}})
                }
            };
            let _ = out.send(response).await;
        });
        while commands.try_join_next().is_some() {}
    }
    commands.abort_all();
    while commands.join_next().await.is_some() {}
    let snapshot: Vec<_> = accounts.lock().await.values().cloned().collect();
    for account in snapshot {
        account.lock().await.stop().await;
    }
    drop(accounts);
    drop(out);
    writer.await??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restored_identity_requires_matching_public_keys() {
        let key = Ed25519SecretKey::new();
        let other = Ed25519SecretKey::new();
        let public = json!({"keys": {"ed25519:identity": key.public_key().to_base64()}});
        assert!(signing_key_matches(&key.to_base64(), &public));
        assert!(!signing_key_matches(&other.to_base64(), &public));
        assert!(!signing_key_matches("invalid", &public));
        assert!(!signing_key_matches(&key.to_base64(), &json!({"keys":{}})));
    }

    #[test]
    fn existing_dm_discovery_requires_direct_membership_evidence() {
        let mut owner = member("@owner:x", "join");
        let agent = member("@bot:x", "join");
        assert!(!direct_membership_evidence(
            &[owner.clone(), agent.clone()],
            "@owner:x",
            "@bot:x"
        ));
        owner["unsigned"] = json!({"prev_content":{"membership":"join","is_direct":true}});
        assert!(direct_membership_evidence(
            &[owner.clone(), agent.clone()],
            "@owner:x",
            "@bot:x"
        ));
        let third =
            json!({"state_key":"@third:x","content":{"membership":"join","is_direct":true}});
        assert!(!direct_membership_evidence(
            &[agent.clone(), third.clone()],
            "@owner:x",
            "@bot:x"
        ));
        assert!(active_members(&[owner, agent, third], "@owner:x", "@bot:x").is_err());
    }
    fn member(id: &str, state: &str) -> Value {
        json!({"state_key":id,"content":{"membership":state}})
    }
    #[test]
    fn owner_and_agent_only() {
        assert_eq!(
            active_members(
                &[
                    member("@owner:example.org", "join"),
                    member("@bot:example.org", "join")
                ],
                "@owner:example.org",
                "@bot:example.org"
            )
            .unwrap()
            .len(),
            2
        );
    }
    #[test]
    fn reject_groups_and_pending_third_party_invites() {
        for state in ["join", "invite", "knock"] {
            assert!(
                active_members(
                    &[
                        member("@owner:x", "join"),
                        member("@bot:x", "join"),
                        member("@other:x", state)
                    ],
                    "@owner:x",
                    "@bot:x"
                )
                .is_err()
            );
        }
    }
    #[test]
    fn reject_missing_owner_and_unjoined_agent() {
        assert!(
            active_members(
                &[member("@other:x", "join"), member("@bot:x", "join")],
                "@owner:x",
                "@bot:x"
            )
            .is_err()
        );
        assert!(
            active_members(
                &[member("@owner:x", "join"), member("@bot:x", "invite")],
                "@owner:x",
                "@bot:x"
            )
            .is_err()
        );
    }
    #[test]
    fn left_members_do_not_make_a_group() {
        assert!(
            active_members(
                &[
                    member("@owner:x", "join"),
                    member("@bot:x", "join"),
                    member("@other:x", "leave")
                ],
                "@owner:x",
                "@bot:x"
            )
            .is_ok()
        );
    }
    #[test]
    fn media_validation() {
        assert!(
            decode_media(&Media {
                data: "bad!".into(),
                mime_type: "image/png".into(),
                filename: String::new()
            })
            .is_err()
        );
        assert!(
            decode_media(&Media {
                data: BASE64.encode(b"file"),
                mime_type: "text/html".into(),
                filename: String::new()
            })
            .is_err()
        );
        assert!(
            decode_media(&Media {
                data: BASE64.encode(b"image"),
                mime_type: "image/png".into(),
                filename: String::new()
            })
            .is_ok()
        );
    }
    #[test]
    fn controlled_recovery_only_for_local_corruption() {
        assert!(recoverable_store("database disk image is malformed"));
        assert!(!recoverable_store("M_FORBIDDEN: invalid password"));
        assert!(!recoverable_store("Network connection timed out"));
    }
    #[tokio::test]
    async fn global_readiness_and_protocol_version() {
        let accounts: Accounts = Arc::new(Mutex::new(HashMap::new()));
        let (out, _) = mpsc::channel(8);
        let ready = command(&json!({"v":1,"op":"status"}), &accounts, &out)
            .await
            .unwrap();
        assert_eq!(ready["ready"], true);
        assert!(
            command(&json!({"v":2,"op":"status"}), &accounts, &out)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn spool_commit_and_ack_are_private_and_durable() {
        let directory =
            std::env::temp_dir().join(format!("family-gateway-test-{}", uuid::Uuid::new_v4()));
        private_dir(&directory).await.unwrap();
        let config = Start {
            agent_id: "test".into(),
            homeserver: "https://example.org".into(),
            matrix_id: "@bot:example.org".into(),
            owner_id: "@owner:example.org".into(),
            password: String::new(),
            store_path: directory.clone(),
            display_name: None,
            avatar: AvatarUpdate::Preserve,
        };
        let mut pending = BTreeMap::new();
        pending.insert(
            "$test".into(),
            json!({"event_id":"$test","body":"private text"}),
        );
        persist_pending(&config, &pending).await.unwrap();
        let path = directory.join("pending-events.json");
        let restored: BTreeMap<String, Value> =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(restored["$test"]["body"], "private text");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                tokio::fs::metadata(&path)
                    .await
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        pending.clear();
        persist_pending(&config, &pending).await.unwrap();
        let restored: BTreeMap<String, Value> =
            serde_json::from_slice(&tokio::fs::read(path).await.unwrap()).unwrap();
        assert!(restored.is_empty());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }
    #[test]
    fn policy_denials_are_distinct_from_transient_delivery_failures() {
        let error =
            active_members(&[member("@other:x", "join")], "@owner:x", "@bot:x").unwrap_err();
        assert!(error.is::<RoutingDenied>());
        assert!(!anyhow::anyhow!("network timeout").is::<RoutingDenied>());
    }
    #[test]
    fn avatar_edits_distinguish_preserve_clear_and_upload() {
        assert!(matches!(AvatarUpdate::default(), AvatarUpdate::Preserve));
        assert!(matches!(
            serde_json::from_value::<AvatarUpdate>(Value::Null).unwrap(),
            AvatarUpdate::Clear
        ));
        assert!(matches!(
            serde_json::from_value::<AvatarUpdate>(
                json!({"data":"aW1hZ2U=","mime_type":"image/png"})
            )
            .unwrap(),
            AvatarUpdate::Set(_)
        ));
    }
    #[test]
    fn clear_avatar_fallback_only_for_unsupported_endpoint() {
        assert!(unsupported_profile_delete(
            "[405 / M_UNRECOGNIZED] Method Not Allowed"
        ));
        assert!(!unsupported_profile_delete(
            "[401 / M_UNKNOWN_TOKEN] Invalid token"
        ));
        assert!(!unsupported_profile_delete("connection timed out"));
    }
    #[test]
    fn replay_preserves_arrival_order_when_timestamps_tie() {
        let mut pending = BTreeMap::new();
        pending.insert("$z", json!({"event_id":"$z","timestamp":1000,"sequence":1}));
        pending.insert("$a", json!({"event_id":"$a","timestamp":1000,"sequence":2}));
        let bytes = serde_json::to_vec(&pending).unwrap();
        let restored: BTreeMap<String, Value> = serde_json::from_slice(&bytes).unwrap();
        let mut events: Vec<_> = restored.into_values().collect();
        events.sort_by_key(event_sequence);
        assert_eq!(events[0]["event_id"], "$z");
        assert_eq!(events[1]["event_id"], "$a");
    }
}
