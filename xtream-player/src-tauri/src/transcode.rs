//! Percorso di conversione: ffmpeg alimentato dal proxy, uscita MPEG-TS verso il player.

use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::media::{build_ffmpeg_args, media_tools, tokio_cmd};
use crate::proxy::write_simple;
use crate::ts::pump_live;
use crate::util::{describe_reqwest_error, preview, CORS_HEADERS};

/// Apre lo stream del provider. Dopo un cambio canale il provider può contare ancora la
/// connessione precedente (limite connessioni dell'account): qualche tentativo ravvicinato
/// prima di arrendersi.
pub async fn open_upstream(client: &reqwest::Client, target: &Url) -> Result<reqwest::Response, String> {
    let mut last_err = String::new();
    for attempt in 0..4u64 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(600 * attempt)).await;
        }
        match client.get(target.clone()).header(ACCEPT, "*/*").send().await {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r) => last_err = format!("Il provider ha risposto HTTP {}", r.status().as_u16()),
            Err(e) => last_err = describe_reqwest_error(e),
        }
    }
    Err(last_err)
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
    // live: il proxy legge il flusso, salta la raffica iniziale e passa a ffmpeg solo il bordo live
    let from_pipe = live;
    let mut upstream: Option<reqwest::Response> = None;
    if from_pipe {
        match open_upstream(client, &target).await {
            Ok(r) => upstream = Some(r),
            Err(e) => return write_simple(&mut sock, 502, "Bad Gateway", &e).await,
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
    if let (Some(resp), Some(mut stdin)) = (upstream, child.stdin.take()) {
        tokio::spawn(async move {
            pump_live(resp, &mut stdin, Some(stop.as_ref())).await;
            let _ = stdin.shutdown().await;
        });
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
