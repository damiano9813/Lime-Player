//! Motore integrato su Android: ExoPlayer (Media3) nel plugin Kotlin, sotto la WebView trasparente.
//! Stessi comandi e stessi eventi `mpv` del motore libmpv di Windows (`mpv.rs`), così la pagina
//! (06b-mpv.js) non distingue le piattaforme.

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::native::call;

/// Proprietà che la pagina può cambiare direttamente (come su Windows).
fn settable(name: &str) -> bool {
    matches!(name, "pause" | "volume" | "mute" | "aid" | "sid")
}

fn checked_url(url: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "URL dello stream non valido")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Sono supportati solo URL http:// e https://".into());
    }
    Ok(parsed.to_string())
}

#[tauri::command]
pub async fn mpv_available(app: AppHandle) -> Result<bool, String> {
    Ok(call::<Value>(&app, "info", ()).await.is_ok())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadArgs {
    url: String,
    live: bool,
    start: Option<f64>,
    cache_secs: Option<f64>,
    alang: String,
    slang: String,
    audio: String,
    volume: Option<f64>,
    mute: Option<bool>,
    title: String,
    user_agent: &'static str,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mpv_load(
    app: AppHandle,
    url: String,
    live: bool,
    start: Option<f64>,
    cache_secs: Option<f64>,
    alang: Option<String>,
    slang: Option<String>,
    audio: Option<String>,
    volume: Option<f64>,
    mute: Option<bool>,
    title: Option<String>,
) -> Result<(), String> {
    let url = checked_url(&url)?;
    // un film convertito sospeso tiene la connessione al provider
    crate::transcode::release_parked();
    let args = LoadArgs {
        url,
        live,
        start: start.filter(|s| !live && s.is_finite() && *s > 0.0),
        cache_secs: cache_secs.filter(|s| s.is_finite() && *s > 0.0),
        alang: alang.unwrap_or_default(),
        slang: slang.unwrap_or_default(),
        audio: audio.unwrap_or_else(|| "stereo".into()),
        volume: volume.filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 100.0)),
        mute,
        title: title.unwrap_or_default().replace(['\r', '\n'], " "),
        user_agent: crate::util::USER_AGENT,
    };
    call::<Value>(&app, "load", args).await.map(|_| ())
}

#[tauri::command]
pub async fn mpv_stop(app: AppHandle) -> Result<(), String> {
    call::<Value>(&app, "stop", ()).await.map(|_| ())
}

#[derive(Serialize)]
struct SetArgs {
    name: String,
    value: String,
}

#[tauri::command]
pub async fn mpv_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    if !settable(&name) {
        return Err(format!("proprietà non modificabile: {}", name));
    }
    call::<Value>(&app, "set", SetArgs { name, value }).await.map(|_| ())
}

#[derive(Serialize)]
struct SeekArgs {
    secs: f64,
}

#[tauri::command]
pub async fn mpv_seek(app: AppHandle, secs: f64) -> Result<(), String> {
    if !secs.is_finite() {
        return Err("posizione non valida".into());
    }
    call::<Value>(&app, "seek", SeekArgs { secs: secs.max(0.0) })
        .await
        .map(|_| ())
}

#[derive(Serialize)]
struct RectArgs {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    /// larghezza della pagina in px CSS: il plugin converte in pixel fisici della WebView
    vw: f64,
    visible: bool,
}

/// Rettangolo in px CSS della pagina larga `vw` (la pagina è scalata per il viewport scelto da
/// 01-base.js, quindi devicePixelRatio non basta); `visible: false` nasconde il video.
#[tauri::command]
pub async fn mpv_set_rect(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
    vw: Option<f64>,
) -> Result<(), String> {
    let vw = vw.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
    let ok = [x, y, w, h].iter().all(|v| v.is_finite()) && w > 0.0 && h > 0.0 && vw > 0.0;
    let args = if ok {
        RectArgs { x, y, w, h, vw, visible }
    } else {
        RectArgs { x: 0.0, y: 0.0, w: 0.0, h: 0.0, vw: 0.0, visible: false }
    };
    call::<Value>(&app, "rect", args).await.map(|_| ())
}
