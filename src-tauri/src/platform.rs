//! Informazioni sulla piattaforma per la pagina (desktop, telefono o TV) e piccole azioni di sistema.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    /// "windows" o "android" (il plugin Kotlin non lo manda: lo aggiunge platform_info)
    #[serde(default)]
    pub os: String,
    /// Android TV / Google TV: interfaccia da telecomando
    #[serde(default)]
    pub tv: bool,
    /// tocco disponibile (telefoni e tablet)
    #[serde(default)]
    pub touch: bool,
    /// nome del dispositivo, per riconoscerlo nella sincronizzazione
    #[serde(default)]
    pub device: String,
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn platform_info(_app: AppHandle) -> Result<PlatformInfo, String> {
    let device = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into());
    Ok(PlatformInfo {
        os: std::env::consts::OS.into(),
        tv: false,
        touch: false,
        device,
    })
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn platform_info(app: AppHandle) -> Result<PlatformInfo, String> {
    let mut info: PlatformInfo = crate::native::call(&app, "info", ()).await?;
    info.os = "android".into();
    Ok(info)
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Serialize)]
struct UrlArgs<'a> {
    url: &'a str,
}

/// Apre un link http(s) nel browser di sistema (pagina delle release, aiuto di Supabase).
#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "URL non valido".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Sono supportati solo link http:// e https://".into());
    }
    #[cfg(target_os = "android")]
    {
        crate::native::call::<serde_json::Value>(&app, "openUrl", UrlArgs { url: parsed.as_str() })
            .await
            .map(|_| ())
    }
    #[cfg(windows)]
    {
        let _ = app;
        let mut cmd = std::process::Command::new("rundll32");
        cmd.args(["url.dll,FileProtocolHandler", parsed.as_str()]);
        crate::external::spawn_detached(&mut cmd).map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        let _ = app;
        Err("Apertura dei link non supportata su questa piattaforma".into())
    }
}

/// Android TV: apre la tastiera a schermo sul campo di testo attivo (OK del telecomando).
#[tauri::command]
pub async fn show_keyboard(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::native::call::<serde_json::Value>(&app, "keyboard", ()).await.map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
#[derive(Serialize)]
struct OrientationArgs {
    landscape: bool,
}

/// Telefono: `true` blocca in orizzontale (film ed episodi a tutta finestra), `false` torna libero.
#[tauri::command]
pub async fn set_orientation(app: AppHandle, landscape: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::native::call::<serde_json::Value>(&app, "orientation", OrientationArgs { landscape })
            .await
            .map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, landscape);
        Ok(())
    }
}

/// Tasto Indietro al primo livello: su Android l'app va in secondo piano come con il tasto Home
/// (lo stream si ferma), sul desktop non fa nulla.
#[tauri::command]
pub async fn leave_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        crate::native::call::<serde_json::Value>(&app, "leave", ()).await.map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}
