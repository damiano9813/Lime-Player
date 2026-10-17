//! Stato condiviso dell'app (client HTTP e dati del proxy locale).

use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
pub struct ProxyInfo {
    pub port: u16,
    pub token: String,
}

pub struct AppState {
    pub client: reqwest::Client,
    pub proxy: ProxyInfo,
}

#[tauri::command]
pub fn get_proxy_info(state: State<'_, AppState>) -> ProxyInfo {
    state.proxy.clone()
}
