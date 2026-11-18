//! SSH backend on top of russh (pure Rust, no OpenSSL).
//!
//! One `Conn` per session holds the authenticated transport. The interactive shell,
//! SFTP and local port forwards are all channels multiplexed over it. An optional
//! jump host is connected first and the target is reached through a direct-tcpip
//! channel (like `ssh -J`).

use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::OnceCell;
use tokio::task::JoinHandle;

use super::{BackendIo, Ctrl, SessionEvent, Shared};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SshAuth {
    Password,
    Key { path: String },
    Agent,
    /// Like plain `ssh`: agent, then default keys (~/.ssh/id_*), then password.
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Forward {
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub jump: Option<Box<SshTarget>>,
    #[serde(default)]
    pub forwards: Vec<Forward>,
    /// Reach this host through a SOCKS5 / HTTP proxy (ignored when tunneling via `jump`).
    #[serde(default)]
    pub proxy: Option<crate::proxy::ProxySpec>,
}

/// Auth needs user input; carried as an error so `?` works, converted to an event.
#[derive(Debug)]
struct NeedSecret {
    kind: &'static str,
    message: String,
}
impl std::fmt::Display for NeedSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for NeedSecret {}

pub struct Handler {
    host: String,
    port: u16,
    events: Channel<SessionEvent>,
    shared: Arc<Shared>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            let _ = self.events.send(SessionEvent::Error {
                message: "SSH host certificates are not supported yet".into(),
            });
            return Ok(false);
        };

        match russh::keys::check_known_hosts(&self.host, self.port, key) {
            Ok(true) => return Ok(true),
            Err(russh::keys::Error::KeyChanged { line }) => {
                let _ = self.events.send(SessionEvent::Error {
                    message: format!(
                        "HOST KEY CHANGED for {}:{} (known_hosts line {line}). \
                         Possible man-in-the-middle attack — connection refused.",
                        self.host, self.port
                    ),
                });
                return Ok(false);
            }
            // Unknown host (or no known_hosts file yet): ask the user.
            _ => {}
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        *self.shared.host_key_reply.lock() = Some(tx);
        let _ = self.events.send(SessionEvent::HostKeyPrompt {
            host: self.host.clone(),
            port: self.port,
            key_type: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        });

        let accepted = matches!(tokio::time::timeout(Duration::from_secs(300), rx).await, Ok(Ok(true)));
        if accepted {
            if let Err(e) = russh::keys::known_hosts::learn_known_hosts(&self.host, self.port, key) {
                let _ = self.events.send(SessionEvent::Error {
                    message: format!("could not write known_hosts: {e}"),
                });
            }
        }
        Ok(accepted)
    }
}

/// An authenticated SSH transport.
pub struct Conn {
    pub handle: client::Handle<Handler>,
    /// Keeps the jump-host transport alive for as long as we tunnel through it.
    _jump: Option<Box<Conn>>,
    sftp: OnceCell<Arc<SftpSession>>,
    forwards: parking_lot::Mutex<Vec<JoinHandle<()>>>,
    /// Forwards added while connected (Ports panel), by local port.
    runtime_forwards: parking_lot::Mutex<std::collections::HashMap<u16, JoinHandle<()>>>,
}

impl Conn {
    /// Run a command on its own channel and collect stdout (stderr discarded).
    pub async fn exec(&self, command: &str) -> anyhow::Result<String> {
        Ok(self.exec_full(command, Duration::from_secs(15)).await?.1)
    }

    /// Run a one-off command: (exit code, stdout, stderr). -1 if the server sent no status.
    pub async fn exec_full(&self, command: &str, timeout: Duration) -> anyhow::Result<(i32, String, String)> {
        let mut ch = self.handle.channel_open_session().await?;
        ch.exec(true, command).await?;
        let (mut out, mut err, mut code) = (Vec::new(), Vec::new(), -1i32);
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            match tokio::time::timeout_at(deadline, ch.wait()).await {
                Ok(Some(russh::ChannelMsg::Data { data })) => out.extend_from_slice(&data),
                Ok(Some(russh::ChannelMsg::ExtendedData { data, .. })) => err.extend_from_slice(&data),
                Ok(Some(russh::ChannelMsg::ExitStatus { exit_status })) => code = exit_status as i32,
                Ok(Some(russh::ChannelMsg::Close)) | Ok(None) => break,
                Ok(Some(_)) => {}
                Err(_) => anyhow::bail!("remote command timed out"),
            }
        }
        let _ = ch.close().await;
        Ok((code, String::from_utf8_lossy(&out).into_owned(), String::from_utf8_lossy(&err).into_owned()))
    }

    /// Start a local forward now (127.0.0.1:local_port → remote_host:remote_port over SSH).
    /// `local_port` 0 picks a free port. Returns the bound local port.
    pub async fn add_forward(self: &Arc<Self>, local_port: u16, remote_host: String, remote_port: u16) -> anyhow::Result<u16> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port)).await?;
        let port = listener.local_addr()?.port();
        let fwd = Forward { local_port: port, remote_host, remote_port };
        let task = tokio::spawn(serve_forward(listener, Arc::downgrade(self), fwd));
        if let Some(old) = self.runtime_forwards.lock().insert(port, task) {
            old.abort();
        }
        Ok(port)
    }

    /// Round trip of an SSH global request (keepalive with reply), in milliseconds.
    pub async fn ping(&self) -> anyhow::Result<f64> {
        let t = std::time::Instant::now();
        tokio::time::timeout(Duration::from_secs(10), self.handle.send_ping())
            .await
            .map_err(|_| anyhow::anyhow!("no reply from server"))??;
        Ok(t.elapsed().as_secs_f64() * 1000.0)
    }

    pub fn stop_forward(&self, local_port: u16) -> bool {
        self.runtime_forwards.lock().remove(&local_port).map(|t| t.abort()).is_some()
    }

    pub async fn sftp(&self) -> anyhow::Result<Arc<SftpSession>> {
        self.sftp
            .get_or_try_init(|| async {
                let channel = self.handle.channel_open_session().await?;
                channel.request_subsystem(true, "sftp").await?;
                let sftp = SftpSession::new(channel.into_stream()).await?;
                Ok::<_, anyhow::Error>(Arc::new(sftp))
            })
            .await
            .cloned()
    }

    fn start_forward(self: &Arc<Self>, fwd: Forward, events: Channel<SessionEvent>) {
        let conn = Arc::downgrade(self);
        let task = tokio::spawn(async move {
            let listener = match tokio::net::TcpListener::bind(("127.0.0.1", fwd.local_port)).await {
                Ok(l) => l,
                Err(e) => {
                    let _ = events.send(SessionEvent::Error {
                        message: format!("port forward 127.0.0.1:{} failed: {e}", fwd.local_port),
                    });
                    return;
                }
            };
            serve_forward(listener, conn, fwd).await;
        });
        self.forwards.lock().push(task);
    }
}

async fn serve_forward(listener: tokio::net::TcpListener, conn: std::sync::Weak<Conn>, fwd: Forward) {
    loop {
        let Ok((mut sock, peer)) = listener.accept().await else { break };
        let Some(conn) = conn.upgrade() else { break };
        let fwd = fwd.clone();
        tokio::spawn(async move {
            let ch = conn
                .handle
                .channel_open_direct_tcpip(fwd.remote_host, fwd.remote_port as u32, peer.ip().to_string(), peer.port() as u32)
                .await;
            if let Ok(ch) = ch {
                let mut stream = ch.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
            }
        });
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        for t in self.forwards.lock().drain(..) {
            t.abort();
        }
        for (_, t) in self.runtime_forwards.lock().drain() {
            t.abort();
        }
    }
}

pub fn spawn(
    target: SshTarget,
    secret: Option<String>,
    jump_secret: Option<String>,
    cols: u16,
    rows: u16,
    io: BackendIo,
) {
    tauri::async_runtime::spawn(async move {
        let events = io.events.clone();
        let out = io.out.clone();
        let shared = io.shared.clone();
        if let Err(e) = run(target, secret, jump_secret, cols, rows, io).await {
            let ev = match e.downcast_ref::<NeedSecret>() {
                Some(n) => SessionEvent::SecretRequired { kind: n.kind.into(), message: n.message.clone() },
                None => SessionEvent::Error { message: format!("{e:#}") },
            };
            let _ = events.send(ev);
        }
        *shared.ssh.lock() = None;
        drop(out);
    });
}

fn config() -> Arc<client::Config> {
    Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    })
}

async fn connect(
    target: &SshTarget,
    secret: Option<String>,
    jump_secret: Option<String>,
    events: &Channel<SessionEvent>,
    shared: &Arc<Shared>,
) -> anyhow::Result<Conn> {
    let handler = Handler {
        host: target.host.clone(),
        port: target.port,
        events: events.clone(),
        shared: shared.clone(),
    };

    let (mut session, jump) = if let Some(jump) = &target.jump {
        let jump_conn = Box::pin(connect(jump, jump_secret, None, events, shared))
            .await
            .map_err(|e| match e.downcast::<NeedSecret>() {
                Ok(n) => anyhow::Error::new(NeedSecret {
                    kind: if n.kind == "password" { "jumpPassword" } else { "jumpPassphrase" },
                    message: format!("jump host {}: {}", jump.host, n.message),
                }),
                Err(e) => e.context(format!("jump host {}", jump.host)),
            })?;
        let ch = jump_conn
            .handle
            .channel_open_direct_tcpip(target.host.clone(), target.port as u32, "127.0.0.1", 0)
            .await?;
        let session = client::connect_stream(config(), ch.into_stream(), handler).await?;
        (session, Some(Box::new(jump_conn)))
    } else {
        let stream = crate::proxy::connect(target.proxy.as_ref(), &target.host, target.port).await?;
        stream.set_nodelay(true)?;
        (client::connect_stream(config(), stream, handler).await?, None)
    };

    authenticate(&mut session, target, secret).await?;
    Ok(Conn { handle: session, _jump: jump, sftp: OnceCell::new(), forwards: Default::default(), runtime_forwards: Default::default() })
}

async fn authenticate(
    session: &mut client::Handle<Handler>,
    target: &SshTarget,
    secret: Option<String>,
) -> anyhow::Result<()> {
    let user = &target.user;
    let ok = match &target.auth {
        SshAuth::Password => {
            let Some(pw) = secret else {
                return Err(NeedSecret { kind: "password", message: "Password required".into() }.into());
            };
            let mut ok = session.authenticate_password(user, &pw).await?.success();
            if !ok {
                // Many servers only enable keyboard-interactive; answer every prompt with the password.
                ok = keyboard_interactive(session, user, &pw).await.unwrap_or(false);
            }
            if !ok {
                return Err(NeedSecret { kind: "password", message: "Wrong password, try again".into() }.into());
            }
            true
        }
        SshAuth::Key { path } => {
            let path = expand_home(path);
            let key = match russh::keys::load_secret_key(&path, secret.as_deref()) {
                Ok(k) => k,
                Err(russh::keys::Error::KeyIsEncrypted) => {
                    return Err(NeedSecret { kind: "passphrase", message: "Key passphrase required".into() }.into());
                }
                Err(e) if secret.is_some() && e.to_string().to_lowercase().contains("decrypt") => {
                    return Err(NeedSecret { kind: "passphrase", message: "Wrong passphrase, try again".into() }.into());
                }
                Err(e) => anyhow::bail!("failed to load key {path}: {e}"),
            };
            let hash = session.best_supported_rsa_hash().await?.flatten();
            session
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
                .success()
        }
        SshAuth::Agent => agent_auth(session, user).await?,
        SshAuth::Auto => match secret {
            // A password was supplied (after we asked): use it.
            Some(pw) => {
                let mut ok = session.authenticate_password(user, &pw).await?.success();
                if !ok {
                    ok = keyboard_interactive(session, user, &pw).await.unwrap_or(false);
                }
                if !ok {
                    return Err(NeedSecret { kind: "password", message: "Wrong password, try again".into() }.into());
                }
                true
            }
            None => {
                let ok = agent_auth(session, user).await.unwrap_or(false)
                    || default_keys_auth(session, user).await;
                if !ok {
                    return Err(NeedSecret { kind: "password", message: "Password required".into() }.into());
                }
                true
            }
        },
    };
    if !ok {
        anyhow::bail!("authentication failed for {}@{}", user, target.host);
    }
    Ok(())
}

/// Try the usual unencrypted keys in ~/.ssh (encrypted ones are skipped silently).
async fn default_keys_auth(session: &mut client::Handle<Handler>, user: &str) -> bool {
    let Some(dir) = dirs::home_dir().map(|h| h.join(".ssh")) else { return false };
    let hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        let path = dir.join(name);
        if !path.exists() {
            continue;
        }
        let Ok(key) = russh::keys::load_secret_key(&path, None) else { continue };
        if let Ok(r) = session
            .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
        {
            if r.success() {
                return true;
            }
        }
    }
    false
}

async fn keyboard_interactive(
    session: &mut client::Handle<Handler>,
    user: &str,
    password: &str,
) -> anyhow::Result<bool> {
    use russh::client::KeyboardInteractiveAuthResponse as R;
    let mut resp = session.authenticate_keyboard_interactive_start(user, None).await?;
    for _ in 0..4 {
        match resp {
            R::Success => return Ok(true),
            R::Failure { .. } => return Ok(false),
            R::InfoRequest { prompts, .. } => {
                let answers = prompts.iter().map(|_| password.to_string()).collect();
                resp = session.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Ok(false)
}

async fn agent_auth(session: &mut client::Handle<Handler>, user: &str) -> anyhow::Result<bool> {
    use russh::keys::agent::AgentIdentity;
    use russh::keys::agent::client::AgentClient;

    #[cfg(windows)]
    let mut agent = match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(a) => a.dynamic(),
        Err(_) => AgentClient::connect_pageant()
            .await
            .map_err(|e| anyhow::anyhow!("no SSH agent (OpenSSH agent or Pageant) available: {e}"))?
            .dynamic(),
    };
    #[cfg(not(windows))]
    let mut agent = AgentClient::connect_env()
        .await
        .map_err(|e| anyhow::anyhow!("no SSH agent available (SSH_AUTH_SOCK): {e}"))?
        .dynamic();

    let ids = agent.request_identities().await?;
    if ids.is_empty() {
        anyhow::bail!("SSH agent has no keys loaded");
    }
    let hash = session.best_supported_rsa_hash().await?.flatten();
    for id in ids {
        let AgentIdentity::PublicKey { key, .. } = id else { continue };
        if let Ok(r) = session.authenticate_publickey_with(user, key, hash, &mut agent).await {
            if r.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

async fn run(
    target: SshTarget,
    secret: Option<String>,
    jump_secret: Option<String>,
    cols: u16,
    rows: u16,
    io: BackendIo,
) -> anyhow::Result<()> {
    let BackendIo { out, mut ctrl_rx, events, shared, .. } = io;
    let _ = events.send(SessionEvent::Connecting);

    let conn = Arc::new(connect(&target, secret, jump_secret, &events, &shared).await?);
    for f in &target.forwards {
        conn.start_forward(f.clone(), events.clone());
    }
    *shared.ssh.lock() = Some(conn.clone());

    let channel = conn.handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await?;
    channel.request_shell(false).await?;
    let _ = events.send(SessionEvent::Connected);

    let (mut read, write) = channel.split();
    loop {
        tokio::select! {
            msg = ctrl_rx.recv() => match msg {
                Some(Ctrl::Write(data)) => write.data_bytes(data).await?,
                Some(Ctrl::Resize { cols, rows }) => {
                    write.window_change(cols as u32, rows as u32, 0, 0).await?
                }
                Some(Ctrl::Close) | Some(Ctrl::ChildExited) | None => break,
            },
            msg = read.wait() => match msg {
                Some(russh::ChannelMsg::Data { data }) => {
                    if out.send(data.to_vec()).await.is_err() { break; }
                }
                Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                    if out.send(data.to_vec()).await.is_err() { break; }
                }
                Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                    *shared.exit_code.lock() = Some(exit_status as i32);
                }
                Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }

    *shared.ssh.lock() = None;
    let _ = conn
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await;
    Ok(())
}

pub fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}{}", home.display(), rest);
        }
    }
    path.to_string()
}
