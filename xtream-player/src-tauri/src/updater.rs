//! Aggiornamenti dalle release GitHub (`latest.json` firmato, tauri-plugin-updater).

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone().filter(|b| !b.trim().is_empty()),
    }))
}

/// Scarica e avvia l'installer NSIS (firma verificata dal plugin); su Windows l'app si chiude
/// da sola quando parte l'installer. Il frontend ferma prima lo stream e ffmpeg.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Nessun aggiornamento disponibile".to_string())?;
    // l'installer sostituisce anche ffmpeg.exe: niente processi parcheggiati
    crate::transcode::release_stream();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Aggiornamento non riuscito: {}", e))?;
    app.restart();
}
