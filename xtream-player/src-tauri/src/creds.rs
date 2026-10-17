//! Salvataggio delle credenziali nella cartella di configurazione dell'app.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedCredentials {
    pub server: String,
    pub username: String,
    pub password: String,
}

pub fn credentials_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Cartella di configurazione non disponibile: {}", e))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Impossibile creare {}: {}", dir.display(), e))?;
    Ok(dir.join("credentials.json"))
}

#[tauri::command]
pub fn save_credentials(
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
pub fn load_credentials(app: AppHandle) -> Result<Option<SavedCredentials>, String> {
    let path = credentials_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str::<SavedCredentials>(&text).ok())
}

#[tauri::command]
pub fn clear_credentials(app: AppHandle) -> Result<(), String> {
    let path = credentials_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
