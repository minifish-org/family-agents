#![recursion_limit = "512"]
//! Disposable live-test Matrix client. Never use this as the application gateway.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use matrix_sdk::{
    Client, Room, RoomState,
    authentication::matrix::MatrixSession,
    config::{RequestConfig, SyncSettings},
    deserialized_responses::EncryptionInfo,
    encryption::EncryptionSettings,
    ruma::{
        OwnedRoomId, OwnedUserId,
        api::client::room::create_room,
        events::room::message::{
            ImageMessageEventContent, MessageType, OriginalSyncRoomMessageEvent,
            RoomMessageEventContent,
        },
    },
    store::RoomLoadSettings,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::HashSet, path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, mpsc},
};

#[derive(Deserialize)]
struct Config {
    homeserver: String,
    matrix_id: String,
    password: String,
    store_path: PathBuf,
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("Missing {key}"))
}

async fn command(
    client: &Client,
    request: &Value,
    watched: &Arc<Mutex<HashSet<String>>>,
) -> Result<Value> {
    match string(request, "op")? {
        "create_dm" => {
            let mut create = create_room::v3::Request::new();
            create.is_direct = request["direct"].as_bool().unwrap_or(true);
            create.preset = Some(create_room::v3::RoomPreset::PrivateChat);
            create.name = Some("Family Agents validation".to_string());
            create.invite = request["invite"]
                .as_array()
                .context("Missing invite list")?
                .iter()
                .map(|id| {
                    id.as_str()
                        .context("Invalid invite ID")?
                        .parse::<OwnedUserId>()
                        .map_err(Into::into)
                })
                .collect::<Result<Vec<_>>>()?;
            create.initial_state = vec![serde_json::from_value(
                json!({"type":"m.room.encryption","state_key":"","content":{"algorithm":"m.megolm.v1.aes-sha2"}}),
            )?];
            let room = client.create_room(create).await?;
            watched.lock().await.insert(room.room_id().to_string());
            if request["direct"].as_bool().unwrap_or(true) {
                room.set_is_direct(true).await?;
            }
            Ok(json!({"room_id":room.room_id()}))
        }
        "watch" => {
            watched
                .lock()
                .await
                .insert(string(request, "room_id")?.to_string());
            Ok(json!({}))
        }
        "send_message" | "send_image" | "invite" | "join" | "leave" | "members" => {
            let id: OwnedRoomId = string(request, "room_id")?.parse()?;
            let room = client.get_room(&id).context("Unknown room")?;
            match request["op"].as_str().unwrap() {
                "join" => {
                    watched.lock().await.insert(room.room_id().to_string());
                    room.join().await?;
                    Ok(json!({}))
                }
                "leave" => {
                    room.leave().await?;
                    Ok(json!({}))
                }
                "invite" => {
                    room.invite_user_by_id(&string(request, "matrix_id")?.parse::<OwnedUserId>()?)
                        .await?;
                    Ok(json!({}))
                }
                "members" => Ok(
                    json!({"state":format!("{:?}",room.state()),"members":room.members(matrix_sdk::RoomMemberships::ACTIVE).await?.iter().map(|member|member.user_id().to_string()).collect::<Vec<_>>()}),
                ),
                "send_image" => {
                    let data = BASE64.decode(string(request, "data")?)?;
                    let mut reader = std::io::Cursor::new(data);
                    let file = client.upload_encrypted_file(&mut reader).await?;
                    let mut image = ImageMessageEventContent::encrypted(
                        request["text"].as_str().unwrap_or("probe.png").to_string(),
                        file,
                    );
                    if request["text"].as_str().is_some() {
                        image.filename = Some("probe.png".to_string());
                    }
                    let mut info = matrix_sdk::ruma::events::room::ImageInfo::new();
                    info.mimetype = Some(string(request, "mime_type")?.to_string());
                    image.info = Some(Box::new(info));
                    let response = room
                        .send(RoomMessageEventContent::new(MessageType::Image(image)))
                        .await?;
                    Ok(
                        json!({"event_id":response.response.event_id,"encrypted":response.encryption_info.is_some()}),
                    )
                }
                _ => {
                    let response = room
                        .send(RoomMessageEventContent::text_plain(string(
                            request, "text",
                        )?))
                        .await?;
                    Ok(
                        json!({"event_id":response.response.event_id,"encrypted":response.encryption_info.is_some()}),
                    )
                }
            }
        }
        "status" => Ok(
            json!({"device_id":client.device_id(),"matrix_id":client.user_id(),"rooms":client.rooms().iter().map(|room|json!({"room_id":room.room_id(),"state":format!("{:?}",room.state())})).collect::<Vec<_>>()}),
        ),
        _ => bail!("Unknown operation"),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("Usage: matrix-probe PRIVATE_CONFIG_FILE")?;
    let config: Config = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    tokio::fs::create_dir_all(&config.store_path).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&config.store_path, std::fs::Permissions::from_mode(0o700))
            .await?;
    }
    let client = Client::builder()
        .homeserver_url(&config.homeserver)
        .sqlite_store(config.store_path.join("sqlite"), None)
        .request_config(
            RequestConfig::new()
                .disable_retry()
                .timeout(Duration::from_secs(40)),
        )
        .with_encryption_settings(EncryptionSettings {
            auto_enable_cross_signing: true,
            ..Default::default()
        })
        .build()
        .await?;
    let session_path = config.store_path.join("session.json");
    if let Ok(bytes) = tokio::fs::read(&session_path).await {
        let session: MatrixSession = serde_json::from_slice(&bytes)?;
        client
            .matrix_auth()
            .restore_session(session, RoomLoadSettings::default())
            .await?;
    } else {
        client
            .matrix_auth()
            .login_username(&config.matrix_id, &config.password)
            .initial_device_display_name("Family Agents validation")
            .send()
            .await?;
        let session = client
            .matrix_auth()
            .session()
            .context("Login did not produce a session")?;
        let mut options = tokio::fs::OpenOptions::new();
        options.create(true).truncate(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&session_path).await?;
        file.write_all(&serde_json::to_vec(&session)?).await?;
        file.sync_all().await?;
    }
    let (out, mut incoming) = mpsc::channel::<Value>(128);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(value) = incoming.recv().await {
            let mut bytes = serde_json::to_vec(&value)?;
            bytes.push(b'\n');
            stdout.write_all(&bytes).await?;
            stdout.flush().await?;
        }
        Ok::<(), anyhow::Error>(())
    });
    let watched = Arc::new(Mutex::new(HashSet::<String>::new()));
    let watch_messages = watched.clone();
    let messages = out.clone();
    client.add_event_handler(move |event:OriginalSyncRoomMessageEvent,room:Room,encryption:Option<EncryptionInfo>| {
        let out=messages.clone();
        let watched=watch_messages.clone();
        async move {
            if !watched.lock().await.contains(room.room_id().as_str()) {return;}
            let mut message=json!({"event":"message","room_id":room.room_id(),"event_id":event.event_id,"sender":event.sender,"body":event.content.body(),"encrypted":encryption.is_some()});
            if let MessageType::Image(image)=&event.content.msgtype {
                match room.client().media().get_file(image,false).await {
                    Ok(Some(data)) => {
                        message["media"]=json!({"data":BASE64.encode(data),"mime_type":image.info.as_ref().and_then(|info|info.mimetype.clone()).unwrap_or_else(||"image/png".to_string()),"encrypted":matches!(image.source,matrix_sdk::ruma::events::room::MediaSource::Encrypted(_))});
                    },
                    Ok(None) => message["media_error"]=json!("Image has no media source"),
                    Err(error) => message["media_error"]=json!(error.to_string()),
                }
            }
            let _=out.send(message).await;
        }
    });
    let invites = out.clone();
    client.add_event_handler(move |event:matrix_sdk::ruma::events::room::member::StrippedRoomMemberEvent,room:Room| {let out=invites.clone();async move {if room.state()==RoomState::Invited && event.state_key.as_str()==room.own_user_id().as_str() {let _=out.send(json!({"event":"invite","room_id":room.room_id(),"sender":event.sender})).await;}}});
    client
        .sync_once(SyncSettings::new().timeout(Duration::from_millis(0)))
        .await?;
    out.send(json!({"event":"ready","matrix_id":client.user_id(),"device_id":client.device_id()}))
        .await?;
    let sync_client = client.clone();
    let sync = tokio::spawn(async move {
        sync_client
            .sync(SyncSettings::new().timeout(Duration::from_secs(20)))
            .await
    });
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let request: Value = serde_json::from_str(&line)?;
        if request["op"] == "shutdown" {
            break;
        }
        let response = match command(&client, &request, &watched).await {
            Ok(result) => json!({"id":request["id"],"ok":true,"result":result}),
            Err(error) => json!({"id":request["id"],"ok":false,"error":error.to_string()}),
        };
        out.send(response).await?;
    }
    sync.abort();
    let _ = sync.await;
    drop(client);
    drop(out);
    writer.abort();
    let _ = writer.await;
    Ok(())
}
