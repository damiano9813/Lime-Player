//! Percorso di conversione: ffmpeg alimentato dal proxy, uscita MPEG-TS verso il player.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::media::{build_ffmpeg_args, build_subtitle_args, media_tools, tokio_cmd, FfmpegJob, Quality};
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
    range: Option<&str>,
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
    let live = params.get("live").map(|s| s != "0").unwrap_or(true);
    let sid = params.get("sid").cloned();
    // film: mpegts.js riapre lo stesso URL con "Range: bytes=N-" dopo aver sospeso il download
    if let (false, Some(sid), Some(from)) = (live, sid.as_deref(), range.and_then(parse_range_start)) {
        if from > 0 {
            return match take_parked(sid, from) {
                Some(sess) => resume_session(sock, sess, from).await,
                // sessione scaduta: il player riparte dal punto attuale con un nuovo seek
                None => write_simple(&mut sock, 410, "Gone", "Sessione di conversione terminata").await,
            };
        }
    }
    // un nuovo flusso ha bisogno della connessione al provider
    release_parked();
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
    let ss = params
        .get("ss")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|x| x.is_finite() && *x >= 0.0)
        .unwrap_or(0.0);
    let encoder = tools.encoder.clone().unwrap_or_else(|| "libx264".to_string());
    let num = |k: &str| params.get(k).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0).max(0);
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
    let mut job = FfmpegJob::new(input, v, a, live, &encoder);
    job.ss = ss;
    job.from_pipe = from_pipe;
    job.audio_index = num("at").min(64) as usize;
    job.surround = params.get("ac").map(|s| s == "orig").unwrap_or(false);
    job.source_channels = num("ch").min(16);
    job.quality = Quality::parse(params.get("q").map(String::as_str).unwrap_or(""));
    // film: le tracce di sottotitoli richieste (`subs=0,2`) escono dallo stesso ffmpeg su socket
    // locali; il percorso /s/ con lo stesso `sid` le passa al player man mano che arrivano
    let mut subtitle_buffers: Vec<Arc<SubtitleBuffer>> = Vec::new();
    if let (false, Some(sid)) = (live, sid.as_deref()) {
        for index in parse_index_list(params.get("subs").map(String::as_str).unwrap_or("")) {
            if let Some((url, buf)) = open_subtitle_sink(sid, index).await {
                job.subtitle_outputs.push((index, url));
                subtitle_buffers.push(buf);
            }
        }
    }
    let args = build_ffmpeg_args(&job);

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
    let live_sid = sid.clone();
    if let (Some(resp), Some(mut stdin)) = (upstream, child.stdin.take()) {
        tokio::spawn(async move {
            pump_live(resp, &mut stdin, Some(stop.as_ref()), live_sid.as_deref()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stdout = match child.stdout.take() {
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
    let mut stdout = stdout;
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
    let mut sess = Session { sid: sid.unwrap_or_default(), child, stdout, replay: Replay::new(REPLAY_BYTES), subtitle_buffers };
    sess.replay.record(&buf[..n]);
    // solo i film si possono sospendere e riprendere; i live si chiudono subito
    let parkable = !live && !sess.sid.is_empty();
    if sock.write_all(&buf[..n]).await.is_err() {
        if parkable {
            park(sess);
        }
        return Ok(());
    }
    pump_session(sock, sess, parkable).await
}

// ---------------------------------------------------------------------------
// Sospensione dei film convertiti. Con molto buffer avanti mpegts.js chiude la richiesta e più
// tardi riapre lo stesso URL con "Range: bytes=N-". Invece di fermare ffmpeg (e ripartire dal
// punto del seek, sovrapponendo dati già in riproduzione) la sessione resta in attesa: ffmpeg
// si blocca da solo sulla pipe piena e la ripresa continua dal byte chiesto, grazie agli
// ultimi byte prodotti tenuti in memoria. Una sola sessione alla volta, e viene chiusa appena
// serve la connessione al provider (nuovo stream, analisi, player esterno, stop).
// ---------------------------------------------------------------------------

/// Byte dell'uscita tenuti per la ripresa: coprono quelli rimasti nei buffer di rete alla chiusura.
const REPLAY_BYTES: usize = 16 * 1024 * 1024;
/// Dopo questo tempo senza ripresa la sessione si chiude e libera la connessione al provider.
const PARK_SECS: u64 = 600;

struct Session {
    sid: String,
    child: tokio::process::Child,
    stdout: tokio::process::ChildStdout,
    replay: Replay,
    subtitle_buffers: Vec<Arc<SubtitleBuffer>>,
}

// la fine della sessione (fine film, stop, nuovo stream) chiude anche i suoi sottotitoli
impl Drop for Session {
    fn drop(&mut self) {
        for b in &self.subtitle_buffers {
            b.finished.store(true, Ordering::SeqCst);
        }
    }
}

/// Ultimi byte prodotti da ffmpeg, con la loro posizione nel flusso.
#[derive(Default)]
struct Replay {
    /// byte prodotti dall'inizio della sessione
    produced: u64,
    /// ultimi byte (al massimo `limit`)
    tail: VecDeque<u8>,
    limit: usize,
}

impl Replay {
    fn new(limit: usize) -> Self {
        Replay { produced: 0, tail: VecDeque::new(), limit }
    }

    fn record(&mut self, chunk: &[u8]) {
        self.produced += chunk.len() as u64;
        self.tail.extend(chunk);
        let excess = self.tail.len().saturating_sub(self.limit);
        self.tail.drain(..excess);
    }

    /// Byte da reinviare per riprendere da `from`, se ancora in memoria.
    fn from(&self, from: u64) -> Option<Vec<u8>> {
        let start = self.produced - self.tail.len() as u64;
        if from < start || from > self.produced {
            return None;
        }
        Some(self.tail.range((from - start) as usize..).copied().collect())
    }
}

static PARK_GEN: AtomicU64 = AtomicU64::new(0);

fn parked() -> &'static Mutex<Option<(u64, Session)>> {
    static P: OnceLock<Mutex<Option<(u64, Session)>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(None))
}

fn park(sess: Session) {
    let generation = PARK_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    if let Ok(mut p) = parked().lock() {
        // la sessione precedente (se c'era) viene chiusa: kill_on_drop ferma ffmpeg
        *p = Some((generation, sess));
    }
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(PARK_SECS)).await;
        if let Ok(mut p) = parked().lock() {
            if p.as_ref().map(|(g, _)| *g == generation).unwrap_or(false) {
                *p = None;
            }
        }
    });
}

fn take_parked(sid: &str, from: u64) -> Option<Session> {
    let mut p = parked().lock().ok()?;
    let ok = p.as_ref().map(|(_, s)| s.sid == sid && s.replay.from(from).is_some()).unwrap_or(false);
    if ok {
        p.take().map(|(_, s)| s)
    } else {
        None
    }
}

/// Chiude la sessione sospesa (e la sua connessione al provider), se c'è.
pub fn release_parked() {
    if let Ok(mut p) = parked().lock() {
        *p = None;
    }
}

/// Lo stesso, per il player: allo stop o prima di aprire un altro contenuto.
#[tauri::command]
pub fn release_stream() {
    release_parked();
    // chiude anche le richieste di sottotitoli ancora aperte (il WebView non le annulla
    // quando l'elemento <track> viene rimosso)
    SUBTITLE_GEN.fetch_add(1, Ordering::SeqCst);
}

/// "bytes=1234-" → 1234
pub fn parse_range_start(range: &str) -> Option<u64> {
    let r = range.trim().strip_prefix("bytes=")?;
    r.split('-').next()?.trim().parse().ok()
}

async fn resume_session(mut sock: TcpStream, sess: Session, from: u64) -> io::Result<()> {
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n{}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        CORS_HEADERS
    );
    let pending = sess.replay.from(from).unwrap_or_default();
    if sock.write_all(head.as_bytes()).await.is_err() || sock.write_all(&pending).await.is_err() {
        park(sess);
        return Ok(());
    }
    pump_session(sock, sess, true).await
}

async fn pump_session(mut sock: TcpStream, mut sess: Session, parkable: bool) -> io::Result<()> {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match sess.stdout.read(&mut buf).await {
            Ok(0) => {
                // fine del film: i sottotitoli sono completi
                for b in &sess.subtitle_buffers {
                    b.finished.store(true, Ordering::SeqCst);
                }
                break;
            }
            Err(_) => break,
            Ok(n) => {
                sess.replay.record(&buf[..n]);
                if sock.write_all(&buf[..n]).await.is_err() {
                    // player chiuso: i film restano in attesa di una ripresa, i live si fermano
                    if parkable {
                        park(sess);
                        return Ok(());
                    }
                    break;
                }
            }
        }
    }
    let _ = sess.child.start_kill();
    let _ = sock.shutdown().await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Sottotitoli dei film. Due modi:
// - con `sid` (quello usato dal player): il testo arriva dal processo ffmpeg del percorso /t/
//   della stessa sessione, quindi nessuna connessione in più al provider (molti account ne
//   hanno una sola) e tempi identici al video anche dopo un seek;
// - senza `sid`: ffmpeg dedicato che legge il file e ne estrae la traccia `i` dal punto `ss`.
// ---------------------------------------------------------------------------

/// Testo WebVTT di una traccia, accumulato mentre ffmpeg lo scrive. Le richieste /t/ riaperte
/// con lo stesso `sid` ripartono dallo stesso punto: i blocchi già ricevuti si scartano.
struct SubtitleBuffer {
    data: Mutex<Vec<u8>>,
    seen: Mutex<HashSet<String>>,
    finished: AtomicBool,
}

impl SubtitleBuffer {
    fn new() -> Self {
        SubtitleBuffer { data: Mutex::new(Vec::new()), seen: Mutex::new(HashSet::new()), finished: AtomicBool::new(false) }
    }

    /// Aggiunge un blocco WebVTT completo (intestazione o cue), se non è già presente.
    fn push_block(&self, block: &str) {
        let block = block.trim_matches(|c| c == '\r' || c == '\n');
        if block.trim().is_empty() {
            return;
        }
        let (Ok(mut data), Ok(mut seen)) = (self.data.lock(), self.seen.lock()) else { return };
        if block.starts_with("WEBVTT") {
            if data.is_empty() {
                data.extend_from_slice(b"WEBVTT\n\n");
            }
            return;
        }
        if seen.insert(block.to_string()) {
            if data.is_empty() {
                data.extend_from_slice(b"WEBVTT\n\n");
            }
            data.extend_from_slice(block.as_bytes());
            data.extend_from_slice(b"\n\n");
        }
    }
}

/// Divide il testo in arrivo nei blocchi separati da una riga vuota.
#[derive(Default)]
struct VttSplitter {
    pending: String,
}

impl VttSplitter {
    fn feed(&mut self, chunk: &str, out: &SubtitleBuffer) {
        self.pending.push_str(&chunk.replace("\r\n", "\n"));
        while let Some(i) = self.pending.find("\n\n") {
            let block: String = self.pending.drain(..i + 2).collect();
            out.push_block(&block);
        }
    }

    fn finish(&mut self, out: &SubtitleBuffer) {
        let rest = std::mem::take(&mut self.pending);
        out.push_block(&rest);
    }
}

type SubtitleKey = (String, usize);

fn subtitle_sessions() -> &'static Mutex<Vec<(SubtitleKey, Arc<SubtitleBuffer>)>> {
    static REG: OnceLock<Mutex<Vec<(SubtitleKey, Arc<SubtitleBuffer>)>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(Vec::new()))
}

fn find_subtitle_buffer(sid: &str, index: usize) -> Option<Arc<SubtitleBuffer>> {
    let reg = subtitle_sessions().lock().ok()?;
    reg.iter().find(|((s, i), _)| s == sid && *i == index).map(|(_, b)| b.clone())
}

/// "0,2,x,3" → [0, 2, 3] (al massimo 12 tracce, senza doppioni)
pub fn parse_index_list(s: &str) -> Vec<usize> {
    let mut out: Vec<usize> = Vec::new();
    for i in s.split(',').filter_map(|x| x.trim().parse::<usize>().ok()) {
        if i < 64 && !out.contains(&i) && out.len() < 12 {
            out.push(i);
        }
    }
    out
}

/// Apre un socket locale su cui ffmpeg scriverà la traccia; restituisce l'URL di uscita e il
/// buffer della sessione (lo stesso se la richiesta /t/ viene riaperta con lo stesso `sid`).
async fn open_subtitle_sink(sid: &str, index: usize) -> Option<(String, Arc<SubtitleBuffer>)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.ok()?;
    let port = listener.local_addr().ok()?.port();
    let buf = match find_subtitle_buffer(sid, index) {
        Some(b) => b,
        None => {
            let b = Arc::new(SubtitleBuffer::new());
            let mut reg = subtitle_sessions().lock().ok()?;
            // si tengono le tracce delle ultime sessioni (ogni seek ne crea una nuova)
            let excess = (reg.len() + 1).saturating_sub(24);
            reg.drain(..excess);
            reg.push(((sid.to_string(), index), b.clone()));
            b
        }
    };
    let sink = buf.clone();
    tokio::spawn(async move {
        if let Ok(Ok((mut conn, _))) = tokio::time::timeout(Duration::from_secs(60), listener.accept()).await {
            let mut splitter = VttSplitter::default();
            let mut b = [0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            while let Ok(n) = conn.read(&mut b).await {
                if n == 0 {
                    break;
                }
                carry.extend_from_slice(&b[..n]);
                // si passa solo testo UTF-8 completo (un carattere può essere diviso tra due letture)
                let valid = match std::str::from_utf8(&carry) {
                    Ok(_) => carry.len(),
                    Err(e) => e.valid_up_to(),
                };
                let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                splitter.feed(&text, &sink);
            }
            splitter.finish(&sink);
        }
    });
    Some((format!("tcp://127.0.0.1:{}", port), buf))
}

// Una sola richiesta di sottotitoli attiva alla volta: il WebView non annulla la richiesta di un
// <track> rimosso, quindi ogni nuova richiesta /s/ (cambio traccia, film o seek) chiude le
// precedenti; altrimenti resterebbero aperte e occuperebbero le connessioni verso il proxy.
static SUBTITLE_GEN: AtomicU64 = AtomicU64::new(0);

/// Vero se il client ha chiuso la connessione.
async fn client_gone(sock: &TcpStream) -> bool {
    let mut probe = [0u8; 1];
    matches!(
        tokio::time::timeout(Duration::from_millis(1), sock.peek(&mut probe)).await,
        Ok(Ok(0)) | Ok(Err(_))
    )
}

fn vtt_head() -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/vtt; charset=utf-8\r\n{}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
        CORS_HEADERS
    )
}

/// Percorso `/s/`: sottotitoli testuali in WebVTT, inviati man mano che ffmpeg li produce.
pub async fn handle_subtitles(
    mut sock: TcpStream,
    method: &str,
    target: Url,
    params: &HashMap<String, String>,
) -> io::Result<()> {
    if method == "HEAD" {
        sock.write_all(vtt_head().as_bytes()).await?;
        let _ = sock.shutdown().await;
        return Ok(());
    }
    let index = params.get("i").and_then(|s| s.parse::<usize>().ok()).unwrap_or(0).min(64);
    match params.get("sid") {
        Some(sid) => serve_session_subtitles(sock, sid, index).await,
        None => extract_subtitles(sock, target, index, params).await,
    }
}

async fn serve_session_subtitles(mut sock: TcpStream, sid: &str, index: usize) -> io::Result<()> {
    let generation = SUBTITLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    // il player chiede i sottotitoli insieme al video: la sessione /t/ può non essere ancora partita
    let mut buf = None;
    for _ in 0..100 {
        buf = find_subtitle_buffer(sid, index);
        if buf.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let buf = match buf {
        Some(b) => b,
        None => return write_simple(&mut sock, 404, "Not Found", "Sottotitoli non disponibili per questa sessione").await,
    };
    sock.write_all(vtt_head().as_bytes()).await?;
    let mut sent = 0usize;
    loop {
        if SUBTITLE_GEN.load(Ordering::SeqCst) != generation {
            break;
        }
        let chunk = buf.data.lock().map(|d| d[sent.min(d.len())..].to_vec()).unwrap_or_default();
        if !chunk.is_empty() {
            if sock.write_all(&chunk).await.is_err() {
                break;
            }
            sent += chunk.len();
            continue;
        }
        if buf.finished.load(Ordering::SeqCst) {
            // fine del film: se nel frattempo è arrivato altro si invia, poi si chiude
            let len = buf.data.lock().map(|d| d.len()).unwrap_or(sent);
            if len <= sent {
                break;
            }
            continue;
        }
        if client_gone(&sock).await {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let _ = sock.shutdown().await;
    Ok(())
}

async fn extract_subtitles(
    mut sock: TcpStream,
    target: Url,
    index: usize,
    params: &HashMap<String, String>,
) -> io::Result<()> {
    let ffmpeg = match media_tools(false).await.ffmpeg.clone() {
        Some(p) => p,
        None => return write_simple(&mut sock, 503, "Service Unavailable", "ffmpeg non trovato").await,
    };
    let ss = params
        .get("ss")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|x| x.is_finite() && *x >= 0.0)
        .unwrap_or(0.0);
    let generation = SUBTITLE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let mut cmd = tokio_cmd(&ffmpeg);
    cmd.args(build_subtitle_args(target.as_str(), index, ss))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return write_simple(&mut sock, 500, "Internal Server Error", &format!("Avvio ffmpeg fallito: {}", e)).await
        }
    };
    let (mut stdout, mut stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(o), Some(e)) => (o, e),
        _ => return write_simple(&mut sock, 500, "Internal Server Error", "ffmpeg non disponibile").await,
    };
    let err_tail = Arc::new(Mutex::new(String::new()));
    {
        let tail = err_tail.clone();
        tokio::spawn(async move {
            let mut b = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut b).await {
                if n == 0 {
                    break;
                }
                if let Ok(mut t) = tail.lock() {
                    if t.len() < 2000 {
                        t.push_str(&String::from_utf8_lossy(&b[..n]));
                    }
                }
            }
        });
    }
    let mut buf = vec![0u8; 16 * 1024];
    let n = match tokio::time::timeout(Duration::from_secs(30), stdout.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            let msg = err_tail.lock().map(|t| t.trim().to_string()).unwrap_or_default();
            let msg = if msg.is_empty() { "nessun sottotitolo prodotto".to_string() } else { preview(&msg) };
            return write_simple(&mut sock, 502, "Bad Gateway", &format!("ffmpeg: {}", msg)).await;
        }
    };
    sock.write_all(vtt_head().as_bytes()).await?;
    sock.write_all(&buf[..n]).await?;
    loop {
        if SUBTITLE_GEN.load(Ordering::SeqCst) != generation {
            break;
        }
        // tra un sottotitolo e l'altro si controlla se il player ha chiuso la richiesta
        match tokio::time::timeout(Duration::from_millis(500), stdout.read(&mut buf)).await {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                if sock.write_all(&buf[..n]).await.is_err() {
                    break;
                }
            }
            Err(_) => {
                if client_gone(&sock).await {
                    break;
                }
            }
        }
    }
    // a fine file, con il player che chiude o con una nuova estrazione: ffmpeg si ferma subito
    let _ = child.start_kill();
    let _ = sock.shutdown().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_covers_the_bytes_lost_on_close() {
        let mut r = Replay::new(10);
        r.record(b"0123456789");
        r.record(b"abcde");
        assert_eq!(r.produced, 15);
        // tenuti solo gli ultimi 10 byte: da 5 a 14
        assert_eq!(r.from(5).unwrap(), b"56789abcde".to_vec());
        assert_eq!(r.from(12).unwrap(), b"cde".to_vec());
        assert_eq!(r.from(15).unwrap(), Vec::<u8>::new(), "ripresa esatta alla fine");
        assert!(r.from(4).is_none(), "troppo indietro");
        assert!(r.from(16).is_none(), "oltre i byte prodotti");
    }

    #[test]
    fn range_start_of_resumed_requests() {
        assert_eq!(parse_range_start("bytes=1048576-"), Some(1048576));
        assert_eq!(parse_range_start(" bytes=0-"), Some(0));
        assert_eq!(parse_range_start("bytes=10-20"), Some(10));
        assert_eq!(parse_range_start("items=1-"), None);
        assert_eq!(parse_range_start("bytes=-500"), None);
    }

    #[test]
    fn subtitle_index_list() {
        assert_eq!(parse_index_list("0,2,x,3,2"), vec![0, 2, 3]);
        assert_eq!(parse_index_list(""), Vec::<usize>::new());
        assert_eq!(parse_index_list("99,1"), vec![1], "indici fuori scala ignorati");
        assert_eq!(parse_index_list(&(0..40).map(|i| i.to_string()).collect::<Vec<_>>().join(",")).len(), 12);
    }

    #[test]
    fn resumed_sessions_do_not_repeat_cues() {
        let buf = SubtitleBuffer::new();
        let first = "WEBVTT

00:01.000 --> 00:02.000
uno

00:03.000 --> 00:04.000
due";
        let mut s1 = VttSplitter::default();
        // blocchi divisi a metà tra due letture
        s1.feed(&first[..30], &buf);
        s1.feed(&first[30..], &buf);
        s1.finish(&buf);
        // la richiesta riaperta riparte dallo stesso punto: stessi cue più quelli nuovi
        let mut s2 = VttSplitter::default();
        s2.feed("WEBVTT

00:01.000 --> 00:02.000
uno

00:03.000 --> 00:04.000
due

00:05.000 --> 00:06.000
tre

", &buf);
        let text = String::from_utf8(buf.data.lock().unwrap().clone()).unwrap();
        assert_eq!(
            text,
            "WEBVTT

00:01.000 --> 00:02.000
uno

00:03.000 --> 00:04.000
due

00:05.000 --> 00:06.000
tre

"
        );
    }

    #[test]
    fn session_subtitles_are_collected_from_the_socket() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (url, buf) = open_subtitle_sink("sessione-test", 1).await.expect("socket locale");
            let mut w = TcpStream::connect(url.trim_start_matches("tcp://")).await.unwrap();
            // "città" diviso a metà di un carattere UTF-8
            let msg = "WEBVTT

00:01.000 --> 00:02.000
città

".as_bytes();
            let cut = msg.len() - 4;
            w.write_all(&msg[..cut]).await.unwrap();
            w.flush().await.unwrap();
            tokio::time::sleep(Duration::from_millis(30)).await;
            w.write_all(&msg[cut..]).await.unwrap();
            drop(w);
            for _ in 0..50 {
                if buf.data.lock().unwrap().ends_with(b"

") && buf.data.lock().unwrap().len() > 10 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert_eq!(String::from_utf8(buf.data.lock().unwrap().clone()).unwrap(), "WEBVTT

00:01.000 --> 00:02.000
città

");
            // la stessa sessione riaperta usa lo stesso buffer
            let (_, again) = open_subtitle_sink("sessione-test", 1).await.unwrap();
            assert!(Arc::ptr_eq(&buf, &again));
            assert!(find_subtitle_buffer("sessione-test", 0).is_none());
        });
    }
}
