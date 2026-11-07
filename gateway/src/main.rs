#![recursion_limit = "512"]
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use matrix_sdk::{
    Client, Room, RoomMemberships, RoomState,
    authentication::matrix::MatrixSession,
    config::{RequestConfig, SyncSettings, SyncToken},
    deserialized_responses::{EncryptionInfo, TimelineEventKind},
    encryption::{BackupDownloadStrategy, EncryptionSettings},
    event_handler::RawEvent,
    ruma::{
        EventId, OwnedEventId, OwnedRoomId, OwnedTransactionId, OwnedUserId,
        api::client::{
            config::{get_global_account_data, set_global_account_data},
            keys::get_keys,
            membership::get_member_events,
            profile::set_avatar_url,
            state::get_state_event_for_key,
        },
        events::{
            AnyMessageLikeEvent, AnyTimelineEvent, GlobalAccountDataEventType, MessageLikeEvent,
            StateEventType,
            relation::Thread,
            room::{
                ImageInfo, MediaSource,
                member::StrippedRoomMemberEvent,
                message::{
                    FileInfo, FileMessageEventContent, ImageMessageEventContent, MessageType,
                    OriginalRoomMessageEvent, OriginalSyncRoomMessageEvent, Relation,
                    RoomMessageEventContent, TextMessageEventContent,
                    sanitize::remove_plain_reply_fallback,
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
use ruma::html::{Html, SanitizerConfig};

static DIRECT_UPDATES: Mutex<()> = Mutex::const_new(());

const MAX_MEDIA: usize = 8 * 1024 * 1024;
// Leave room in Matrix's 64 KiB event limit for encryption, base64 and event metadata.
const MAX_FORMATTED_MESSAGE_BYTES: usize = 45 * 1024;
const MAX_THREAD_ROOT_BODY_UNITS: usize = 4000;
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

fn decode_file(media: &Media) -> Result<(Vec<u8>, mime::Mime)> {
    if media.filename.is_empty()
        || media.filename.chars().count() > 255
        || media.filename.trim() != media.filename
        || media.filename.starts_with('.')
        || media.filename.chars().any(|character| {
            character.is_control()
                || matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        bail!("A safe file basename is required");
    }
    if media.data.is_empty() || media.data.len() > MAX_MEDIA.div_ceil(3) * 4 {
        bail!("Files must contain between 1 byte and 8 MiB");
    }
    let content_type: mime::Mime = media
        .mime_type
        .parse()
        .context("Invalid file content type")?;
    let extension = media
        .filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        (content_type.essence_str(), extension.as_str()),
        ("application/pdf", "pdf") | ("text/csv", "csv")
    ) {
        bail!("Only PDF and CSV exports are supported");
    }
    let bytes = BASE64.decode(&media.data).context("Invalid base64 file")?;
    if bytes.is_empty() || bytes.len() > MAX_MEDIA || BASE64.encode(&bytes) != media.data {
        bail!("Files must use canonical base64 and be no larger than 8 MiB");
    }
    if content_type.essence_str() == "application/pdf" {
        if !bytes.starts_with(b"%PDF-")
            || !bytes[bytes.len().saturating_sub(2048)..]
                .windows(5)
                .any(|window| window == b"%%EOF")
        {
            bail!("The PDF export is invalid");
        }
    } else {
        let text = std::str::from_utf8(&bytes).context("CSV exports must use UTF-8")?;
        if text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\r' | '\n' | '\t'))
        {
            bail!("The CSV export contains invalid text");
        }
    }
    Ok((bytes, content_type))
}

fn document_rejection(file: &FileMessageEventContent) -> Option<&'static str> {
    if !matches!(file.source, MediaSource::Encrypted(_)) {
        return Some("Document attachments must be encrypted.");
    }
    if file
        .info
        .as_ref()
        .and_then(|info| info.size)
        .is_some_and(|size| u64::from(size) > MAX_MEDIA as u64)
    {
        return Some("Documents must be no larger than 8 MiB.");
    }
    let filename = file.filename();
    if filename.is_empty() || filename.len() > 1024 {
        return Some("The document filename is missing or too long.");
    }
    let extension = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let supported_extension = matches!(
        extension.as_str(),
        "txt"
            | "text"
            | "md"
            | "markdown"
            | "csv"
            | "tsv"
            | "json"
            | "jsonl"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "cjs"
            | "jsx"
            | "ts"
            | "tsx"
            | "py"
            | "rs"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cs"
            | "rb"
            | "php"
            | "sh"
            | "bash"
            | "sql"
            | "toml"
            | "ini"
            | "log"
            | "rst"
            | "tex"
            | "pdf"
            | "docx"
            | "xlsx"
    );
    let mime = file
        .info
        .as_ref()
        .and_then(|info| info.mimetype.as_deref())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let supported_mime = mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/json"
                | "application/ld+json"
                | "application/x-ndjson"
                | "application/jsonl"
                | "application/xml"
                | "application/yaml"
                | "application/x-yaml"
                | "application/javascript"
                | "application/x-javascript"
                | "application/pdf"
                | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
    if !supported_extension && !supported_mime {
        return Some("Unsupported document. Send text, source code, PDF, DOCX, or XLSX.");
    }
    None
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

fn sync_retry_delay(error: &str, failures: &mut u32) -> Option<Duration> {
    *failures = failures.saturating_add(1);
    if unauthorized(error) {
        return None;
    }
    // Temporary homeserver outages must not permanently stop this Agent's sync task.
    Some(Duration::from_secs((1u64 << (*failures).min(5)).min(30)))
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

async fn fetch_thread_root(room: &Room, event_id: &EventId) -> Option<OriginalRoomMessageEvent> {
    let event = tokio::time::timeout(
        Duration::from_secs(5),
        room.load_or_fetch_event(event_id, Some(RequestConfig::new().disable_retry())),
    )
    .await
    .ok()?
    .ok()?;
    let TimelineEventKind::Decrypted(decrypted) = event.kind else {
        return None;
    };
    let AnyTimelineEvent::MessageLike(AnyMessageLikeEvent::RoomMessage(
        MessageLikeEvent::Original(message),
    )) = decrypted.event.deserialize().ok()?
    else {
        return None;
    };
    (message.event_id == event_id && message.room_id == room.room_id()).then_some(message)
}

fn thread_root_body<'a>(
    event: &'a OriginalRoomMessageEvent,
    owner_id: &str,
    agent_id: &str,
) -> Option<&'a str> {
    if (event.sender != owner_id && event.sender != agent_id)
        || !matches!(event.content.relates_to, None | Some(Relation::Reply(_)))
        || !matches!(
            event.content.msgtype,
            MessageType::Text(_) | MessageType::Notice(_)
        )
    {
        return None;
    }
    let mut body = event.content.body();
    if matches!(event.content.relates_to, Some(Relation::Reply(_))) {
        body = remove_plain_reply_fallback(body);
    }
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    let mut units = 0;
    for (index, character) in body.char_indices() {
        units += character.len_utf16();
        if units > MAX_THREAD_ROOT_BODY_UNITS {
            return Some(&body[..index]);
        }
    }
    Some(body)
}

fn valid_thread_event_id(id: &str) -> bool {
    (2..=255).contains(&id.len()) && !id.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn is_new_message(event: &OriginalSyncRoomMessageEvent, raw: &str) -> bool {
    match &event.content.relates_to {
        None => true,
        Some(Relation::Replacement(_)) => false,
        Some(Relation::Thread(thread)) => {
            thread.event_id != event.event_id
                && valid_thread_event_id(thread.event_id.as_str())
                && valid_thread_event_id(event.event_id.as_str())
        }
        // Ruma may deserialize a malformed thread as a generic relation or ordinary reply.
        Some(_) => serde_json::from_str::<Value>(raw).is_ok_and(|value| {
            !matches!(
                value["content"]["m.relates_to"]["rel_type"].as_str(),
                Some("m.thread" | "io.element.thread" | "m.replace")
            )
        }),
    }
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
    client.add_event_handler(move |event: OriginalSyncRoomMessageEvent, room: Room, encryption: Option<EncryptionInfo>, raw: RawEvent| {
        let config = message_config.clone();
        let out = message_out.clone();
        let pending = pending.clone();
        let failure = handler_failure.clone();
        async move {
            // A plain m.room.message injected into an encrypted room is never accepted.
            if event.sender.as_str() != config.owner_id || encryption.is_none() || !is_new_message(&event, raw.get()) { return; }
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
                    MessageType::File(file) => {
                        message["body"] = json!(file.caption().unwrap_or(""));
                        if let Some(reason) = document_rejection(file) {
                            message["rejected"] = json!(reason);
                        } else {
                            let bytes = room.client().media().get_file(file, false).await?.context("Document has no media source")?;
                            if bytes.len() > MAX_MEDIA {
                                message["rejected"] = json!("Documents must be no larger than 8 MiB.");
                            } else {
                                let mime = file.info.as_ref().and_then(|info| info.mimetype.as_deref()).unwrap_or("application/octet-stream");
                                message["document"] = json!({"data":BASE64.encode(&bytes),"mime_type":mime,"filename":file.filename()});
                            }
                        }
                    },
                    _ => return Ok(()),
                }
                if let Some(thread) = event.content.thread() {
                    message["thread_root_id"] = json!(thread.event_id);
                    if let Some(root) = fetch_thread_root(&room, &thread.event_id).await
                        && let Some(body) = thread_root_body(&root, &config.owner_id, &config.matrix_id)
                    {
                        message["thread_root_body"] = json!(body);
                    }
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
        let mut sync_failures = 0u32;
        let mut inbound_failures = 0u32;
        loop {
            let settings = SyncSettings::new()
                .token(SyncToken::from_optional_token(cursor.clone()))
                .timeout(Duration::from_secs(20));
            match task_client.sync_once(settings).await {
                Ok(response) => {
                    sync_failures = 0;
                    if failure.swap(false, Ordering::SeqCst) {
                        inbound_failures = inbound_failures.saturating_add(1);
                        if inbound_failures >= 8 {
                            emit_status(&task_out, &task_config.agent_id, "error", Some("Inbound delivery failed repeatedly; reconnect after correcting the reported error".to_string()));
                            break;
                        }
                        tokio::time::sleep(Duration::from_secs(
                            (1u64 << inbound_failures.min(5)).min(30),
                        ))
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
                    inbound_failures = 0;
                    emit_status(&task_out, &task_config.agent_id, "running", None);
                }
                Err(error) => {
                    let text = error.to_string();
                    let Some(delay) = sync_retry_delay(&text, &mut sync_failures) else {
                        emit_status(
                            &task_out,
                            &task_config.agent_id,
                            "error",
                            Some(format!("Matrix synchronization failed: {text}")),
                        );
                        break;
                    };
                    emit_status(&task_out, &task_config.agent_id, "reconnecting", Some(text));
                    tokio::time::sleep(delay).await;
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

fn requested_thread(request: &Value) -> Result<Option<Thread>> {
    if request.get("thread_root_id").is_none() && request.get("reply_to_event_id").is_none() {
        return Ok(None);
    }
    let parse = |field| -> Result<OwnedEventId> {
        let id = string(request, field)?;
        if !valid_thread_event_id(id) {
            bail!("Invalid Matrix event ID in {field}");
        }
        id.parse()
            .with_context(|| format!("Invalid Matrix event ID in {field}"))
    };
    let root = parse("thread_root_id")?;
    let source = parse("reply_to_event_id")?;
    if root == source {
        bail!("A threaded reply must target a message in the thread");
    }
    Ok(Some(Thread::reply(root, source)))
}

fn sanitize_matrix_html(input: &str) -> String {
    let html = Html::parse(input);
    html.sanitize_with(&SanitizerConfig::strict().remove_reply_fallback());

    // Ruma 0.9 can skip URL validation when another attribute sorts before the URL.
    let mut nodes: Vec<_> = html.children().collect();
    while let Some(node) = nodes.pop() {
        nodes.extend(node.children());
        if let Some(element) = node.as_element() {
            element
                .attrs
                .borrow_mut()
                .retain(|attribute| match attribute.name.local.as_ref() {
                    "href" => attribute.value.split_once(':').is_some_and(|(scheme, _)| {
                        matches!(scheme, "http" | "https" | "ftp" | "mailto" | "magnet")
                    }),
                    "src" => attribute.value.starts_with("mxc://"),
                    _ => true,
                });
        }
    }
    html.to_string()
}

fn markdown_message(text: &str) -> Result<RoomMessageEventContent> {
    if text.len() > MAX_FORMATTED_MESSAGE_BYTES {
        return Ok(RoomMessageEventContent::text_plain(text));
    }

    let mut message = TextMessageEventContent::markdown(text);
    if let Some(formatted) = &mut message.formatted {
        formatted.body = sanitize_matrix_html(&formatted.body);
        if formatted.body.trim().is_empty()
            || serde_json::to_vec(&message)?.len() > MAX_FORMATTED_MESSAGE_BYTES
        {
            message.formatted = None;
        }
    }
    Ok(RoomMessageEventContent::new(MessageType::Text(message)))
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
        "validate_room" | "send_message" | "send_media" | "send_file" | "set_typing" => {
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
            if op == "set_typing" {
                let typing = request
                    .get("typing")
                    .and_then(Value::as_bool)
                    .context("Typing must be true or false")?;
                room.typing_notice(typing).await?;
                return Ok(json!({}));
            }
            let txn = string(request, "txn_id")?;
            if txn.is_empty() || txn.len() > 255 {
                bail!("A stable transaction ID is required");
            }
            let txn: OwnedTransactionId = txn.into();
            let thread = requested_thread(request)?;
            let mut content = if op == "send_message" {
                let text = string(request, "text")?;
                if request["markdown"].as_bool() == Some(true) {
                    markdown_message(text)?
                } else {
                    RoomMessageEventContent::text_plain(text)
                }
            } else {
                let media: Media = serde_json::from_value(request.clone())?;
                let (bytes, mime) = if op == "send_file" {
                    decode_file(&media)?
                } else {
                    decode_media(&media)?
                };
                let length = bytes.len();
                let mut reader = std::io::Cursor::new(bytes);
                let file = client.upload_encrypted_file(&mut reader).await?;
                // Upload precedes a fresh membership check; uploaded bytes disclose no plaintext.
                validate_room(client, &room, config, false).await?;
                if op == "send_file" {
                    let mut info = FileInfo::new();
                    info.mimetype = Some(mime.to_string());
                    info.size = Some((length as u32).into());
                    let content = FileMessageEventContent::encrypted(media.filename, file)
                        .info(Some(Box::new(info)));
                    RoomMessageEventContent::new(MessageType::File(content))
                } else {
                    let mut info = ImageInfo::new();
                    info.mimetype = Some(mime.to_string());
                    info.size = Some((length as u32).into());
                    let content = ImageMessageEventContent::encrypted(media.filename, file)
                        .info(Some(Box::new(info)));
                    RoomMessageEventContent::new(MessageType::Image(content))
                }
            };
            content.relates_to = thread.map(Relation::Thread);
            let event_id = room
                .send(content)
                .with_transaction_id(txn)
                .await?
                .response
                .event_id;
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
    fn threaded_sends_preserve_root_and_owner_reply_target() {
        let request = json!({"thread_root_id":"$root","reply_to_event_id":"$owner-message"});
        let mut message = markdown_message("**In the thread**").unwrap();
        message.relates_to = requested_thread(&request).unwrap().map(Relation::Thread);
        let message = serde_json::to_value(message).unwrap();
        assert_eq!(message["formatted_body"], "<strong>In the thread</strong>");
        assert_eq!(
            message["m.relates_to"],
            json!({
                "rel_type":"m.thread", "event_id":"$root", "m.in_reply_to":{"event_id":"$owner-message"},
            })
        );
        assert!(requested_thread(&json!({})).unwrap().is_none());
        for invalid in [
            json!({"thread_root_id":"$root"}),
            json!({"reply_to_event_id":"$owner-message"}),
            json!({"thread_root_id":null,"reply_to_event_id":"$owner-message"}),
            json!({"thread_root_id":"$","reply_to_event_id":"$owner-message"}),
            json!({"thread_root_id":"$root","reply_to_event_id":"not-an-event"}),
            json!({"thread_root_id":"$root","reply_to_event_id":"$root"}),
        ] {
            assert!(requested_thread(&invalid).is_err(), "Accepted {invalid}");
        }
    }

    #[test]
    fn thread_seed_uses_participant_root_text_with_a_utf16_limit() {
        let body = format!("{}🧵", "a".repeat(3999));
        let mut root: OriginalRoomMessageEvent = serde_json::from_value(json!({
            "type":"m.room.message", "event_id":"$root", "room_id":"!owner:example.org",
            "sender":"@owner:example.org", "origin_server_ts":123,
            "content":{"msgtype":"m.text","body":body},
        }))
        .unwrap();
        let owner = "@owner:example.org";
        let agent = "@bot:example.org";
        assert_eq!(thread_root_body(&root, owner, agent), Some(&body[..3999]));
        root.sender = "@other:example.org".parse().unwrap();
        assert_eq!(thread_root_body(&root, owner, agent), None);
        root.sender = agent.parse().unwrap();
        root.content = serde_json::from_value(json!({
            "msgtype":"m.text", "body":"> <@owner:example.org> Old quoted reply\n\nThe root text",
            "m.relates_to":{"m.in_reply_to":{"event_id":"$original"}},
        }))
        .unwrap();
        assert_eq!(thread_root_body(&root, owner, agent), Some("The root text"));
        root.content.relates_to = Some(Relation::Thread(Thread::without_fallback(
            "$ancestor".parse().unwrap(),
        )));
        assert_eq!(thread_root_body(&root, owner, agent), None);
    }

    #[test]
    fn replacements_and_malformed_threads_do_not_enter_the_main_conversation() {
        let event = |content| {
            let raw = json!({
                "type":"m.room.message", "event_id":"$event", "sender":"@owner:example.org",
                "origin_server_ts":123, "content":content,
            })
            .to_string();
            let event = serde_json::from_str::<OriginalSyncRoomMessageEvent>(&raw).unwrap();
            is_new_message(&event, &raw)
        };
        assert!(event(json!({
            "msgtype":"m.text", "body":"thread follow-up",
            "m.relates_to":{"rel_type":"m.thread","event_id":"$root"},
        })));
        assert!(!event(json!({
            "msgtype":"m.text", "body":"* edited follow-up",
            "m.relates_to":{"rel_type":"m.replace","event_id":"$original"},
            "m.new_content":{"msgtype":"m.text","body":"edited follow-up"},
        })));
        assert!(!event(json!({
            "msgtype":"m.text", "body":"invalid follow-up",
            "m.relates_to":{"rel_type":"m.thread","m.in_reply_to":{"event_id":"$original"}},
        })));
        for rel_type in ["m.thread", "m.replace"] {
            assert!(!event(json!({
                "msgtype":"m.text", "body":"invalid relation without a target",
                "m.relates_to":{"rel_type":rel_type},
            })));
        }
        assert!(event(json!({
            "msgtype":"m.text", "body":"main-conversation reply",
            "m.relates_to":{"m.in_reply_to":{"event_id":"$original"}},
        })));
    }

    #[test]
    fn markdown_uses_sanitized_matrix_html_with_original_text_as_fallback() {
        let text = "# 标题\n\n- **Bold** and [source](https://example.org)\n\n```rust\nlet x = 1;\n```\n\n<a href=\"javascript:alert(1)\" onclick=\"alert(1)\">Unsafe</a>\n\n<a class=\"link\" href=\"javascript:alert(1)\">Unsafe with class</a>\n\n![External](https://example.org/image.png)";
        let message = serde_json::to_value(markdown_message(text).unwrap()).unwrap();
        assert_eq!(message["msgtype"], "m.text");
        assert_eq!(message["body"], text);
        assert_eq!(message["format"], "org.matrix.custom.html");
        let html = message["formatted_body"].as_str().unwrap();
        for expected in [
            "<h1>标题</h1>",
            "<li><strong>Bold</strong>",
            "<a href=\"https://example.org\">source</a>",
            "<pre><code class=\"language-rust\">let x = 1;",
            "Unsafe",
        ] {
            assert!(html.contains(expected), "Missing {expected} in {html}");
        }
        for rejected in ["javascript:", "onclick=", "https://example.org/image.png"] {
            assert!(!html.contains(rejected), "Found {rejected} in {html}");
        }
    }

    #[test]
    fn plain_and_oversized_markdown_messages_keep_the_original_text() {
        let long_markdown = format!("**{}**", "字".repeat(8_000));
        for text in ["Plain text", "<!-- hidden -->", &long_markdown] {
            let message = serde_json::to_value(markdown_message(text).unwrap()).unwrap();
            assert_eq!(message, json!({"msgtype": "m.text", "body": text}));
        }
    }

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
    fn exported_files_require_safe_matching_names_and_valid_bounded_content() {
        let file = |data: &[u8], mime_type: &str, filename: &str| Media {
            data: BASE64.encode(data),
            mime_type: mime_type.into(),
            filename: filename.into(),
        };
        assert!(
            decode_file(&file(
                b"%PDF-1.4\nexport fixture\n%%EOF\n",
                "application/pdf",
                "家庭预算.pdf"
            ))
            .is_ok()
        );
        assert!(
            decode_file(&file(
                "\u{feff}\"项目\",\"金额\"\r\n\"食品\",42\r\n".as_bytes(),
                "text/csv",
                "家庭预算.csv"
            ))
            .is_ok()
        );
        for filename in [
            "../report.pdf",
            "folder/report.pdf",
            "folder\\report.pdf",
            "C:report.pdf",
            ".report.pdf",
            "report.pdf ",
            "report\n.pdf",
            "report\u{202e}.pdf",
            "",
        ] {
            assert!(decode_file(&file(b"%PDF-1.4\n%%EOF", "application/pdf", filename)).is_err());
        }
        assert!(decode_file(&file(b"%PDF-1.4\n%%EOF", "application/pdf", "report.csv")).is_err());
        assert!(
            decode_file(&file(
                b"<html>not a PDF</html>",
                "application/pdf",
                "report.pdf"
            ))
            .is_err()
        );
        assert!(
            decode_file(&file(
                b"%PDF-missing-footer",
                "application/pdf",
                "report.pdf"
            ))
            .is_err()
        );
        assert!(decode_file(&file(&[0xff, 0xfe], "text/csv", "report.csv")).is_err());
        assert!(decode_file(&file(b"a,\0b", "text/csv", "report.csv")).is_err());
        assert!(decode_file(&file(b"anything", "text/html", "report.html")).is_err());
        assert!(decode_file(&file(b"", "text/csv", "report.csv")).is_err());
        assert!(decode_file(&file(&vec![b'x'; MAX_MEDIA + 1], "text/csv", "report.csv")).is_err());
        let mut invalid = file(b"valid,csv", "text/csv", "report.csv");
        invalid.data = "Zh==".into();
        assert!(decode_file(&invalid).is_err());
        invalid.data = "bad!".into();
        assert!(decode_file(&invalid).is_err());
        // The existing avatar/image path remains image-only.
        assert!(decode_media(&file(b"%PDF-1.4\n%%EOF", "application/pdf", "report.pdf")).is_err());
    }
    #[test]
    fn documents_require_encrypted_sources_supported_formats_and_bounded_size() {
        let content = |filename: &str, mime_type: &str, size: usize| {
            serde_json::from_value::<FileMessageEventContent>(json!({
                "body": filename,
                "file": {
                    "url": "mxc://example.org/document",
                    "key": {"kty":"oct","key_ops":["encrypt","decrypt"],"alg":"A256CTR","k":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","ext":true},
                    "iv": "AAAAAAAAAAAAAAAAAAAAAA",
                    "hashes": {"sha256":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
                    "v": "v2"
                },
                "info": {"mimetype":mime_type,"size":size}
            })).unwrap()
        };
        for (filename, mime_type) in [
            ("notes.txt", "text/plain"),
            ("table.csv", "text/csv"),
            ("source.rs", "application/octet-stream"),
            ("report.pdf", "application/pdf"),
            (
                "report.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            (
                "table.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
        ] {
            assert_eq!(
                document_rejection(&content(filename, mime_type, MAX_MEDIA)),
                None
            );
        }
        let mut unencrypted = content("notes.txt", "text/plain", 3);
        unencrypted.source = MediaSource::Plain("mxc://example.org/plain".into());
        assert_eq!(
            document_rejection(&unencrypted),
            Some("Document attachments must be encrypted.")
        );
        assert_eq!(
            document_rejection(&content("notes.txt", "text/plain", MAX_MEDIA + 1)),
            Some("Documents must be no larger than 8 MiB.")
        );
        assert_eq!(
            document_rejection(&content("archive.zip", "application/zip", 3)),
            Some("Unsupported document. Send text, source code, PDF, DOCX, or XLSX.")
        );
        assert!(document_rejection(&content("", "text/plain", 3)).is_some());
        let mut captioned = content("report.pdf", "application/pdf", 3);
        captioned.body = "Summarize this report.".into();
        captioned.filename = Some("report.pdf".into());
        assert_eq!(captioned.caption(), Some("Summarize this report."));
        assert_eq!(captioned.filename(), "report.pdf");
    }
    #[test]
    fn controlled_recovery_only_for_local_corruption() {
        assert!(recoverable_store("database disk image is malformed"));
        assert!(!recoverable_store("M_FORBIDDEN: invalid password"));
        assert!(!recoverable_store("Network connection timed out"));
    }
    #[test]
    fn sync_keeps_retrying_temporary_outages_with_bounded_backoff() {
        let mut failures = 0;
        for attempt in 1..=40 {
            let error = match attempt % 3 {
                0 => "[503 / M_UNKNOWN] Homeserver unavailable",
                1 => "error sending request: connection timed out",
                _ => "[429 / M_LIMIT_EXCEEDED] Too many requests",
            };
            let delay = sync_retry_delay(error, &mut failures)
                .expect("A temporary homeserver outage must not stop the Agent");
            assert!(delay <= Duration::from_secs(30));
            if attempt > 8 {
                assert_eq!(delay, Duration::from_secs(30));
            }
        }
        // A successful sync resets the same counter before the next outage.
        failures = 0;
        assert_eq!(
            sync_retry_delay("connection refused", &mut failures),
            Some(Duration::from_secs(2))
        );
        failures = u32::MAX;
        assert_eq!(
            sync_retry_delay("connection refused", &mut failures),
            Some(Duration::from_secs(30))
        );
        assert_eq!(failures, u32::MAX);
    }
    #[test]
    fn sync_stops_for_revoked_or_missing_authorization() {
        for error in [
            "[401 / M_UNKNOWN_TOKEN] Token revoked",
            "[401 / M_MISSING_TOKEN] Missing access token",
            "[403 / M_FORBIDDEN] Access denied",
        ] {
            let mut failures = 0;
            assert_eq!(sync_retry_delay(error, &mut failures), None);
        }
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
    async fn file_and_typing_commands_cannot_run_without_an_active_agent() {
        let accounts: Accounts = Arc::new(Mutex::new(HashMap::new()));
        let (out, _) = mpsc::channel(8);
        for op in ["send_file", "set_typing"] {
            let result = command(&json!({"v":1,"op":op,"agent_id":"stopped","room_id":"!owner:example.org","typing":true,"txn_id":"stable"}), &accounts, &out).await;
            assert!(result.unwrap_err().to_string().contains("Agent is stopped"));
        }
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
