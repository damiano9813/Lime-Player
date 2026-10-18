//! Cache su disco di categorie e liste: la lista salvata si mostra subito e viene
//! aggiornata in background; il risultato arriva alla UI con l'evento `list-updated`.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Oltre questa età la cache non si mostra da sola: si scarica di nuovo (e la si usa
/// solo se il server non risponde).
pub const MAX_AGE_SECS: u64 = 24 * 3600;
/// Sotto questa età non si riscarica in background (evita richieste a ogni cambio categoria).
pub const FRESH_SECS: u64 = 10 * 60;

/// Identifica una lista salvata: account (server + utente) e richiesta.
#[derive(Debug, Clone)]
pub struct CacheKey {
    pub server: String,
    pub username: String,
    pub action: String,
    pub category: String,
}

/// Id della cartella di un account (server normalizzato + utente).
pub fn account_hash(server: &str, username: &str) -> String {
    let mut h = DefaultHasher::new();
    server.hash(&mut h);
    username.trim().hash(&mut h);
    format!("{:016x}", h.finish())
}

impl CacheKey {
    fn account_hash(&self) -> String {
        account_hash(&self.server, &self.username)
    }

    fn file_name(&self) -> String {
        let cat = if self.category.is_empty() { "all" } else { &self.category };
        let safe = |s: &str| -> String {
            s.chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect()
        };
        format!("{}__{}.json", safe(&self.action), safe(cat))
    }

    fn id(&self) -> String {
        format!("{}/{}", self.account_hash(), self.file_name())
    }
}

#[derive(Deserialize)]
struct Entry<T> {
    fetched_at: u64,
    items: Vec<T>,
}

#[derive(Serialize)]
struct EntryRef<'a, T> {
    fetched_at: u64,
    items: &'a [T],
}

/// Risposta dei comandi lista.
#[derive(Debug, Clone, Serialize)]
pub struct Listing<T> {
    pub items: Vec<T>,
    pub from_cache: bool,
    pub fetched_at: u64,
}

/// Evento inviato alla UI quando l'aggiornamento in background è pronto.
#[derive(Debug, Clone, Serialize)]
struct ListUpdated<T> {
    action: String,
    category_id: String,
    items: Vec<T>,
    fetched_at: u64,
}

static IN_FLIGHT: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn lists_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("lists"))
}

/// Cartella dei dati salvati di un account (`server` già normalizzato).
pub fn account_dir(app: &AppHandle, server: &str, username: &str) -> Option<PathBuf> {
    lists_dir(app).map(|d| d.join(account_hash(server, username)))
}

fn entry_path(app: &AppHandle, key: &CacheKey) -> Option<PathBuf> {
    lists_dir(app).map(|d| d.join(key.account_hash()).join(key.file_name()))
}

fn read<T: DeserializeOwned>(app: &AppHandle, key: &CacheKey) -> Option<(u64, Vec<T>)> {
    let bytes = std::fs::read(entry_path(app, key)?).ok()?;
    let entry: Entry<T> = serde_json::from_slice(&bytes).ok()?;
    Some((entry.fetched_at, entry.items))
}

fn write<T: Serialize>(app: &AppHandle, key: &CacheKey, fetched_at: u64, items: &[T]) {
    let Some(path) = entry_path(app, key) else { return };
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(bytes) = serde_json::to_vec(&EntryRef { fetched_at, items }) else { return };
    // scrittura atomica: un file a metà non viene mai letto
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

fn begin(id: &str) -> bool {
    match IN_FLIGHT.lock() {
        Ok(mut g) => g.get_or_insert_with(HashSet::new).insert(id.to_string()),
        Err(_) => false,
    }
}

fn end(id: &str) {
    if let Ok(mut g) = IN_FLIGHT.lock() {
        if let Some(set) = g.as_mut() {
            set.remove(id);
        }
    }
}

/// `policy`: "prefer" usa la cache se recente, "refresh" scarica sempre.
pub async fn load_list<T, F, Fut>(
    app: AppHandle,
    key: CacheKey,
    policy: &str,
    fetch: F,
) -> Result<Listing<T>, String>
where
    T: Serialize + DeserializeOwned + Clone + Send + 'static,
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = Result<Vec<T>, String>> + Send + 'static,
{
    let cached = if policy == "refresh" { None } else { read::<T>(&app, &key) };
    let now = now_secs();
    if let Some((fetched_at, items)) = cached {
        let age = now.saturating_sub(fetched_at);
        if age < MAX_AGE_SECS {
            let id = key.id();
            if age >= FRESH_SECS && begin(&id) {
                tauri::async_runtime::spawn(async move {
                    if let Ok(fresh) = fetch().await {
                        let at = now_secs();
                        write(&app, &key, at, &fresh);
                        let _ = app.emit(
                            "list-updated",
                            ListUpdated { action: key.action.clone(), category_id: key.category.clone(), items: fresh, fetched_at: at },
                        );
                    }
                    end(&id);
                });
            }
            return Ok(Listing { items, from_cache: true, fetched_at });
        }
        // cache vecchia: si prova a scaricare, ma senza rete resta meglio di niente
        return match fetch().await {
            Ok(fresh) => {
                write(&app, &key, now, &fresh);
                Ok(Listing { items: fresh, from_cache: false, fetched_at: now })
            }
            Err(_) => Ok(Listing { items, from_cache: true, fetched_at }),
        };
    }
    let fresh = fetch().await?;
    write(&app, &key, now, &fresh);
    Ok(Listing { items: fresh, from_cache: false, fetched_at: now })
}

/// Cancella tutte le liste salvate, guida TV compresa (logout / svuota cache).
#[tauri::command]
pub fn clear_list_cache(app: AppHandle) -> Result<(), String> {
    crate::guide::forget();
    match lists_dir(&app) {
        Some(dir) if dir.exists() => std::fs::remove_dir_all(&dir).map_err(|e| format!("Impossibile svuotare la cache: {}", e)),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(cat: &str) -> CacheKey {
        CacheKey {
            server: "http://h:8080".into(),
            username: "mario".into(),
            action: "get_live_streams".into(),
            category: cat.into(),
        }
    }

    #[test]
    fn file_names_are_safe_and_distinct() {
        assert_eq!(key("").file_name(), "get_live_streams__all.json");
        assert_eq!(key("12").file_name(), "get_live_streams__12.json");
        assert_eq!(key("../x").file_name(), "get_live_streams_____x.json");
        assert_ne!(key("1").id(), key("2").id());
    }

    #[test]
    fn account_hash_depends_on_server_and_user_only() {
        let a = key("1");
        let mut b = key("2");
        assert_eq!(a.account_hash(), b.account_hash());
        b.username = "luigi".into();
        assert_ne!(a.account_hash(), b.account_hash());
    }

    #[test]
    fn in_flight_guard() {
        assert!(begin("x/test"));
        assert!(!begin("x/test"), "seconda richiesta uguale ignorata");
        end("x/test");
        assert!(begin("x/test"));
        end("x/test");
    }
}
