//! Experimental playback through a paired Spotify web-player tab.
//!
//! Audio and Spotify authentication stay in the browser. The native messaging
//! companion relays only validated commands and public playback state over an
//! authenticated loopback socket. A Free account never enters librespot.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::api::models::ArtistRef;
use crate::player::{LocalState, LocalTrack, Playback, PlayerCommand, RepeatMode};

const MAX_MESSAGE: usize = 64 * 1024;
const MAX_QUEUE: usize = 128;
// A command may navigate the tab and wait for its controls for up to 20s.
const TAB_TIMEOUT: Duration = Duration::from_secs(30);
static TICKET_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BrowserCommand {
    pub id: u64,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
}

fn spotify_uri(uri: &str) -> bool {
    let fields: Vec<_> = uri.split(':').collect();
    fields.len() == 3
        && fields[0] == "spotify"
        && matches!(
            fields[1],
            "track" | "episode" | "album" | "playlist" | "artist"
        )
        && fields[2].len() == 22
        && fields[2].bytes().all(|byte| byte.is_ascii_alphanumeric())
}

fn translate(command: PlayerCommand) -> Result<(String, Option<serde_json::Value>)> {
    use serde_json::json;
    let translated = match command {
        PlayerCommand::Toggle => ("toggle", None),
        PlayerCommand::Next => ("next", None),
        PlayerCommand::Previous => ("previous", None),
        PlayerCommand::Seek(ms) => ("seek", Some(json!(ms))),
        PlayerCommand::Volume(value) | PlayerCommand::VolumePreview(value) => (
            "volume",
            Some(json!(f64::from(value) / f64::from(u16::MAX))),
        ),
        PlayerCommand::Shuffle(value) => ("shuffle", Some(json!(value))),
        PlayerCommand::Repeat(value) => ("repeat", Some(json!(value.api_name()))),
        PlayerCommand::AddToQueue(uri) => {
            if !spotify_uri(&uri) {
                bail!("This item is not a supported Spotify URI");
            }
            ("queue", Some(json!(uri)))
        }
        PlayerCommand::Load(spec) => {
            if !spec.play {
                bail!("Selecting a new item while paused is not supported by browser playback");
            }
            let uri = spec
                .offset_uri
                .as_ref()
                .or_else(|| spec.uris.get(spec.offset_index.unwrap_or(0) as usize))
                .or(spec.context_uri.as_ref());
            let Some(uri) = uri.filter(|uri| spotify_uri(uri)) else {
                bail!("This item is not supported by browser playback");
            };
            // Explicit track rows are always played directly. Whole contexts
            // retain Spotify's own queue rather than replacing it with a prefix.
            (
                "load",
                Some(json!({"uri": uri, "play": spec.play,
                "position_ms": spec.position_ms, "shuffle": spec.shuffle,
                "repeat": spec.repeat.map(|mode| mode.api_name())})),
            )
        }
        PlayerCommand::Transfer => {
            bail!("Spotify Connect transfer is not supported by browser playback")
        }
        PlayerCommand::ClearQueue => bail!("Clearing the web-player queue is not supported yet"),
    };
    Ok((translated.0.into(), translated.1))
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserState {
    pub account_id: String,
    pub logged_in: bool,
    pub playing: bool,
    pub uri: Option<String>,
    pub title: String,
    pub artists: Vec<String>,
    pub position_ms: u32,
    pub duration_ms: u32,
    pub volume: f64,
    pub shuffle: bool,
    pub repeat: String,
    pub advertisement: bool,
}

impl BrowserState {
    fn local(&self, previous: &LocalState) -> LocalState {
        let track = self
            .uri
            .as_ref()
            .filter(|uri| spotify_uri(uri))
            .map(|uri| LocalTrack {
                uri: uri.clone(),
                title: self.title.clone(),
                artists: self
                    .artists
                    .iter()
                    .map(|name| ArtistRef {
                        name: name.clone(),
                        ..ArtistRef::default()
                    })
                    .collect(),
                duration_ms: self.duration_ms,
                is_episode: uri.starts_with("spotify:episode:"),
                ..LocalTrack::default()
            });
        let changed = previous.track.as_ref().map(|track| &track.uri)
            != track.as_ref().map(|track| &track.uri);
        LocalState {
            connected: self.logged_in,
            username: self.account_id.clone(),
            playback: if self.advertisement || track.is_none() {
                Playback::Stopped
            } else if self.playing {
                Playback::Playing
            } else {
                Playback::Paused
            },
            track,
            position_ms: self.position_ms.min(self.duration_ms),
            position_at: (self.playing && !self.advertisement).then(Instant::now),
            volume: (self.volume.clamp(0.0, 1.0) * f64::from(u16::MAX)).round() as u16,
            shuffle: self.shuffle,
            repeat: RepeatMode::from_api(&self.repeat),
            track_sequence: previous.track_sequence + u64::from(changed),
            seek_sequence: previous.seek_sequence
                + u64::from(!changed && previous.position_now().abs_diff(self.position_ms) > 2000),
            ..LocalState::default()
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Poll {
    token: String,
    ack: u64,
    state: BrowserState,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize)]
struct Reply {
    commands: Vec<BrowserCommand>,
    acknowledged: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Shared {
    token: String,
    expected_account: String,
    queue: VecDeque<BrowserCommand>,
    sequence: u64,
    acknowledged: u64,
    last_seen: Option<Instant>,
    local: LocalState,
}

impl Shared {
    fn poll(&mut self, poll: Poll) -> Result<(Reply, LocalState)> {
        // Reject before changing liveness, state or the command queue.
        if !same_secret(&self.token, &poll.token) {
            bail!("Unpaired browser companion");
        }
        if !poll.state.logged_in || poll.state.account_id != self.expected_account {
            self.last_seen = None;
            self.queue.clear();
            self.local = LocalState::default();
            return Ok((
                Reply {
                    commands: vec![],
                    acknowledged: self.acknowledged,
                    error: Some(
                        "Sign in to the same Spotify account in the paired browser tab".into(),
                    ),
                },
                self.local.clone(),
            ));
        }
        if poll.ack > self.sequence || poll.ack < self.acknowledged {
            bail!("Invalid command acknowledgement");
        }
        self.acknowledged = poll.ack;
        while self
            .queue
            .front()
            .is_some_and(|command| command.id <= poll.ack)
        {
            self.queue.pop_front();
        }
        self.last_seen = Some(Instant::now());
        self.local = poll.state.local(&self.local);
        self.local.error = poll.error.map(|_| {
            "The browser could not complete a playback command. Check the paired tab.".into()
        });
        Ok((
            Reply {
                commands: self.queue.front().cloned().into_iter().collect(),
                acknowledged: self.acknowledged,
                error: None,
            },
            self.local.clone(),
        ))
    }
}

fn same_secret(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// Owns the listener task and its private discovery ticket. Dropping it closes
/// the session and removes the ticket; no Spotify credentials are stored here.
pub struct BrowserPlayer {
    shared: Arc<Mutex<Shared>>,
    task: tokio::task::JoinHandle<()>,
    ticket: PathBuf,
    ticket_token: String,
}

impl BrowserPlayer {
    pub async fn start(
        state_dir: &std::path::Path,
        account: String,
        notify: Arc<dyn Fn(LocalState) + Send + Sync>,
    ) -> Result<Self> {
        use rand::distr::{Alphanumeric, SampleString};
        let token = Alphanumeric.sample_string(&mut rand::rng(), 64);
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let port = listener.local_addr()?.port();
        std::fs::create_dir_all(state_dir)?;
        let ticket = state_dir.join("browser-player.json");
        let suffix = Alphanumeric.sample_string(&mut rand::rng(), 12);
        let temporary = state_dir.join(format!(
            "browser-player-{}-{suffix}.tmp",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let result = (|| -> Result<()> {
            let _guard = TICKET_LOCK.lock().unwrap();
            use std::io::Write;
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(
                &serde_json::json!({"port":port,"token":token}),
            )?)?;
            file.sync_all()?;
            std::fs::rename(&temporary, &ticket)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        result?;
        let ticket_token = token.clone();
        let shared = Arc::new(Mutex::new(Shared {
            token,
            expected_account: account,
            queue: VecDeque::new(),
            sequence: 0,
            acknowledged: 0,
            last_seen: None,
            local: LocalState::default(),
        }));
        let session = shared.clone();
        let task = tokio::spawn(async move {
            let mut health = tokio::time::interval(Duration::from_secs(2));
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break; };
                        // Process one bounded request at a time. No uncontrolled
                        // task spawning and no unauthenticated idle connections.
                        let read = async {
                            let mut reader = tokio::io::BufReader::new(&mut socket);
                            let mut bytes = Vec::new();
                            loop {
                                let buffer = reader.fill_buf().await?;
                                if buffer.is_empty() { break; }
                                let take = buffer.iter().position(|byte| *byte == b'\n').map_or(buffer.len(), |at| at + 1);
                                if bytes.len() + take > MAX_MESSAGE {
                                    return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "oversized request"));
                                }
                                bytes.extend_from_slice(&buffer[..take]);
                                let finished = bytes.last() == Some(&b'\n');
                                reader.consume(take);
                                if finished { break; }
                            }
                            Ok(bytes)
                        };
                        let Ok(Ok(bytes)) = tokio::time::timeout(Duration::from_secs(2), read).await else { continue; };
                        let result = serde_json::from_slice::<Poll>(&bytes).map_err(anyhow::Error::from)
                            .and_then(|poll| session.lock().unwrap().poll(poll));
                        let reply = match result {
                            Ok((reply, state)) => { notify(state); reply }
                            Err(_) => Reply { commands: vec![], acknowledged: session.lock().unwrap().acknowledged,
                                error: Some("Pair the browser tab with the same signed-in account".into()) },
                        };
                        if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                            bytes.push(b'\n');
                            let _ = tokio::time::timeout(Duration::from_secs(2), socket.write_all(&bytes)).await;
                        }
                    }
                    _ = health.tick() => {
                        let expired = {
                            let mut state = session.lock().unwrap();
                            if state.last_seen.is_some_and(|at| at.elapsed() > TAB_TIMEOUT) {
                                state.last_seen = None;
                                state.queue.clear();
                                state.local = LocalState { error: Some("The paired browser tab disconnected".into()), ..LocalState::default() };
                                Some(state.local.clone())
                            } else { None }
                        };
                        if let Some(state) = expired { notify(state); }
                    }
                }
            }
        });
        Ok(Self {
            shared,
            task,
            ticket,
            ticket_token,
        })
    }

    pub fn command(&self, command: PlayerCommand) -> Result<()> {
        let (action, value) = translate(command)?;
        let mut state = self.shared.lock().unwrap();
        if !state
            .last_seen
            .is_some_and(|at| at.elapsed() <= TAB_TIMEOUT)
        {
            bail!("Open Spotify in the paired browser and connect the Spotifast companion");
        }
        if state.queue.len() >= MAX_QUEUE {
            bail!("The browser playback queue is busy");
        }
        state.sequence += 1;
        let id = state.sequence;
        state.queue.push_back(BrowserCommand { id, action, value });
        Ok(())
    }
}

impl Drop for BrowserPlayer {
    fn drop(&mut self) {
        self.task.abort();
        let _guard = TICKET_LOCK.lock().unwrap();
        let owned = std::fs::read(&self.ticket)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|ticket| ticket["token"].as_str() == Some(self.ticket_token.as_str()));
        if owned {
            let _ = std::fs::remove_file(&self.ticket);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shared() -> Shared {
        Shared {
            token: "private".into(),
            expected_account: "owner".into(),
            queue: VecDeque::from([BrowserCommand {
                id: 1,
                action: "next".into(),
                value: None,
            }]),
            sequence: 1,
            acknowledged: 0,
            last_seen: None,
            local: LocalState::default(),
        }
    }
    fn poll(account: &str, ack: u64) -> Poll {
        Poll {
            token: "private".into(),
            ack,
            state: BrowserState {
                account_id: account.into(),
                logged_in: true,
                ..BrowserState::default()
            },
            error: None,
        }
    }
    #[test]
    fn rejects_unknown_account_and_does_not_send_commands() {
        let mut session = shared();
        let (reply, state) = session.poll(poll("another", 0)).unwrap();
        assert!(reply.error.is_some());
        assert!(!state.connected);
        assert!(session.queue.is_empty());
        assert!(session.last_seen.is_none());
    }
    #[test]
    fn authentication_failure_cannot_acknowledge_commands() {
        let mut session = shared();
        let mut request = poll("owner", 1);
        request.token = "invalid".into();
        assert!(session.poll(request).is_err());
        assert_eq!(session.queue.len(), 1);
        assert!(session.last_seen.is_none());
    }
    #[test]
    fn retains_commands_until_acknowledged_and_rejects_future_ack() {
        let mut session = shared();
        assert_eq!(session.poll(poll("owner", 0)).unwrap().0.commands.len(), 1);
        assert_eq!(session.poll(poll("owner", 0)).unwrap().0.commands.len(), 1);
        assert!(session.poll(poll("owner", 2)).is_err());
        assert!(
            session
                .poll(poll("owner", 1))
                .unwrap()
                .0
                .commands
                .is_empty()
        );
    }
    #[test]
    fn rejects_url_injection_and_preserves_explicit_track_choice() {
        assert!(translate(PlayerCommand::AddToQueue("https://evil.invalid".into())).is_err());
        let explicit = "spotify:track:0123456789abcdefghijkl";
        let (_, value) = translate(PlayerCommand::Load(crate::player::LoadSpec {
            context_uri: Some("spotify:playlist:abcdefghijkl0123456789".into()),
            offset_uri: Some(explicit.into()),
            play: true,
            ..crate::player::LoadSpec::default()
        }))
        .unwrap();
        assert_eq!(value.unwrap()["uri"], explicit);
        assert!(
            translate(PlayerCommand::Load(crate::player::LoadSpec {
                context_uri: Some(explicit.into()),
                play: false,
                ..crate::player::LoadSpec::default()
            }))
            .is_err()
        );
    }
    #[test]
    fn advertisements_are_never_reported_as_playing_music() {
        let state = BrowserState {
            logged_in: true,
            playing: true,
            advertisement: true,
            uri: Some("spotify:track:0123456789abcdefghijkl".into()),
            volume: 4.0,
            ..BrowserState::default()
        }
        .local(&LocalState::default());
        assert_eq!(state.playback, Playback::Stopped);
        assert!(state.position_at.is_none());
        assert_eq!(state.volume, u16::MAX);
    }

    #[tokio::test]
    async fn real_loopback_transport_binds_account_and_acknowledges_delivery() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".cache")
            .join(format!("bridge-test-{:016x}", rand::random::<u64>()));
        let (sent, states) = std::sync::mpsc::channel();
        let player = BrowserPlayer::start(
            &root,
            "owner".into(),
            Arc::new(move |state| {
                sent.send(state).unwrap();
            }),
        )
        .await
        .unwrap();
        let ticket: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.join("browser-player.json")).unwrap())
                .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join("browser-player.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        async fn send(ticket: &serde_json::Value, account: &str, ack: u64) -> serde_json::Value {
            let mut socket = tokio::net::TcpStream::connect((
                "127.0.0.1",
                ticket["port"].as_u64().unwrap() as u16,
            ))
            .await
            .unwrap();
            let request = serde_json::json!({"token":ticket["token"],"ack":ack,
                "state":{"account_id":account,"logged_in":true,"playing":false,
                    "uri":null,"title":"","artists":[],"position_ms":0,"duration_ms":0,
                    "volume":1.0,"shuffle":false,"repeat":"off","advertisement":false}});
            socket
                .write_all(format!("{request}\n").as_bytes())
                .await
                .unwrap();
            let mut response = String::new();
            tokio::io::BufReader::new(socket)
                .read_line(&mut response)
                .await
                .unwrap();
            serde_json::from_str(&response).unwrap()
        }
        assert!(
            send(&ticket, "owner", 0).await["commands"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(states.try_recv().unwrap().connected);
        player.command(PlayerCommand::Next).unwrap();
        let reply = send(&ticket, "owner", 0).await;
        assert_eq!(reply["commands"][0]["action"], "next");
        assert_eq!(reply["commands"][0]["id"], 1);
        assert!(
            send(&ticket, "owner", 1).await["commands"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        // A reconnected extension starts with ACK zero. The reply supplies
        // the native ACK so it can resynchronise without replaying a skip.
        let reconnect = send(&ticket, "owner", 0).await;
        assert_eq!(reconnect["acknowledged"], 1);
        assert!(reconnect["error"].is_string());
        let different = send(&ticket, "another-account", 1).await;
        assert!(different["error"].is_string());
        assert!(player.command(PlayerCommand::Next).is_err());
        drop(player);
        assert!(!root.join("browser-player.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
