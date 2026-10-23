//! Cache su disco di categorie e liste: la lista salvata si mostra subito e viene
//! aggiornata in background; quando è pronta la UI riceve l'evento `list-updated` e la rilegge.
//!
//! I cataloghi completi arrivano a decine di MB: la lista salvata va alla UI così com'è nel
//! file, senza ricostruire e riserializzare gli elementi, e l'evento non porta gli elementi
//! (Tauri consegna gli eventi eseguendo nella pagina uno script con tutto il contenuto, sul
//! thread della finestra).

use std::collections::HashSet;
use std::fmt::Write as _;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager};

/// Oltre questa età la cache non si mostra da sola: si scarica di nuovo (e la si usa
/// solo se il server non risponde).
pub const MAX_AGE_SECS: u64 = 24 * 3600;
/// Sotto questa età non si riscarica in background (evita richieste a ogni cambio categoria).
pub const FRESH_SECS: u64 = 10 * 60;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a a 64 bit: continua l'hash `h` con i byte dati.
fn fnv1a(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Identifica una lista salvata: account (server + utente) e richiesta.
#[derive(Debug, Clone)]
pub struct CacheKey {
    pub server: String,
    pub username: String,
    pub action: String,
    pub category: String,
}

/// Id della cartella di un account (server normalizzato + utente): deve restare uguale tra
/// versioni e build diverse, per questo non si usa `DefaultHasher` (algoritmo non garantito).
pub fn account_hash(server: &str, username: &str) -> String {
    // 0xff non compare mai in UTF-8: separa server e utente senza ambiguità
    let h = fnv1a(FNV_OFFSET, server.as_bytes());
    let h = fnv1a(h, &[0xff]);
    let h = fnv1a(h, username.trim().as_bytes());
    format!("{:016x}", h)
}

impl CacheKey {
    fn account_hash(&self) -> String {
        account_hash(&self.server, &self.username)
    }

    fn file_name(&self) -> String {
        let cat = if self.category.is_empty() {
            "all"
        } else {
            &self.category
        };
        let safe = |s: &str| -> String {
            s.chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect()
        };
        format!("{}__{}.json", safe(&self.action), safe(cat))
    }

    fn id(&self) -> String {
        format!("{}/{}", self.account_hash(), self.file_name())
    }
}

/// File della cache: `{"fetched_at":…,"items":[…]}`. Gli elementi restano JSON grezzo
/// (validato, non ricostruito).
#[derive(Deserialize)]
struct Entry {
    fetched_at: u64,
    items: Box<RawValue>,
}

/// Evento inviato alla UI quando l'aggiornamento in background è salvato: solo quale lista,
/// la UI la rilegge con lo stesso comando (ora la cache è recente e arriva dal disco).
#[derive(Debug, Clone, Serialize)]
struct ListUpdated {
    // account della lista: la UI ignora gli aggiornamenti arrivati dopo un cambio di playlist
    server: String,
    username: String,
    action: String,
    category_id: String,
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

/// Lista salvata: data e JSON degli elementi (un array), `None` se manca o non è valida.
fn read_entry(path: &Path) -> Option<(u64, Box<RawValue>)> {
    let bytes = std::fs::read(path).ok()?;
    let entry: Entry = serde_json::from_slice(&bytes).ok()?;
    entry
        .items
        .get()
        .starts_with('[')
        .then_some((entry.fetched_at, entry.items))
}

/// Salva la lista; `items` è il JSON dell'array degli elementi.
fn write_entry(path: &Path, fetched_at: u64, items: &str) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let mut body = String::with_capacity(items.len() + 40);
    let _ = write!(body, "{{\"fetched_at\":{},\"items\":", fetched_at);
    body.push_str(items);
    body.push('}');
    // scrittura atomica: un file a metà non viene mai letto
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn read(app: &AppHandle, key: &CacheKey) -> Option<(u64, Box<RawValue>)> {
    read_entry(&entry_path(app, key)?)
}

/// Serializza gli elementi scaricati e li salva; restituisce il loro JSON.
fn store<T: Serialize>(
    app: &AppHandle,
    key: &CacheKey,
    fetched_at: u64,
    items: &[T],
) -> Result<String, String> {
    let json = serde_json::to_string(items).map_err(|e| e.to_string())?;
    if let Some(path) = entry_path(app, key) {
        write_entry(&path, fetched_at, &json);
    }
    Ok(json)
}

/// Risposta dei comandi lista, `{"items":[…],"from_cache":…,"fetched_at":…}`, composta
/// attorno al JSON degli elementi senza riserializzarli.
fn listing(items: &str, from_cache: bool, fetched_at: u64) -> String {
    let mut out = String::with_capacity(items.len() + 64);
    out.push_str("{\"items\":");
    out.push_str(items);
    let _ = write!(
        out,
        ",\"from_cache\":{},\"fetched_at\":{}}}",
        from_cache, fetched_at
    );
    out
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

/// `policy`: "prefer" usa la cache se recente, "refresh" scarica sempre. La risposta è il
/// JSON di `{items, from_cache, fetched_at}`.
pub async fn load_list<T, F, Fut>(
    app: AppHandle,
    key: CacheKey,
    policy: &str,
    fetch: F,
) -> Result<Response, String>
where
    T: Serialize + Send + 'static,
    F: Fn() -> Fut + Send + 'static,
    Fut: Future<Output = Result<Vec<T>, String>> + Send + 'static,
{
    let cached = if policy == "refresh" {
        None
    } else {
        read(&app, &key)
    };
    let now = now_secs();
    if let Some((fetched_at, items)) = cached {
        let age = now.saturating_sub(fetched_at);
        if age < MAX_AGE_SECS {
            let id = key.id();
            if age >= FRESH_SECS && begin(&id) {
                tauri::async_runtime::spawn(async move {
                    if let Ok(fresh) = fetch().await {
                        let at = now_secs();
                        if store(&app, &key, at, &fresh).is_ok() {
                            let _ = app.emit(
                                "list-updated",
                                ListUpdated {
                                    server: key.server.clone(),
                                    username: key.username.clone(),
                                    action: key.action.clone(),
                                    category_id: key.category.clone(),
                                    fetched_at: at,
                                },
                            );
                        }
                    }
                    end(&id);
                });
            }
            return Ok(Response::new(listing(items.get(), true, fetched_at)));
        }
        // cache vecchia: si prova a scaricare, ma senza rete resta meglio di niente
        return Ok(Response::new(match fetch().await {
            Ok(fresh) => listing(&store(&app, &key, now, &fresh)?, false, now),
            Err(_) => listing(items.get(), true, fetched_at),
        }));
    }
    let fresh = fetch().await?;
    Ok(Response::new(listing(
        &store(&app, &key, now, &fresh)?,
        false,
        now,
    )))
}

/// Cancella tutte le liste salvate, guida TV compresa ("Svuota cache").
#[tauri::command]
pub fn clear_list_cache(app: AppHandle) -> Result<(), String> {
    crate::guide::forget();
    match lists_dir(&app) {
        Some(dir) if dir.exists() => std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Impossibile svuotare la cache: {}", e)),
        _ => Ok(()),
    }
}

/// Cancella le liste salvate e la guida TV di una sola playlist (playlist rimossa).
#[tauri::command]
pub fn clear_account_cache(app: AppHandle, server: String, username: String) -> Result<(), String> {
    crate::guide::forget();
    match account_dir(&app, &server, &username) {
        Some(dir) if dir.exists() => std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Impossibile svuotare la cache: {}", e)),
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
    fn account_hash_is_stable() {
        // vettori di riferimento di FNV-1a a 64 bit
        assert_eq!(fnv1a(FNV_OFFSET, b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a(FNV_OFFSET, b"a"), 0xaf63_dc4c_8601_ec8c);
        // valore fisso: se cambia, le cache già salvate non vengono più trovate
        assert_eq!(key("1").account_hash(), "06c04b313074557a");
        let mut spaced = key("1");
        spaced.username = "  mario ".into();
        assert_eq!(spaced.account_hash(), key("1").account_hash());
    }

    #[test]
    fn entry_round_trip_keeps_items_json() {
        let dir = std::env::temp_dir().join(format!("xp-cache-test-{}", std::process::id()));
        let path = dir.join("acct").join("get_live_streams__all.json");
        let items = r#"[{"stream_id":"1","name":"Uno"},{"stream_id":"2","name":"Due \"x\""}]"#;
        write_entry(&path, 1234, items);
        let (at, raw) = read_entry(&path).expect("lista salvata");
        assert_eq!(at, 1234);
        assert_eq!(raw.get(), items);

        // risposta dei comandi: JSON valido con gli elementi intatti
        let v: serde_json::Value = serde_json::from_str(&listing(raw.get(), true, at)).unwrap();
        assert_eq!(v["from_cache"], true);
        assert_eq!(v["fetched_at"], 1234);
        assert_eq!(v["items"][1]["name"], "Due \"x\"");

        // file troncato o con un formato diverso: come se non ci fosse
        std::fs::write(&path, r#"{"fetched_at":1,"items":[{"a":1}"#).unwrap();
        assert!(read_entry(&path).is_none());
        std::fs::write(&path, r#"{"fetched_at":1,"items":{"a":1}}"#).unwrap();
        assert!(read_entry(&path).is_none());
        let _ = std::fs::remove_dir_all(&dir);
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
