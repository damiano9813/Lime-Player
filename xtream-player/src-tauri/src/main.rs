// Nasconde la console in release su Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::header::{
    HeaderMap, HeaderName, ACCEPT, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, LAST_MODIFIED, RANGE,
};
use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const USER_AGENT: &str = "IPTVSmartersPro";
const API_TIMEOUT_SECS: u64 = 120;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n";

// ---------------------------------------------------------------------------
// Deserializzazione tollerante: Xtream restituisce id come numeri, stringhe,
// null o array a seconda del pannello. Tutto viene normalizzato in String/f64.
// ---------------------------------------------------------------------------

fn value_to_string(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f.abs() < 9.0e15 {
                    (f as i64).to_string()
                } else {
                    f.to_string()
                }
            } else {
                n.to_string()
            }
        }
        Value::Bool(b) => {
            if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        Value::Array(a) => a.first().map(value_to_string).unwrap_or_default(),
        Value::Object(_) => String::new(),
    }
}

fn flex_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.as_ref().map(value_to_string).unwrap_or_default())
}

fn flex_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().replace(',', ".").parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(b)) => {
            if b {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    })
}

fn field(v: &Value, key: &str) -> String {
    v.get(key).map(value_to_string).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Category {
    #[serde(default, deserialize_with = "flex_string")]
    category_id: String,
    #[serde(default, deserialize_with = "flex_string")]
    category_name: String,
    #[serde(default, deserialize_with = "flex_string")]
    parent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StreamItem {
    #[serde(default, deserialize_with = "flex_string")]
    num: String,
    #[serde(default, deserialize_with = "flex_string")]
    name: String,
    #[serde(default, deserialize_with = "flex_string")]
    stream_type: String,
    #[serde(default, deserialize_with = "flex_string")]
    stream_id: String,
    #[serde(default, deserialize_with = "flex_string")]
    stream_icon: String,
    #[serde(default, deserialize_with = "flex_string")]
    epg_channel_id: String,
    #[serde(default, deserialize_with = "flex_string")]
    category_id: String,
    #[serde(default, deserialize_with = "flex_string")]
    container_extension: String,
    #[serde(default, deserialize_with = "flex_f64")]
    rating: f64,
    #[serde(default, deserialize_with = "flex_string")]
    added: String,
    #[serde(default, deserialize_with = "flex_string")]
    tv_archive: String,
}

#[derive(Debug, Clone, Serialize)]
struct AccountInfo {
    username: String,
    status: String,
    exp_date: String,
    is_trial: String,
    active_cons: String,
    max_connections: String,
    created_at: String,
    allowed_output_formats: Vec<String>,
    server_url: String,
    server_port: String,
    server_protocol: String,
    server_timezone: String,
    normalized_server: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SavedCredentials {
    server: String,
    username: String,
    password: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProxyInfo {
    port: u16,
    token: String,
}

struct AppState {
    client: reqwest::Client,
    proxy: ProxyInfo,
}

struct ProxyCtx {
    client: reqwest::Client,
    port: u16,
    token: String,
}

/// Accetta array (formato standard) oppure oggetti indicizzati per id
/// (alcuni pannelli); gli elementi non parsabili vengono scartati senza panic.
fn parse_list<T: DeserializeOwned>(v: Value) -> Vec<T> {
    let items: Vec<Value> = match v {
        Value::Array(a) => a,
        Value::Object(map) => map.into_iter().map(|(_, item)| item).collect(),
        _ => Vec::new(),
    };
    items
        .into_iter()
        .filter(|item| item.is_object())
        .filter_map(|item| serde_json::from_value::<T>(item).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// Client HTTP Xtream Codes
// ---------------------------------------------------------------------------

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(15))
        // Molti provider IPTV usano certificati self-signed o scaduti.
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .tcp_nodelay(true)
        .pool_idle_timeout(Duration::from_secs(30))
        .build()
        .expect("impossibile creare il client HTTP")
}

fn normalize_server(raw: &str) -> Result<String, String> {
    let mut s = raw.trim().trim_end_matches('/').to_string();
    if s.is_empty() {
        return Err("Inserisci l'URL del server".to_string());
    }
    if !s.contains("://") {
        s = format!("http://{}", s);
    }
    let mut url = Url::parse(&s).map_err(|e| format!("URL del server non valido: {}", e))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("L'URL del server deve iniziare con http:// o https://".to_string());
    }
    if url.host_str().map(|h| h.is_empty()).unwrap_or(true) {
        return Err("URL del server senza host".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path().trim_end_matches('/').to_string();
    for suffix in ["/player_api.php", "/panel_api.php", "/get.php", "/xmltv.php"] {
        if path.to_ascii_lowercase().ends_with(suffix) {
            let new_len = path.len() - suffix.len();
            path.truncate(new_len);
            break;
        }
    }
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn describe_reqwest_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Timeout: il server non ha risposto in tempo".to_string()
    } else if e.is_connect() {
        format!("Impossibile connettersi al server: {}", e)
    } else if e.is_redirect() {
        "Troppi redirect dal server".to_string()
    } else if e.is_body() || e.is_decode() {
        format!("Risposta interrotta o non leggibile: {}", e)
    } else {
        format!("Errore di rete: {}", e)
    }
}

fn preview(s: &str) -> String {
    let p: String = s.chars().take(160).collect();
    p.replace(['\r', '\n'], " ")
}

async fn api_get(
    client: &reqwest::Client,
    server: &str,
    username: &str,
    password: &str,
    extra: &[(&str, &str)],
) -> Result<Value, String> {
    if username.trim().is_empty() || password.is_empty() {
        return Err("Username e password sono obbligatori".to_string());
    }
    let base = normalize_server(server)?;
    let endpoint = format!("{}/player_api.php", base);
    let mut query: Vec<(&str, &str)> = vec![("username", username.trim()), ("password", password)];
    query.extend_from_slice(extra);

    let resp = client
        .get(&endpoint)
        .query(&query)
        .header(ACCEPT, "application/json, text/plain, */*")
        .timeout(Duration::from_secs(API_TIMEOUT_SECS))
        .send()
        .await
        .map_err(describe_reqwest_error)?;

    let status = resp.status();
    let body = resp.text().await.map_err(describe_reqwest_error)?;
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "Accesso negato (HTTP 401/403): credenziali errate, account scaduto o IP bloccato".to_string(),
            404 => "player_api.php non trovato (HTTP 404): controlla l'URL e la porta del server".to_string(),
            512 | 513 | 884 => format!("Il server ha rifiutato la richiesta (HTTP {})", status.as_u16()),
            code => format!("Il server ha risposto con HTTP {}", code),
        });
    }

    let trimmed = body.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str::<Value>(trimmed).map_err(|e| {
        format!(
            "Risposta non JSON dal server ({}). Inizio risposta: {}",
            e,
            preview(trimmed)
        )
    })
}

// ---------------------------------------------------------------------------
// Comandi Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
async fn xtream_login(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
) -> Result<AccountInfo, String> {
    let normalized = normalize_server(&server)?;
    let v = api_get(&state.client, &normalized, &username, &password, &[]).await?;

    let user_info = match v.get("user_info") {
        Some(u) if u.is_object() => u.clone(),
        _ => {
            return Err(
                "Risposta inattesa dal server: manca user_info (non è un server Xtream Codes?)"
                    .to_string(),
            )
        }
    };
    if field(&user_info, "auth") != "1" {
        return Err("Credenziali non valide o account disattivato".to_string());
    }
    let server_info = v.get("server_info").cloned().unwrap_or(Value::Null);
    let allowed_output_formats = user_info
        .get("allowed_output_formats")
        .and_then(|f| f.as_array())
        .map(|a| {
            a.iter()
                .map(value_to_string)
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let username_out = {
        let u = field(&user_info, "username");
        if u.is_empty() {
            username.trim().to_string()
        } else {
            u
        }
    };

    Ok(AccountInfo {
        username: username_out,
        status: field(&user_info, "status"),
        exp_date: field(&user_info, "exp_date"),
        is_trial: field(&user_info, "is_trial"),
        active_cons: field(&user_info, "active_cons"),
        max_connections: field(&user_info, "max_connections"),
        created_at: field(&user_info, "created_at"),
        allowed_output_formats,
        server_url: field(&server_info, "url"),
        server_port: field(&server_info, "port"),
        server_protocol: field(&server_info, "server_protocol"),
        server_timezone: field(&server_info, "timezone"),
        normalized_server: normalized,
    })
}

#[tauri::command]
async fn get_categories(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    mode: String,
) -> Result<Vec<Category>, String> {
    if !matches!(
        mode.as_str(),
        "get_live_categories" | "get_vod_categories" | "get_series_categories"
    ) {
        return Err(format!("Modalità categorie non supportata: {}", mode));
    }
    let v = api_get(
        &state.client,
        &server,
        &username,
        &password,
        &[("action", mode.as_str())],
    )
    .await?;
    let mut list: Vec<Category> = parse_list::<Category>(v)
        .into_iter()
        .filter(|c| !c.category_id.is_empty())
        .collect();
    for c in list.iter_mut() {
        if c.category_name.is_empty() {
            c.category_name = format!("Categoria {}", c.category_id);
        }
    }
    Ok(list)
}

#[tauri::command]
async fn get_streams(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    mode: String,
    category_id: String,
) -> Result<Vec<StreamItem>, String> {
    if !matches!(mode.as_str(), "get_live_streams" | "get_vod_streams") {
        return Err(format!("Modalità stream non supportata: {}", mode));
    }
    let cat = category_id.trim().to_string();
    let mut extra: Vec<(&str, &str)> = vec![("action", mode.as_str())];
    if !cat.is_empty() && cat != "all" && cat != "*" {
        extra.push(("category_id", cat.as_str()));
    }
    let v = api_get(&state.client, &server, &username, &password, &extra).await?;
    let mut list: Vec<StreamItem> = parse_list::<StreamItem>(v)
        .into_iter()
        .filter(|s| !s.stream_id.is_empty())
        .collect();
    for s in list.iter_mut() {
        if s.name.is_empty() {
            s.name = format!("Stream {}", s.stream_id);
        }
        s.container_extension = s
            .container_extension
            .trim_start_matches('.')
            .to_ascii_lowercase();
    }
    Ok(list)
}

#[tauri::command]
fn get_proxy_info(state: State<'_, AppState>) -> ProxyInfo {
    state.proxy.clone()
}

fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cartella di configurazione non disponibile: {}", e))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Impossibile creare {}: {}", dir.display(), e))?;
    Ok(dir.join("credentials.json"))
}

#[tauri::command]
fn save_credentials(
    app: AppHandle,
    server: String,
    username: String,
    password: String,
) -> Result<(), String> {
    let path = credentials_path(&app)?;
    let data = SavedCredentials {
        server,
        username,
        password,
    };
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Salvataggio credenziali fallito: {}", e))
}

#[tauri::command]
fn load_credentials(app: AppHandle) -> Result<Option<SavedCredentials>, String> {
    let path = credentials_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<SavedCredentials>(&text).ok())
}

#[tauri::command]
fn clear_credentials(app: AppHandle) -> Result<(), String> {
    let path = credentials_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn env_path(var: &str, rest: &[&str]) -> Option<PathBuf> {
    let mut p = PathBuf::from(std::env::var_os(var)?);
    for part in rest {
        p.push(part);
    }
    Some(p)
}

fn player_candidates(name: &str, known: Vec<Option<PathBuf>>) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from(name)];
    out.extend(known.into_iter().flatten().filter(|p| p.is_file()));
    out
}

fn spawn_detached(cmd: &mut Command) -> io::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ())
}

#[tauri::command]
fn open_in_external_player(
    stream_url: String,
    title: Option<String>,
    live: Option<bool>,
) -> Result<String, String> {
    let url = stream_url.trim().to_string();
    let parsed = Url::parse(&url).map_err(|_| "URL dello stream non valido".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Sono supportati solo URL http:// e https://".to_string());
    }
    let title = title.unwrap_or_default().replace(['\r', '\n', '"'], " ");
    let live = live.unwrap_or(false);

    let mpv = player_candidates(
        "mpv",
        vec![
            env_path("ProgramFiles", &["mpv", "mpv.exe"]),
            env_path("LOCALAPPDATA", &["Programs", "mpv", "mpv.exe"]),
            env_path("USERPROFILE", &["scoop", "apps", "mpv", "current", "mpv.exe"]),
            env_path("USERPROFILE", &["scoop", "shims", "mpv.exe"]),
            env_path("ProgramData", &["chocolatey", "bin", "mpv.exe"]),
            env_path("LOCALAPPDATA", &["Programs", "mpv.net", "mpvnet.exe"]),
            env_path("ProgramFiles", &["mpv.net", "mpvnet.exe"]),
        ],
    );
    for exe in mpv {
        let is_mpvnet = exe
            .file_name()
            .map(|n| n.to_string_lossy().to_ascii_lowercase().contains("mpvnet"))
            .unwrap_or(false);
        let mut cmd = Command::new(&exe);
        cmd.arg(format!("--user-agent={}", USER_AGENT))
            .arg("--force-window=immediate")
            .arg("--keep-open=no")
            .arg("--hwdec=auto-safe");
        if live {
            // buffer ridotto: avvio rapido e latenza bassa, con margine contro i micro-scatti
            cmd.arg("--cache=yes")
                .arg("--cache-secs=2")
                .arg("--demuxer-readahead-secs=2")
                .arg("--video-sync=audio");
        } else {
            cmd.arg("--cache=yes");
        }
        if !title.is_empty() {
            cmd.arg(format!("--force-media-title={}", title));
        }
        if !is_mpvnet {
            cmd.arg("--");
        }
        cmd.arg(&url);
        if spawn_detached(&mut cmd).is_ok() {
            return Ok(if is_mpvnet { "mpv.net" } else { "mpv" }.to_string());
        }
    }

    let vlc = player_candidates(
        "vlc",
        vec![
            env_path("ProgramFiles", &["VideoLAN", "VLC", "vlc.exe"]),
            env_path("ProgramFiles(x86)", &["VideoLAN", "VLC", "vlc.exe"]),
            env_path("USERPROFILE", &["scoop", "apps", "vlc", "current", "vlc.exe"]),
        ],
    );
    for exe in vlc {
        let mut cmd = Command::new(&exe);
        cmd.arg(format!("--http-user-agent={}", USER_AGENT))
            .arg(if live { "--network-caching=1000" } else { "--network-caching=3000" });
        if !title.is_empty() {
            cmd.arg(format!("--meta-title={}", title));
        }
        cmd.arg(&url);
        if spawn_detached(&mut cmd).is_ok() {
            return Ok("VLC".to_string());
        }
    }

    Err("Nessun player esterno trovato. Installa mpv (https://mpv.io) o VLC (winget install VideoLAN.VLC).".to_string())
}

// ---------------------------------------------------------------------------
// ffmpeg: WebView2 non decodifica AC3/E-AC3/DTS/MP2, MPEG-2 video e spesso HEVC.
// Solo le tracce non supportate vengono convertite (audio -> AAC, video -> H.264
// con encoder hardware se disponibile); le altre vengono copiate senza perdite.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct MediaTools {
    ffmpeg: Option<PathBuf>,
    ffprobe: Option<PathBuf>,
    encoder: Option<String>,
    version: String,
}

#[derive(Debug, Clone, Serialize)]
struct MediaCaps {
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
    h264_encoder: Option<String>,
    version: String,
}

#[derive(Debug, Clone, Serialize, Default)]
struct ProbeInfo {
    container: String,
    duration: f64,
    video_codec: String,
    video_profile: String,
    pix_fmt: String,
    field_order: String,
    width: i64,
    height: i64,
    audio_codec: String,
    audio_channels: i64,
    video_tracks: usize,
    audio_tracks: usize,
}

static MEDIA_TOOLS: Mutex<Option<Arc<MediaTools>>> = Mutex::new(None);

fn tool_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let known = [
        env_path("LOCALAPPDATA", &["Microsoft", "WinGet", "Links"]),
        env_path("ProgramFiles", &["ffmpeg", "bin"]),
        Some(PathBuf::from(r"C:\ffmpeg\bin")),
        env_path("USERPROFILE", &["scoop", "shims"]),
        env_path("USERPROFILE", &["scoop", "apps", "ffmpeg", "current", "bin"]),
        env_path("ProgramData", &["chocolatey", "bin"]),
    ];
    dirs.extend(known.into_iter().flatten());
    // pacchetti winget (Gyan.FFmpeg, BtbN.FFmpeg): ...\Packages\<id>\<build>\bin
    if let Some(pkgs) = env_path("LOCALAPPDATA", &["Microsoft", "WinGet", "Packages"]) {
        if let Ok(entries) = std::fs::read_dir(&pkgs) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                if !name.contains("ffmpeg") {
                    continue;
                }
                if let Ok(builds) = std::fs::read_dir(e.path()) {
                    for b in builds.flatten() {
                        dirs.push(b.path().join("bin"));
                    }
                }
            }
        }
    }
    dirs
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let file = format!("{}.exe", name);
    tool_dirs()
        .into_iter()
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

fn tokio_cmd(exe: &Path) -> tokio::process::Command {
    let mut std_cmd = Command::new(exe);
    std_cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    cmd
}

async fn run_output(exe: &Path, args: &[&str], secs: u64) -> Option<std::process::Output> {
    let mut cmd = tokio_cmd(exe);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    match tokio::time::timeout(Duration::from_secs(secs), cmd.output()).await {
        Ok(Ok(out)) => Some(out),
        _ => None,
    }
}

fn encoder_args(encoder: &str) -> Vec<&'static str> {
    match encoder {
        "h264_nvenc" => vec![
            "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "vbr", "-cq", "23",
            "-b:v", "0", "-maxrate", "12M", "-bufsize", "6M", "-g", "50", "-bf", "0",
            "-pix_fmt", "yuv420p",
        ],
        "h264_qsv" => vec![
            "-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-look_ahead",
            "0", "-g", "50", "-bf", "0", "-pix_fmt", "nv12",
        ],
        "h264_amf" => vec![
            "-c:v", "h264_amf", "-usage", "lowlatency", "-quality", "speed", "-rc", "cqp",
            "-qp_i", "22", "-qp_p", "24", "-g", "50", "-bf", "0", "-pix_fmt", "yuv420p",
        ],
        _ => vec![
            "-c:v", "libx264", "-preset", "superfast", "-tune", "zerolatency", "-crf", "23",
            "-g", "50", "-bf", "0", "-pix_fmt", "yuv420p",
        ],
    }
}

async fn detect_media_tools() -> MediaTools {
    let ffmpeg = match find_tool("ffmpeg") {
        Some(p) => p,
        None => return MediaTools::default(),
    };
    let ffprobe = ffmpeg
        .parent()
        .map(|d| d.join("ffprobe.exe"))
        .filter(|p| p.is_file())
        .or_else(|| find_tool("ffprobe"));
    let version = run_output(&ffmpeg, &["-hide_banner", "-version"], 8)
        .await
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    // un encoder hardware elencato non è detto che funzioni: si prova davvero
    let mut encoder = None;
    for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] {
        let mut args = vec![
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=black:s=640x360:r=25:d=0.4",
        ];
        args.extend(encoder_args(enc));
        args.extend(["-f", "null", "-"]);
        if let Some(out) = run_output(&ffmpeg, &args, 15).await {
            if out.status.success() {
                encoder = Some(enc.to_string());
                break;
            }
        }
    }
    MediaTools {
        ffmpeg: Some(ffmpeg),
        ffprobe,
        encoder,
        version,
    }
}

async fn media_tools(refresh: bool) -> Arc<MediaTools> {
    if !refresh {
        if let Ok(guard) = MEDIA_TOOLS.lock() {
            if let Some(t) = guard.as_ref() {
                if t.ffmpeg.is_some() {
                    return t.clone();
                }
            }
        }
    }
    let tools = Arc::new(detect_media_tools().await);
    if let Ok(mut guard) = MEDIA_TOOLS.lock() {
        *guard = Some(tools.clone());
    }
    tools
}

#[tauri::command]
async fn get_media_capabilities(refresh: Option<bool>) -> Result<MediaCaps, String> {
    let t = media_tools(refresh.unwrap_or(false)).await;
    Ok(MediaCaps {
        ffmpeg: t.ffmpeg.as_ref().map(|p| p.display().to_string()),
        ffprobe: t.ffprobe.as_ref().map(|p| p.display().to_string()),
        h264_encoder: t.encoder.clone(),
        version: t.version.clone(),
    })
}

#[tauri::command]
async fn probe_stream(stream_url: String) -> Result<ProbeInfo, String> {
    let url = Url::parse(stream_url.trim()).map_err(|_| "URL dello stream non valido".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Sono supportati solo URL http:// e https://".to_string());
    }
    let tools = media_tools(false).await;
    let ffprobe = tools
        .ffprobe
        .clone()
        .ok_or_else(|| "ffprobe non trovato: installa ffmpeg (winget install Gyan.FFmpeg)".to_string())?;
    let out = run_output(
        &ffprobe,
        &[
            "-v", "error", "-user_agent", USER_AGENT, "-rw_timeout", "15000000", "-probesize",
            "3000000", "-analyzeduration", "3000000", "-print_format", "json", "-show_format",
            "-show_streams", url.as_str(),
        ],
        25,
    )
    .await
    .ok_or_else(|| "Analisi dello stream scaduta".to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffprobe: {}", preview(err.trim())));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe: {}", e))?;
    let mut info = ProbeInfo::default();
    if let Some(format) = v.get("format") {
        info.container = field(format, "format_name");
        info.duration = field(format, "duration").parse::<f64>().unwrap_or(0.0);
    }
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let attached = s
                .get("disposition")
                .map(|d| field(d, "attached_pic") == "1")
                .unwrap_or(false);
            match field(s, "codec_type").as_str() {
                "video" if !attached => {
                    info.video_tracks += 1;
                    if info.video_tracks == 1 {
                        info.video_codec = field(s, "codec_name");
                        info.video_profile = field(s, "profile");
                        info.pix_fmt = field(s, "pix_fmt");
                        info.field_order = field(s, "field_order");
                        info.width = field(s, "width").parse().unwrap_or(0);
                        info.height = field(s, "height").parse().unwrap_or(0);
                    }
                }
                "audio" => {
                    info.audio_tracks += 1;
                    if info.audio_tracks == 1 {
                        info.audio_codec = field(s, "codec_name");
                        info.audio_channels = field(s, "channels").parse().unwrap_or(0);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(info)
}

fn push_args(args: &mut Vec<String>, items: &[&str]) {
    args.extend(items.iter().map(|s| s.to_string()));
}

/// `from_pipe`: l'ingresso arriva su stdin dal proxy (che ha già scartato la raffica
/// iniziale), quindi niente opzioni HTTP.
fn build_ffmpeg_args(
    url: &str,
    v: &str,
    a: &str,
    live: bool,
    ss: f64,
    encoder: &str,
    from_pipe: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    push_args(&mut args, &["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if !from_pipe {
        push_args(
            &mut args,
            &[
                "-user_agent", USER_AGENT, "-reconnect", "1", "-reconnect_on_network_error", "1",
                "-reconnect_delay_max", "3",
            ],
        );
    }
    if live {
        if !from_pipe {
            // dopo un cambio canale il provider può contare ancora per un attimo la
            // connessione precedente (limite connessioni): si riprova invece di fallire
            push_args(&mut args, &["-reconnect_streamed", "1", "-reconnect_on_http_error", "4xx,5xx"]);
        }
        // analisi breve e nessun buffer interno: il primo pacchetto esce il prima possibile
        push_args(
            &mut args,
            &[
                "-fflags", "+nobuffer+discardcorrupt+genpts", "-flags", "low_delay", "-probesize",
                "1000000", "-analyzeduration", "1000000",
            ],
        );
    } else {
        push_args(&mut args, &["-fflags", "+genpts", "-probesize", "5000000", "-analyzeduration", "5000000"]);
        if ss > 0.5 {
            args.push("-ss".to_string());
            args.push(format!("{:.3}", ss));
        }
    }
    if from_pipe {
        push_args(&mut args, &["-f", "mpegts"]);
    }
    push_args(&mut args, &["-i", url, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"]);
    if v == "h264" {
        // i canali DVB sono spesso interlacciati (1080i/576i), che WebView2 non decodifica:
        // si deinterlaccia a doppio frame rate (50p) solo i fotogrammi marcati come interlacciati
        push_args(&mut args, &["-vf", "bwdif=mode=send_field:deint=interlaced"]);
        push_args(&mut args, &encoder_args(encoder));
    } else {
        push_args(&mut args, &["-c:v", "copy"]);
    }
    if a == "copy" {
        push_args(&mut args, &["-c:a", "copy"]);
    } else {
        push_args(&mut args, &["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]);
    }
    push_args(
        &mut args,
        &["-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "pipe:1"],
    );
    args
}

// ---------------------------------------------------------------------------
// Raffica iniziale: alla connessione molti server Xtream inviano in ~1 s il proprio
// buffer (anche 20-30 s di video già vecchio), poi proseguono in tempo reale. Se il
// video va convertito, codificare quella raffica ritarda l'avvio di secondi. Il proxy
// legge i PCR dei pacchetti MPEG-TS, capisce quando il flusso torna al tempo reale e
// passa a ffmpeg solo gli ultimi secondi, cioè il bordo live.
// ---------------------------------------------------------------------------

const TS_PACKET: usize = 188;
const BURST_KEEP_SECS: f64 = 2.5;

fn ts_sync_at(buf: &[u8], i: usize) -> bool {
    i + 2 * TS_PACKET < buf.len()
        && buf[i] == 0x47
        && buf[i + TS_PACKET] == 0x47
        && buf[i + 2 * TS_PACKET] == 0x47
}

fn ts_find_sync(buf: &[u8], from: usize) -> Option<usize> {
    (from..buf.len()).find(|&i| ts_sync_at(buf, i))
}

/// PID e PCR (in secondi) di un pacchetto TS, se il pacchetto ne contiene uno.
fn ts_packet_pcr(p: &[u8]) -> Option<(u16, f64)> {
    if p.len() < 12 || p[0] != 0x47 {
        return None;
    }
    let pid = (((p[1] & 0x1f) as u16) << 8) | p[2] as u16;
    let afc = (p[3] >> 4) & 0x03;
    if afc != 2 && afc != 3 {
        return None;
    }
    if (p[4] as usize) < 7 || (p[5] & 0x10) == 0 {
        return None;
    }
    let base = ((p[6] as u64) << 25)
        | ((p[7] as u64) << 17)
        | ((p[8] as u64) << 9)
        | ((p[9] as u64) << 1)
        | ((p[10] as u64) >> 7);
    Some((pid, base as f64 / 90000.0))
}

struct BurstSkipper {
    pending: Vec<u8>,
    parsed: usize,
    synced: bool,
    pcr_pid: Option<u16>,
    first_pcr: Option<f64>,
    last_pcr: f64,
    marks: Vec<(usize, f64)>,
    samples: Vec<(f64, f64)>,
    start: Option<Instant>,
    done: bool,
}

impl BurstSkipper {
    fn new() -> Self {
        BurstSkipper {
            pending: Vec::new(),
            parsed: 0,
            synced: false,
            pcr_pid: None,
            first_pcr: None,
            last_pcr: 0.0,
            marks: Vec::new(),
            samples: Vec::new(),
            start: None,
            done: false,
        }
    }

    fn release_all(&mut self) -> Vec<u8> {
        self.done = true;
        std::mem::take(&mut self.pending)
    }

    /// Accumula dati; restituisce i byte da inoltrare quando la raffica è finita.
    fn push(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        let now = Instant::now();
        let start = *self.start.get_or_insert(now);
        self.pending.extend_from_slice(chunk);
        if !self.synced {
            if let Some(i) = ts_find_sync(&self.pending, 0) {
                self.parsed = i;
                self.synced = true;
            }
        }
        while self.synced && self.parsed + TS_PACKET <= self.pending.len() {
            if self.pending[self.parsed] != 0x47 {
                match ts_find_sync(&self.pending, self.parsed + 1) {
                    Some(i) => {
                        self.parsed = i;
                        continue;
                    }
                    None => break,
                }
            }
            if let Some((pid, pcr)) = ts_packet_pcr(&self.pending[self.parsed..self.parsed + TS_PACKET]) {
                if self.pcr_pid.is_none() {
                    self.pcr_pid = Some(pid);
                }
                if self.pcr_pid == Some(pid) {
                    if self.first_pcr.is_none() {
                        self.first_pcr = Some(pcr);
                    } else if pcr + 1.0 < self.last_pcr {
                        // discontinuità o wrap del PCR: si inoltra tutto senza tagliare
                        return Some(self.release_all());
                    }
                    self.last_pcr = pcr;
                    self.marks.push((self.parsed, pcr));
                }
            }
            self.parsed += TS_PACKET;
        }

        let wall = now.duration_since(start).as_secs_f64();
        let media = self.first_pcr.map(|f| self.last_pcr - f).unwrap_or(0.0);
        self.samples.push((wall, media));
        // velocità del flusso (secondi di video per secondo reale) rispetto al campione più
        // recente vecchio almeno 300 ms; dopo la raffica i dati arrivano a grappoli, quindi
        // anche il silenzio (push senza dati) conta come ritorno al tempo reale
        let rate = self
            .samples
            .iter()
            .rev()
            .find(|(w, _)| wall - *w >= 0.3)
            .map(|(w, m)| (media - *m) / (wall - *w))
            .unwrap_or(f64::INFINITY);
        let no_pcr = self.first_pcr.is_none() && wall > 1.0;
        let finished = no_pcr
            || wall > 4.0
            || self.pending.len() > 64 * 1024 * 1024
            || (wall >= 0.35 && rate < 1.6);
        if !finished {
            return None;
        }
        if media - wall < 1.5 || self.marks.is_empty() {
            // nessuna raffica significativa
            return Some(self.release_all());
        }
        let cut = self.last_pcr - BURST_KEEP_SECS;
        let offset = self
            .marks
            .iter()
            .find(|(_, p)| *p >= cut)
            .map(|(o, _)| *o)
            .unwrap_or(0);
        self.done = true;
        let out = self.pending.split_off(offset);
        self.pending = Vec::new();
        self.marks = Vec::new();
        self.samples = Vec::new();
        Some(out)
    }
}

async fn feed_ffmpeg(
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

async fn handle_transcode(
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

// ---------------------------------------------------------------------------
// Proxy HTTP locale (127.0.0.1): i server Xtream non inviano header CORS e
// spesso filtrano lo User-Agent. Il proxy aggiunge CORS, inoltra Range per il
// seek dei VOD, segue i redirect e riscrive le playlist HLS.
// ---------------------------------------------------------------------------

fn random_token() -> String {
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

fn proxy_url(port: u16, token: &str, target: &str) -> String {
    let base = format!("http://127.0.0.1:{}/p/{}", port, token);
    match Url::parse_with_params(&base, &[("u", target)]) {
        Ok(u) => u.to_string(),
        Err(_) => base,
    }
}

fn rewrite_uri_attr(line: &str, base: &Url, port: u16, token: &str) -> String {
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

fn rewrite_playlist(body: &str, base: &Url, port: u16, token: &str) -> String {
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

fn find_subsequence(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn header_str(headers: &HeaderMap, name: &HeaderName) -> String {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string()
}

async fn write_simple(sock: &mut TcpStream, code: u16, reason: &str, body: &str) -> io::Result<()> {
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

async fn handle_conn(mut sock: TcpStream, ctx: Arc<ProxyCtx>) -> io::Result<()> {
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
        return write_simple(&mut sock, 405, "Method Not Allowed", "Metodo non supportato").await;
    }

    let parsed = match Url::parse(&format!("http://127.0.0.1{}", path)) {
        Ok(u) => u,
        Err(_) => return write_simple(&mut sock, 400, "Bad Request", "Richiesta non valida").await,
    };
    let is_transcode = parsed.path() == format!("/t/{}", ctx.token);
    if !is_transcode && parsed.path() != format!("/p/{}", ctx.token) {
        return write_simple(&mut sock, 403, "Forbidden", "Token non valido").await;
    }
    let params: HashMap<String, String> = parsed.query_pairs().into_owned().collect();
    let target = match params.get("u") {
        Some(v) => v.clone(),
        None => return write_simple(&mut sock, 400, "Bad Request", "Parametro u mancante").await,
    };
    let target_url = match Url::parse(&target) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => return write_simple(&mut sock, 400, "Bad Request", "URL di destinazione non valido").await,
    };
    if is_transcode {
        return handle_transcode(sock, &method, target_url, &params, &ctx.client).await;
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
                return write_simple(&mut sock, 502, "Bad Gateway", &describe_reqwest_error(e)).await
            }
            Err(_) => return write_simple(&mut sock, 504, "Gateway Timeout", "Timeout playlist").await,
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
    for name in [CONTENT_TYPE, CONTENT_LENGTH, CONTENT_RANGE, ACCEPT_RANGES, LAST_MODIFIED, ETAG] {
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

async fn run_proxy(listener: std::net::TcpListener, ctx: Arc<ProxyCtx>) {
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

fn main() {
    let client = build_client();
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("impossibile avviare il proxy locale");
    std_listener
        .set_nonblocking(true)
        .expect("impossibile configurare il proxy locale");
    let port = std_listener
        .local_addr()
        .expect("porta del proxy locale non disponibile")
        .port();
    let token = random_token();
    // solo in sviluppo: permette di provare il proxy da fuori (test dei codec)
    #[cfg(debug_assertions)]
    println!("[dev] proxy http://127.0.0.1:{}/ token {}", port, token);
    let proxy_ctx = Arc::new(ProxyCtx {
        client: client.clone(),
        port,
        token: token.clone(),
    });

    tauri::Builder::default()
        .manage(AppState {
            client,
            proxy: ProxyInfo { port, token },
        })
        .setup(move |_app| {
            tauri::async_runtime::spawn(run_proxy(std_listener, proxy_ctx));
            // rileva ffmpeg ed encoder all'avvio, così il primo fallback è immediato
            tauri::async_runtime::spawn(async {
                let _ = media_tools(false).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            xtream_login,
            get_categories,
            get_streams,
            get_proxy_info,
            save_credentials,
            load_credentials,
            clear_credentials,
            open_in_external_player,
            get_media_capabilities,
            probe_stream
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio dell'applicazione");
}
