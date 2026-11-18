//! Outbound proxies for SSH connections: SOCKS5 (RFC 1928/1929) and HTTP CONNECT.
//! Hand-rolled — both handshakes are a few bytes and need no extra dependencies.
//! Host names are resolved by the proxy (SOCKS5 ATYP=domain), like `ssh -o ProxyCommand=nc -X 5`.

use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxySpec {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

const TIMEOUT: Duration = Duration::from_secs(10);

/// Open a TCP stream to `host:port`, directly or through `proxy`.
pub async fn connect(proxy: Option<&ProxySpec>, host: &str, port: u16) -> anyhow::Result<TcpStream> {
    let Some(p) = proxy else {
        return tokio::time::timeout(TIMEOUT, TcpStream::connect((host, port)))
            .await
            .map_err(|_| anyhow!("connection to {host}:{port} timed out"))?
            .with_context(|| format!("connect to {host}:{port}"));
    };
    let name = match p.kind {
        ProxyKind::Socks5 => "SOCKS5",
        ProxyKind::Http => "HTTP",
    };
    let fut = async {
        let mut s = TcpStream::connect((p.host.as_str(), p.port))
            .await
            .with_context(|| format!("connect to {name} proxy {}:{}", p.host, p.port))?;
        s.set_nodelay(true)?;
        match p.kind {
            ProxyKind::Socks5 => socks5(&mut s, p, host, port).await?,
            ProxyKind::Http => http_connect(&mut s, p, host, port).await?,
        }
        Ok::<_, anyhow::Error>(s)
    };
    tokio::time::timeout(TIMEOUT, fut)
        .await
        .map_err(|_| anyhow!("{name} proxy {}:{} timed out", p.host, p.port))?
        .with_context(|| format!("via {name} proxy {}:{}", p.host, p.port))
}

fn creds(p: &ProxySpec) -> Option<(&str, &str)> {
    let user = p.user.as_deref().filter(|u| !u.is_empty())?;
    Some((user, p.password.as_deref().unwrap_or("")))
}

async fn socks5(s: &mut TcpStream, p: &ProxySpec, host: &str, port: u16) -> anyhow::Result<()> {
    let auth = creds(p);
    // Greeting: offer "no auth", plus user/password when we have credentials.
    if auth.is_some() {
        s.write_all(&[5, 2, 0, 2]).await?;
    } else {
        s.write_all(&[5, 1, 0]).await?;
    }
    let mut r = [0u8; 2];
    s.read_exact(&mut r).await?;
    if r[0] != 5 {
        bail!("not a SOCKS5 proxy");
    }
    match r[1] {
        0 => {}
        2 => {
            let Some((u, pw)) = auth else { bail!("proxy requires a username and password") };
            if u.len() > 255 || pw.len() > 255 {
                bail!("proxy username / password too long");
            }
            let mut m = vec![1, u.len() as u8];
            m.extend_from_slice(u.as_bytes());
            m.push(pw.len() as u8);
            m.extend_from_slice(pw.as_bytes());
            s.write_all(&m).await?;
            s.read_exact(&mut r).await?;
            if r[1] != 0 {
                bail!("proxy rejected the username / password");
            }
        }
        0xff => bail!("proxy accepts none of our authentication methods"),
        m => bail!("proxy picked unsupported auth method {m}"),
    }

    // CONNECT request; IP literals as such, anything else as a domain for the proxy to resolve.
    let mut req = vec![5, 1, 0];
    match host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            req.push(1);
            req.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            req.push(4);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if host.len() > 255 {
                bail!("host name too long");
            }
            req.push(3);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req).await?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[1] != 0 {
        bail!(
            "proxy could not reach {host}:{port}: {}",
            match head[1] {
                1 => "general failure",
                2 => "not allowed by ruleset",
                3 => "network unreachable",
                4 => "host unreachable",
                5 => "connection refused",
                6 => "TTL expired",
                7 => "command not supported",
                8 => "address type not supported",
                _ => "unknown error",
            }
        );
    }
    // Skip the bound address.
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut n = [0u8; 1];
            s.read_exact(&mut n).await?;
            n[0] as usize
        }
        t => bail!("bad SOCKS5 reply (address type {t})"),
    } + 2;
    let mut buf = vec![0u8; skip];
    s.read_exact(&mut buf).await?;
    Ok(())
}

async fn http_connect(s: &mut TcpStream, p: &ProxySpec, host: &str, port: u16) -> anyhow::Result<()> {
    let authority = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some((u, pw)) = creds(p) {
        req.push_str(&format!("Proxy-Authorization: Basic {}\r\n", base64(format!("{u}:{pw}").as_bytes())));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await?;

    // Read the response head byte-wise-buffered, but never past the blank line:
    // whatever follows belongs to the SSH stream.
    let mut reader = BufReader::with_capacity(1, &mut *s);
    let mut status = String::new();
    reader.read_line(&mut status).await?;
    let code = status.split_whitespace().nth(1).and_then(|c| c.parse::<u16>().ok());
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    match code {
        Some(200..=299) => Ok(()),
        Some(407) => bail!("proxy authentication required (407) — check the username / password"),
        Some(c) => bail!("proxy refused CONNECT: {}", status.trim().splitn(2, ' ').nth(1).unwrap_or(&c.to_string())),
        None => bail!("not an HTTP proxy (bad response {:?})", status.trim()),
    }
}

fn base64(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for c in input.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Measure how long it takes to reach a proxy and have it connect onward (Settings "Test").
pub async fn test(proxy: &ProxySpec, host: &str, port: u16) -> anyhow::Result<u64> {
    let t = std::time::Instant::now();
    let _s = connect(Some(proxy), host, port).await?;
    Ok(t.elapsed().as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64() {
        assert_eq!(base64(b"user:pass"), "dXNlcjpwYXNz");
        assert_eq!(base64(b"a"), "YQ==");
        assert_eq!(base64(b"ab"), "YWI=");
    }

    /// Minimal SOCKS5 + HTTP proxies on localhost, forwarding to a local echo server.
    #[tokio::test]
    async fn through_proxies() {
        use tokio::net::TcpListener;
        let echo = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (mut c, _) = echo.accept().await.unwrap();
                tokio::spawn(async move {
                    let (mut r, mut w) = c.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });

        // SOCKS5 with user/pass auth.
        let socks = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socks_port = socks.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut c, _) = socks.accept().await.unwrap();
            let mut b = [0u8; 4];
            c.read_exact(&mut b).await.unwrap(); // 5 2 0 2
            c.write_all(&[5, 2]).await.unwrap();
            let mut v = [0u8; 2];
            c.read_exact(&mut v).await.unwrap();
            let mut u = vec![0; v[1] as usize];
            c.read_exact(&mut u).await.unwrap();
            let mut l = [0u8; 1];
            c.read_exact(&mut l).await.unwrap();
            let mut pw = vec![0; l[0] as usize];
            c.read_exact(&mut pw).await.unwrap();
            assert_eq!((u.as_slice(), pw.as_slice()), (&b"me"[..], &b"pw"[..]));
            c.write_all(&[1, 0]).await.unwrap();
            let mut h = [0u8; 5];
            c.read_exact(&mut h).await.unwrap(); // 5 1 0 3 len
            assert_eq!(h[3], 3);
            let mut rest = vec![0; h[4] as usize + 2];
            c.read_exact(&mut rest).await.unwrap();
            assert_eq!(&rest[..h[4] as usize], b"localhost");
            let port = u16::from_be_bytes([rest[rest.len() - 2], rest[rest.len() - 1]]);
            c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
            let mut up = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        let spec = ProxySpec {
            kind: ProxyKind::Socks5,
            host: "127.0.0.1".into(),
            port: socks_port,
            user: Some("me".into()),
            password: Some("pw".into()),
        };
        let mut s = connect(Some(&spec), "localhost", echo_port).await.unwrap();
        s.write_all(b"ping").await.unwrap();
        let mut got = [0u8; 4];
        s.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"ping");

        // HTTP CONNECT; the proxy's reply and the first tunneled bytes arrive together.
        let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let http_port = http.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (c, _) = http.accept().await.unwrap();
            let mut r = BufReader::new(c);
            let mut first = String::new();
            r.read_line(&mut first).await.unwrap();
            let port: u16 = first.split_whitespace().nth(1).unwrap().rsplit(':').next().unwrap().parse().unwrap();
            let mut auth = false;
            loop {
                let mut l = String::new();
                r.read_line(&mut l).await.unwrap();
                auth |= l.starts_with("Proxy-Authorization: Basic bWU6cHc=");
                if l == "\r\n" {
                    break;
                }
            }
            assert!(auth);
            let mut c = r.into_inner();
            c.write_all(b"HTTP/1.1 200 Connection established\r\n\r\nhello").await.unwrap();
            let mut up = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
        });
        let spec = ProxySpec { kind: ProxyKind::Http, port: http_port, ..spec };
        let mut s = connect(Some(&spec), "127.0.0.1", echo_port).await.unwrap();
        let mut got = [0u8; 5];
        s.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello", "bytes after the CONNECT reply must not be swallowed");
    }
}
