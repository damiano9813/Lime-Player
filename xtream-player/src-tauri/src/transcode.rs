//! Percorso di conversione: ffmpeg alimentato dal proxy, uscita MPEG-TS verso il player.

use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::ACCEPT;
use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::media::{build_ffmpeg_args, media_tools, tokio_cmd};
use crate::proxy::write_simple;
use crate::ts::BurstSkipper;
use crate::util::{describe_reqwest_error, preview, CORS_HEADERS};

pub async fn feed_ffmpeg(
    resp: reqwest::Response,
    mut stdin: tokio::process::ChildStdin,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut body = resp.bytes_stream();
    let mut skipper = BurstSkipper::new();
    loop {
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        let next = {
            match tokio::time::timeout(Duration::from_millis(150), body.next()).await {
                Ok(n) => n,
                Err(_) => {
                    // nessun dato per 150 ms: si rivaluta se la raffica è finita
                    if !skipper.done && skipper.start.is_some() {
                        if let Some(out) = skipper.push(&[]) {
                            if stdin.write_all(&out).await.is_err() {
                                break;
                            }
                        }
                    }
                    continue;
                }
            }
        };
        let bytes = match next {
            Some(Ok(b)) => b,
            _ => break,
        };
        let ok = if skipper.done {
            stdin.write_all(&bytes).await.is_ok()
        } else {
            match skipper.push(&bytes) {
                Some(out) => stdin.write_all(&out).await.is_ok(),
                None => true,
            }
        };
        if !ok {
            break;
        }
    }
    let _ = stdin.shutdown().await;
}

pub async fn handle_transcode(
    mut sock: TcpStream,
    method: &str,
    target: Url,
    params: &HashMap<String, String>,
    client: &reqwest::Client,
) -> io::Result<()> {
    if method == "HEAD" {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n{}Connection: close\r\n\r\n",
            CORS_HEADERS
        );
        sock.write_all(head.as_bytes()).await?;
        let _ = sock.shutdown().await;
        return Ok(());
    }
    let tools = media_tools(false).await;
    let ffmpeg = match &tools.ffmpeg {
        Some(p) => p.clone(),
        None => {
            return write_simple(
                &mut sock,
                503,
                "Service Unavailable",
                "ffmpeg non trovato: installa ffmpeg (winget install Gyan.FFmpeg)",
            )
            .await
        }
    };
    let v = params.get("v").map(String::as_str).unwrap_or("copy");
    let a = params.get("a").map(String::as_str).unwrap_or("aac");
    let live = params.get("live").map(|s| s != "0").unwrap_or(true);
    let ss = params
        .get("ss")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|x| x.is_finite() && *x >= 0.0)
        .unwrap_or(0.0);
    let encoder = tools.encoder.clone().unwrap_or_else(|| "libx264".to_string());
    // live con video da convertire: il proxy legge il flusso e salta la raffica iniziale
    let from_pipe = live && v == "h264";
    let mut upstream: Option<reqwest::Response> = None;
    if from_pipe {
        // dopo un cambio canale il provider può contare ancora la connessione precedente
        // (limite connessioni dell'account): qualche tentativo ravvicinato prima di arrendersi
        let mut last_err = String::new();
        for attempt in 0..4u64 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(600 * attempt)).await;
            }
            match client.get(target.clone()).header(ACCEPT, "*/*").send().await {
                Ok(r) if r.status().is_success() => {
                    upstream = Some(r);
                    break;
                }
                Ok(r) => last_err = format!("Il provider ha risposto HTTP {}", r.status().as_u16()),
                Err(e) => last_err = describe_reqwest_error(e),
            }
        }
        if upstream.is_none() {
            return write_simple(&mut sock, 502, "Bad Gateway", &last_err).await;
        }
    }
    let input = if from_pipe { "pipe:0" } else { target.as_str() };
    let args = build_ffmpeg_args(input, v, a, live, ss, &encoder, from_pipe);

    let mut cmd = tokio_cmd(&ffmpeg);
    cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if from_pipe {
        cmd.stdin(Stdio::piped());
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return write_simple(&mut sock, 500, "Internal Server Error", &format!("Avvio ffmpeg fallito: {}", e)).await
        }
    };
    // il feeder si ferma quando questa richiesta termina (client disconnesso o errore)
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    struct StopOnDrop(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for StopOnDrop {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    let _stop_guard = StopOnDrop(stop.clone());
    if let (Some(resp), Some(stdin)) = (upstream, child.stdin.take()) {
        tokio::spawn(feed_ffmpeg(resp, stdin, stop));
    }
    let mut stdout = match child.stdout.take() {
        Some(s) => s,
        None => return write_simple(&mut sock, 500, "Internal Server Error", "stdout di ffmpeg non disponibile").await,
    };
    // stderr va svuotato, altrimenti ffmpeg può bloccarsi; si tiene la coda per gli errori
    let err_tail = Arc::new(Mutex::new(String::new()));
    if let Some(mut stderr) = child.stderr.take() {
        let tail = err_tail.clone();
        tokio::spawn(async move {
            let mut b = [0u8; 2048];
            loop {
                match stderr.read(&mut b).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut t) = tail.lock() {
                            t.push_str(&String::from_utf8_lossy(&b[..n]));
                            if t.len() > 4000 {
                                let mut cut = t.len() - 2000;
                                while !t.is_char_boundary(cut) {
                                    cut += 1;
                                }
                                *t = t[cut..].to_string();
                            }
                        }
                    }
                }
            }
        });
    }

    let mut buf = vec![0u8; 64 * 1024];
    let first = tokio::time::timeout(Duration::from_secs(30), stdout.read(&mut buf)).await;
    let n = match first {
        Ok(Ok(n)) if n > 0 => n,
        _ => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
            let msg = err_tail.lock().map(|t| t.trim().to_string()).unwrap_or_default();
            let msg = if msg.is_empty() {
                "ffmpeg non ha prodotto dati (stream offline o non raggiungibile)".to_string()
            } else {
                format!("ffmpeg: {}", preview(&msg))
            };
            return write_simple(&mut sock, 502, "Bad Gateway", &msg).await;
        }
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n{}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        CORS_HEADERS
    );
    sock.write_all(head.as_bytes()).await?;
    sock.write_all(&buf[..n]).await?;
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if sock.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
        }
    }
    // client disconnesso (cambio canale) o fine file: ffmpeg viene terminato subito
    let _ = child.start_kill();
    let _ = sock.shutdown().await;
    Ok(())
}
