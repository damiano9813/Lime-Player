//! Client Xtream Codes: modelli tolleranti, normalizzazione URL e comandi Tauri.

use std::time::Duration;

use reqwest::header::ACCEPT;
use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tauri::ipc::Response;
use tauri::{AppHandle, State};

use crate::cache::{load_list, CacheKey};
use crate::state::AppState;
use crate::util::{describe_reqwest_error, preview, USER_AGENT};

pub const API_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// Deserializzazione tollerante: Xtream restituisce id come numeri, stringhe,
// null o array a seconda del pannello. Tutto viene normalizzato in String/f64.
// ---------------------------------------------------------------------------

pub fn value_to_string(v: &Value) -> String {
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

pub fn flex_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(v.as_ref().map(value_to_string).unwrap_or_default())
}

pub fn flex_f64<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Option::<Value>::deserialize(d)?;
    Ok(match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().replace(',', ".").parse::<f64>().unwrap_or(0.0),
        Some(Value::Bool(true)) => 1.0,
        _ => 0.0,
    })
}

pub fn is_zero(v: &f64) -> bool {
    *v == 0.0
}

pub fn field(v: &Value, key: &str) -> String {
    v.get(key).map(value_to_string).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Category {
    #[serde(default, deserialize_with = "flex_string")]
    pub category_id: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub category_name: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub parent_id: String,
}

/// Canale o film, con i soli campi usati dalla UI. Verso la UI e nella cache i campi vuoti non
/// si scrivono (con `stream_type` erano un quarto del JSON di un catalogo da 180.000 film):
/// rileggendo valgono di nuovo "" e 0.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamItem {
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub num: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub name: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub stream_id: String,
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub stream_icon: String,
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub epg_channel_id: String,
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub category_id: String,
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub container_extension: String,
    #[serde(
        default,
        deserialize_with = "flex_f64",
        skip_serializing_if = "is_zero"
    )]
    pub rating: f64,
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub added: String,
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub tv_archive: String,
    /// giorni di archivio per il catch-up
    #[serde(
        default,
        deserialize_with = "flex_string",
        skip_serializing_if = "String::is_empty"
    )]
    pub tv_archive_duration: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountInfo {
    pub username: String,
    pub status: String,
    pub exp_date: String,
    pub is_trial: String,
    pub active_cons: String,
    pub max_connections: String,
    pub created_at: String,
    pub allowed_output_formats: Vec<String>,
    pub server_url: String,
    pub server_port: String,
    pub server_protocol: String,
    pub server_timezone: String,
    pub normalized_server: String,
}

/// Accetta array (formato standard) oppure oggetti indicizzati per id
/// (alcuni pannelli); gli elementi non parsabili vengono scartati senza panic.
pub fn parse_list<T: DeserializeOwned>(v: Value) -> Vec<T> {
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

pub fn build_client() -> reqwest::Client {
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

pub fn normalize_server(raw: &str) -> Result<String, String> {
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
    for suffix in [
        "/player_api.php",
        "/panel_api.php",
        "/get.php",
        "/xmltv.php",
    ] {
        if path.to_ascii_lowercase().ends_with(suffix) {
            let new_len = path.len() - suffix.len();
            path.truncate(new_len);
            break;
        }
    }
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

pub async fn api_get(
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
            401 | 403 => {
                "Accesso negato (HTTP 401/403): credenziali errate, account scaduto o IP bloccato"
                    .to_string()
            }
            404 => "player_api.php non trovato (HTTP 404): controlla l'URL e la porta del server"
                .to_string(),
            512 | 513 | 884 => format!(
                "Il server ha rifiutato la richiesta (HTTP {})",
                status.as_u16()
            ),
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
pub async fn xtream_login(
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

/// `cache`: "prefer" (predefinito) mostra la lista salvata e la aggiorna in background,
/// "refresh" scarica sempre dal server.
#[tauri::command]
pub async fn get_categories(
    app: AppHandle,
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    mode: String,
    cache: Option<String>,
) -> Result<Response, String> {
    if !matches!(
        mode.as_str(),
        "get_live_categories" | "get_vod_categories" | "get_series_categories"
    ) {
        return Err(format!("Modalità categorie non supportata: {}", mode));
    }
    let server = normalize_server(&server)?;
    let key = CacheKey {
        server: server.clone(),
        username: username.clone(),
        action: mode.clone(),
        category: String::new(),
    };
    let client = state.client.clone();
    load_list(app, key, cache.as_deref().unwrap_or("prefer"), move || {
        let (client, server, username, password, mode) = (
            client.clone(),
            server.clone(),
            username.clone(),
            password.clone(),
            mode.clone(),
        );
        async move { fetch_categories(&client, &server, &username, &password, &mode).await }
    })
    .await
}

async fn fetch_categories(
    client: &reqwest::Client,
    server: &str,
    username: &str,
    password: &str,
    mode: &str,
) -> Result<Vec<Category>, String> {
    let v = api_get(client, server, username, password, &[("action", mode)]).await?;
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
#[allow(clippy::too_many_arguments)]
pub async fn get_streams(
    app: AppHandle,
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    mode: String,
    category_id: String,
    cache: Option<String>,
) -> Result<Response, String> {
    if !matches!(mode.as_str(), "get_live_streams" | "get_vod_streams") {
        return Err(format!("Modalità stream non supportata: {}", mode));
    }
    let server = normalize_server(&server)?;
    let cat = category_id.trim().to_string();
    let cat = if cat == "all" || cat == "*" {
        String::new()
    } else {
        cat
    };
    let key = CacheKey {
        server: server.clone(),
        username: username.clone(),
        action: mode.clone(),
        category: cat.clone(),
    };
    let client = state.client.clone();
    load_list(app, key, cache.as_deref().unwrap_or("prefer"), move || {
        let (client, server, username, password, mode, cat) = (
            client.clone(),
            server.clone(),
            username.clone(),
            password.clone(),
            mode.clone(),
            cat.clone(),
        );
        async move { fetch_streams(&client, &server, &username, &password, &mode, &cat).await }
    })
    .await
}

async fn fetch_streams(
    client: &reqwest::Client,
    server: &str,
    username: &str,
    password: &str,
    mode: &str,
    cat: &str,
) -> Result<Vec<StreamItem>, String> {
    let mut extra: Vec<(&str, &str)> = vec![("action", mode)];
    if !cat.is_empty() {
        extra.push(("category_id", cat));
    }
    let v = api_get(client, server, username, password, &extra).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_server_cases() {
        assert_eq!(
            normalize_server("example.com:8080").unwrap(),
            "http://example.com:8080"
        );
        assert_eq!(
            normalize_server(" http://x.com:8080/player_api.php?username=a&password=b ").unwrap(),
            "http://x.com:8080"
        );
        assert_eq!(normalize_server("https://x.com/").unwrap(), "https://x.com");
        assert_eq!(
            normalize_server("http://x.com/sub/get.php").unwrap(),
            "http://x.com/sub"
        );
        assert_eq!(
            normalize_server("HTTP://X.com:80/").unwrap(),
            "http://x.com"
        );
        assert!(normalize_server("").is_err());
        assert!(normalize_server("ftp://x.com").is_err());
    }

    #[test]
    fn value_to_string_is_tolerant() {
        assert_eq!(value_to_string(&json!(5)), "5");
        assert_eq!(value_to_string(&json!(5.0)), "5");
        assert_eq!(value_to_string(&json!(7.5)), "7.5");
        assert_eq!(value_to_string(&json!("  a ")), "a");
        assert_eq!(value_to_string(&json!(null)), "");
        assert_eq!(value_to_string(&json!(true)), "1");
        assert_eq!(value_to_string(&json!([3, 4])), "3");
        assert_eq!(value_to_string(&json!({"a": 1})), "");
    }

    #[test]
    fn stream_item_skips_empty_fields() {
        let server = json!({"num": 1, "name": "Film", "stream_type": "movie", "stream_id": 7,
                            "stream_icon": "", "epg_channel_id": null, "category_id": "3",
                            "container_extension": "mkv", "rating": "0", "added": "1700000000",
                            "tv_archive": "", "tv_archive_duration": ""});
        let s: StreamItem = serde_json::from_value(server).unwrap();
        let out = serde_json::to_value(&s).unwrap();
        assert_eq!(
            out,
            json!({"num": "1", "name": "Film", "stream_id": "7", "category_id": "3",
                   "container_extension": "mkv", "added": "1700000000"})
        );
        // rilettura dalla cache, anche di quella scritta dalle versioni precedenti
        let back: StreamItem = serde_json::from_value(out).unwrap();
        assert_eq!(back.stream_icon, "");
        assert_eq!(back.rating, 0.0);
        let old: StreamItem = serde_json::from_value(json!({"name": "C", "stream_type": "live",
            "stream_id": "9", "rating": 0, "tv_archive": "1", "tv_archive_duration": "3"}))
        .unwrap();
        assert_eq!(old.tv_archive_duration, "3");
    }

    #[test]
    fn parse_list_accepts_messy_panels() {
        let v = json!([
            {"category_id": 1, "category_name": "A"},
            {"category_id": "2", "category_name": null},
            "spazzatura",
            {"category_id": null},
            42
        ]);
        let cats: Vec<Category> = parse_list(v);
        assert_eq!(cats.len(), 3);
        assert_eq!(cats[0].category_id, "1");
        assert_eq!(cats[1].category_name, "");
        assert_eq!(cats[2].category_id, "");

        let indexed = json!({
            "10": {"stream_id": 10, "name": "Uno", "rating": "7,5"},
            "x": {"stream_id": "11"}
        });
        let streams: Vec<StreamItem> = parse_list(indexed);
        assert_eq!(streams.len(), 2);
        let uno = streams.iter().find(|s| s.stream_id == "10").unwrap();
        assert_eq!(uno.name, "Uno");
        assert!((uno.rating - 7.5).abs() < 1e-9);

        let nothing: Vec<Category> = parse_list(json!({"user_info": "x"}));
        assert!(nothing.is_empty());
        let nothing: Vec<Category> = parse_list(json!(null));
        assert!(nothing.is_empty());
    }
}
