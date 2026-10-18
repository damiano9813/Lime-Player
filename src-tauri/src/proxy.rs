//! Proxy HTTP locale su 127.0.0.1 per mpegts.js, hls.js e il tag video.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, ACCEPT, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, LAST_MODIFIED, RANGE,
};
use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::transcode::{handle_subtitles, handle_transcode, open_upstream, release_parked};
use crate::ts::{parse_keep, pump_live};
use crate::util::{describe_reqwest_error, CORS_HEADERS};

pub struct ProxyCtx {
    pub client: reqwest::Client,
    pub port: u16,
    pub token: String,
}

// ---------------------------------------------------------------------------
// Proxy HTTP locale (127.0.0.1): i server Xtream non inviano header CORS e
// spesso filtrano lo User-Agent. Il proxy aggiunge CORS, inoltra Range per il
// seek dei VOD, segue i redirect e riscrive le playlist HLS.
// ---------------------------------------------------------------------------

pub fn random_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i);
        h.write_u128(nanos);
        h.write_u32(std::process::id());
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

pub fn proxy_url(port: u16, token: &str, target: &str) -> String {
    let base = format!("http://127.0.0.1:{}/p/{}", port, token);
    match Url::parse_with_params(&base, &[("u", target)]) {
        Ok(u) => u.to_string(),
        Err(_) => base,
    }
}

pub fn rewrite_uri_attr(line: &str, base: &Url, port: u16, token: &str) -> String {
    let marker = "URI=\"";
    if let Some(start) = line.find(marker) {
        let value_start = start + marker.len();
        if let Some(rel_end) = line[value_start..].find('"') {
            let value_end = value_start + rel_end;
            let uri = &line[value_start..value_end];
            if let Ok(abs) = base.join(uri) {
                if matches!(abs.scheme(), "http" | "https") {
                    return format!(
                        "{}{}{}",
                        &line[..value_start],
                        proxy_url(port, token, abs.as_str()),
                        &line[value_end..]
                    );
                }
            }
        }
    }
    line.to_string()
}

pub fn rewrite_playlist(body: &str, base: &Url, port: u16, token: &str) -> String {
    let mut out = String::with_capacity(body.len() * 2);
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() {
            out.push('\n');
            continue;
        }
        if t.starts_with('#') {
            out.push_str(&rewrite_uri_attr(t, base, port, token));
        } else {
            match base.join(t) {
                Ok(abs) if matches!(abs.scheme(), "http" | "https") => {
                    out.push_str(&proxy_url(port, token, abs.as_str()))
                }
                _ => out.push_str(t),
            }
        }
        out.push('\n');
    }
    out
}

pub fn find_subsequence(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

pub fn header_str(headers: &HeaderMap, name: &HeaderName) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

pub async fn write_simple(
    sock: &mut TcpStream,
    code: u16,
    reason: &str,
    body: &str,
) -> io::Result<()> {
    let resp = format!(
        "HTTP/1.1 {} {}\r\n{}Access-Control-Max-Age: 600\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        code,
        reason,
        CORS_HEADERS,
        body.len(),
        body
    );
    sock.write_all(resp.as_bytes()).await?;
    let _ = sock.shutdown().await;
    Ok(())
}

pub async fn handle_conn(mut sock: TcpStream, ctx: Arc<ProxyCtx>) -> io::Result<()> {
    let _ = sock.set_nodelay(true);
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = tokio::time::timeout(Duration::from_secs(15), sock.read(&mut tmp))
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timeout lettura richiesta"))??;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 32 * 1024 {
            return write_simple(&mut sock, 431, "Request Header Fields Too Large", "").await;
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    let mut range: Option<String> = None;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }

    if method == "OPTIONS" {
        return write_simple(&mut sock, 204, "No Content", "").await;
    }
    if method != "GET" && method != "HEAD" {
        return write_simple(
            &mut sock,
            405,
            "Method Not Allowed",
            "Metodo non supportato",
        )
        .await;
    }

    let parsed = match Url::parse(&format!("http://127.0.0.1{}", path)) {
        Ok(u) => u,
        Err(_) => return write_simple(&mut sock, 400, "Bad Request", "Richiesta non valida").await,
    };
    let is_transcode = parsed.path() == format!("/t/{}", ctx.token);
    let is_subtitles = parsed.path() == format!("/s/{}", ctx.token);
    if !is_transcode && !is_subtitles && parsed.path() != format!("/p/{}", ctx.token) {
        return write_simple(&mut sock, 403, "Forbidden", "Token non valido").await;
    }
    let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    let target = match params.get("u") {
        Some(v) => v.clone(),
        None => return write_simple(&mut sock, 400, "Bad Request", "Parametro u mancante").await,
    };
    let target_url = match Url::parse(&target) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => {
            return write_simple(
                &mut sock,
                400,
                "Bad Request",
                "URL di destinazione non valido",
            )
            .await
        }
    };
    if is_transcode {
        return handle_transcode(
            sock,
            &method,
            target_url,
            &params,
            &ctx.client,
            range.as_deref(),
        )
        .await;
    }
    // un film convertito in pausa tiene la connessione al provider: si libera per i nuovi stream
    if !(is_subtitles && params.contains_key("sid")) {
        release_parked();
    }
    if is_subtitles {
        return handle_subtitles(sock, &method, target_url, &params).await;
    }

    // live MPEG-TS diretto (&live=1): tentativi sul limite connessioni, salto della raffica
    // iniziale (se ne tengono `keep` secondi, il buffer di partenza del player) e
    // riconnessione al provider senza chiudere il player se il flusso cade o si ferma
    if method == "GET" && params.get("live").map(|s| s == "1").unwrap_or(false) {
        let resp = match open_upstream(&ctx.client, &target_url).await {
            Ok(r) => r,
            Err(e) => return write_simple(&mut sock, 502, "Bad Gateway", &e).await,
        };
        let ct = header_str(resp.headers(), &CONTENT_TYPE);
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
            if ct.is_empty() { "video/mp2t" } else { ct.as_str() },
            CORS_HEADERS
        );
        sock.write_all(head.as_bytes()).await?;
        let sid = params.get("sid").map(String::as_str);
        let keep = parse_keep(params.get("keep").map(String::as_str));
        let reopen = || open_upstream(&ctx.client, &target_url);
        pump_live(resp, reopen, &mut sock, None, sid, keep, true).await;
        let _ = sock.shutdown().await;
        return Ok(());
    }

    let mut req = if method == "HEAD" {
        ctx.client.head(target_url.clone())
    } else {
        ctx.client.get(target_url.clone())
    };
    req = req.header(ACCEPT, "*/*");
    if let Some(r) = &range {
        req = req.header(RANGE, r.as_str());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return write_simple(&mut sock, 502, "Bad Gateway", &describe_reqwest_error(e)).await
        }
    };

    let status = resp.status();
    let final_url = resp.url().clone();
    let headers = resp.headers().clone();
    let content_type = header_str(&headers, &CONTENT_TYPE);
    let is_playlist = content_type.to_ascii_lowercase().contains("mpegurl")
        || final_url.path().to_ascii_lowercase().ends_with(".m3u8")
        || target_url.path().to_ascii_lowercase().ends_with(".m3u8");

    if is_playlist && status.is_success() && method == "GET" {
        let text = match tokio::time::timeout(Duration::from_secs(20), resp.text()).await {
            Ok(Ok(t)) => t,
            Ok(Err(e)) => {
                return write_simple(&mut sock, 502, "Bad Gateway", &describe_reqwest_error(e))
                    .await
            }
            Err(_) => {
                return write_simple(&mut sock, 504, "Gateway Timeout", "Timeout playlist").await
            }
        };
        let rewritten = rewrite_playlist(&text, &final_url, ctx.port, &ctx.token);
        let ct = if content_type.is_empty() {
            "application/vnd.apple.mpegurl".to_string()
        } else {
            content_type
        };
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\n{}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
            ct,
            rewritten.len(),
            CORS_HEADERS
        );
        sock.write_all(head.as_bytes()).await?;
        sock.write_all(rewritten.as_bytes()).await?;
        let _ = sock.shutdown().await;
        return Ok(());
    }

    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("OK")
    );
    for name in [
        CONTENT_TYPE,
        CONTENT_LENGTH,
        CONTENT_RANGE,
        ACCEPT_RANGES,
        LAST_MODIFIED,
        ETAG,
    ] {
        let v = header_str(&headers, &name);
        if !v.is_empty() {
            head.push_str(&format!("{}: {}\r\n", name.as_str(), v));
        }
    }
    head.push_str(CORS_HEADERS);
    head.push_str("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
    sock.write_all(head.as_bytes()).await?;
    if method == "HEAD" {
        let _ = sock.shutdown().await;
        return Ok(());
    }

    // Se il client chiude (cambio canale), write_all fallisce: la risposta
    // upstream viene droppata e la connessione al provider si chiude subito.
    let mut body = resp.bytes_stream();
    while let Some(chunk) = body.next().await {
        match chunk {
            Ok(bytes) => sock.write_all(&bytes).await?,
            Err(_) => break,
        }
    }
    let _ = sock.shutdown().await;
    Ok(())
}

pub async fn run_proxy(listener: std::net::TcpListener, ctx: Arc<ProxyCtx>) {
    let listener = match TcpListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Proxy locale non avviato: {}", e);
            return;
        }
    };
    loop {
        match listener.accept().await {
            Ok((sock, _)) => {
                let ctx = ctx.clone();
                tokio::spawn(async move {
                    let _ = handle_conn(sock, ctx).await;
                });
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Estrae l'URL originale da un URL del proxy.
    fn target_of(proxied: &str) -> String {
        let u = Url::parse(proxied).expect("URL del proxy valido");
        assert_eq!(u.path(), "/p/tok");
        u.query_pairs()
            .find(|(k, _)| k == "u")
            .map(|(_, v)| v.into_owned())
            .expect("parametro u")
    }

    #[test]
    fn playlist_lines_are_proxied_and_resolved() {
        let base = Url::parse("http://h:8080/live/a/b/1.m3u8").unwrap();
        let body = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n\nseg 1.ts\nhttp://cdn.example/x.ts?t=1&s=2\n";
        let out = rewrite_playlist(body, &base, 5555, "tok");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "#EXTM3U");
        let key_line = lines[1];
        let start = key_line.find("URI=\"").unwrap() + 5;
        let end = start + key_line[start..].find('"').unwrap();
        assert_eq!(
            target_of(&key_line[start..end]),
            "http://h:8080/live/a/b/key.bin"
        );
        assert_eq!(lines[2], "");
        assert_eq!(target_of(lines[3]), "http://h:8080/live/a/b/seg%201.ts");
        assert_eq!(target_of(lines[4]), "http://cdn.example/x.ts?t=1&s=2");
        assert!(lines[4].starts_with("http://127.0.0.1:5555/p/tok?"));
    }

    #[test]
    fn data_uris_are_left_alone() {
        let base = Url::parse("http://h/1.m3u8").unwrap();
        let line = "#EXT-X-KEY:METHOD=AES-128,URI=\"data:text/plain;base64,AAAA\"";
        assert_eq!(rewrite_playlist(line, &base, 1, "tok").trim_end(), line);
    }

    #[test]
    fn find_subsequence_works() {
        assert_eq!(
            find_subsequence(b"GET / HTTP/1.1\r\nA: b\r\n\r\nrest", b"\r\n\r\n"),
            Some(20)
        );
        assert_eq!(find_subsequence(b"abc", b"\r\n\r\n"), None);
    }

    /// Banco di prova manuale: il proxy reale su 127.0.0.1:XP_BENCH_PORT (token "bench") per le
    /// pagine di prova nel browser, senza aprire l'app:
    /// `cargo test proxy_bench -- --ignored --nocapture` (le tracce lette dalla PMT finiscono su stdout).
    #[test]
    #[ignore = "banco di prova manuale: avvia il proxy per XP_BENCH_SECS secondi"]
    fn proxy_bench() {
        let env = |k: &str, def: u64| {
            std::env::var(k)
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(def)
        };
        let port = env("XP_BENCH_PORT", 17999) as u16;
        let listener =
            std::net::TcpListener::bind(("127.0.0.1", port)).expect("porta del banco occupata");
        listener.set_nonblocking(true).unwrap();
        let ctx = Arc::new(ProxyCtx {
            client: crate::xtream::build_client(),
            port,
            token: "bench".into(),
        });
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        println!("[bench] proxy http://127.0.0.1:{}/ token bench", port);
        rt.block_on(async {
            let _ = tokio::time::timeout(
                Duration::from_secs(env("XP_BENCH_SECS", 600)),
                run_proxy(listener, ctx),
            )
            .await;
        });
    }

    #[test]
    fn tokens_are_random_and_hex() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
