//! Aggiornamenti su Android: l'ultima release GitHub con un APK allegato. Android non permette
//! di sostituire l'app in silenzio: "Aggiorna ora" apre il download dell'APK nel browser e
//! l'installazione la conferma l'utente.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::util::{describe_reqwest_error, USER_AGENT};

const LATEST: &str = "https://api.github.com/repos/damiano9813/Lime-Player/releases/latest";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current: String,
    pub notes: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// "1.10.0" > "1.9.3": confronto per componenti numeriche, "v" iniziale ignorata.
pub fn newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split(['.', '-', '+'])
            .map_while(|p| p.parse().ok())
            .collect()
    };
    let (a, b) = (parts(candidate), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

async fn latest(app: &AppHandle) -> Result<Option<(UpdateInfo, String)>, String> {
    let client = &tauri::Manager::state::<crate::state::AppState>(app).client;
    let text = client
        .get(LATEST)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(describe_reqwest_error)?
        .error_for_status()
        .map_err(describe_reqwest_error)?
        .text()
        .await
        .map_err(describe_reqwest_error)?;
    let release: Release =
        serde_json::from_str(&text).map_err(|e| format!("Risposta di GitHub non valida: {}", e))?;
    let current = app.package_info().version.to_string();
    let Some(apk) = release
        .assets
        .iter()
        .find(|a| a.name.to_ascii_lowercase().ends_with(".apk"))
    else {
        return Ok(None);
    };
    if !newer(&release.tag_name, &current) {
        return Ok(None);
    }
    Ok(Some((
        UpdateInfo {
            version: release.tag_name.trim_start_matches(['v', 'V']).to_string(),
            current,
            notes: release.body.filter(|b| !b.trim().is_empty()),
        },
        apk.browser_download_url.clone(),
    )))
}

#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(latest(&app).await?.map(|(info, _)| info))
}

#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let (_, url) = latest(&app)
        .await?
        .ok_or_else(|| "Nessun aggiornamento disponibile".to_string())?;
    crate::platform::open_url(app, url).await
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn version_compare() {
        assert!(newer("v1.3.0", "1.2.0"));
        assert!(newer("1.10.0", "1.9.3"));
        assert!(!newer("1.2.0", "1.2.0"));
        assert!(!newer("v1.1.9", "1.2.0"));
        assert!(newer("1.2.1", "1.2"));
    }
}
