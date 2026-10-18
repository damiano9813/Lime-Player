//! Playlist salvate: server, utente e nome di ogni account in `credentials.json` nella cartella
//! di configurazione dell'app, le password in Gestione credenziali di Windows (crate `keyring`).
//! I vecchi file con un solo account (e quelli ancora più vecchi con la password in chiaro)
//! vengono migrati al primo caricamento.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.xtreamplayer.desktop";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedCredentials {
    pub server: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub name: String,
}

/// Una playlist in `credentials.json`: niente password.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredAccount {
    pub server: String,
    pub username: String,
    /// nome scelto dall'utente (vuoto: si mostra l'username)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
}

impl StoredAccount {
    /// Nome della voce nel vault: una per coppia utente/server.
    pub fn vault_key(&self) -> String {
        vault_key(&self.server, &self.username)
    }
}

pub fn vault_key(server: &str, username: &str) -> String {
    format!("{}@{}", username, server)
}

/// Contenuto di `credentials.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AccountsFile {
    #[serde(default)]
    pub accounts: Vec<StoredAccount>,
    /// `vault_key` della playlist con cui accedere all'avvio (nessuna: si mostra l'elenco)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<String>,
}

impl AccountsFile {
    fn find(&self, server: &str, username: &str) -> Option<&StoredAccount> {
        let key = vault_key(server, username);
        self.accounts.iter().find(|a| a.vault_key() == key)
    }
}

/// Voce dell'elenco per la UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountSummary {
    pub server: String,
    pub username: String,
    pub name: String,
    /// playlist usata per l'accesso automatico
    pub last: bool,
}

/// Lettura di `credentials.json`, anche nei vecchi formati a un solo account.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFile {
    pub file: AccountsFile,
    /// password in chiaro del formato più vecchio (un solo account)
    pub legacy_password: Option<String>,
}

pub fn parse_credentials_file(text: &str) -> Option<ParsedFile> {
    #[derive(Deserialize)]
    struct Single {
        server: String,
        username: String,
        #[serde(default)]
        password: Option<String>,
    }
    let valid = |a: &StoredAccount| !a.server.trim().is_empty() && !a.username.trim().is_empty();
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("accounts").is_some() {
        let mut file: AccountsFile = serde_json::from_value(value).ok()?;
        file.accounts.retain(valid);
        return Some(ParsedFile {
            file,
            legacy_password: None,
        });
    }
    let raw: Single = serde_json::from_value(value).ok()?;
    let account = StoredAccount {
        server: raw.server,
        username: raw.username,
        name: String::new(),
    };
    if !valid(&account) {
        return None;
    }
    // con un solo account salvato l'app accedeva sempre in automatico
    Some(ParsedFile {
        file: AccountsFile {
            last: Some(account.vault_key()),
            accounts: vec![account],
        },
        legacy_password: raw.password.filter(|p| !p.is_empty()),
    })
}

/// Dove tenere le password: Gestione credenziali in produzione, memoria nei test.
pub trait Vault {
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn set(&self, key: &str, password: &str) -> Result<(), String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

pub struct KeyringVault;

impl KeyringVault {
    fn entry(key: &str) -> Result<keyring::Entry, String> {
        // nome leggibile in Gestione credenziali > Credenziali generiche
        let target = format!("Xtream Player/{}", key);
        keyring::Entry::new_with_target(&target, SERVICE, key).map_err(|e| e.to_string())
    }
}

impl Vault for KeyringVault {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match Self::entry(key)?.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, key: &str, password: &str) -> Result<(), String> {
        Self::entry(key)?
            .set_password(password)
            .map_err(|e| e.to_string())
    }
    fn delete(&self, key: &str) -> Result<(), String> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

fn write_file(path: &Path, file: &AccountsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Salvataggio credenziali fallito: {}", e))
}

/// Legge il file e lo porta al formato attuale: la vecchia password in chiaro passa nel vault e il
/// file si riscrive senza. Se il vault non risponde il file resta com'era (si riprova al prossimo
/// avvio) e la password torna come secondo valore.
fn read_migrated(path: &Path, vault: &dyn Vault) -> (AccountsFile, Option<String>) {
    let Some(parsed) = std::fs::read_to_string(path)
        .ok()
        .and_then(|t| parse_credentials_file(&t))
    else {
        return (AccountsFile::default(), None);
    };
    let file = parsed.file;
    match (parsed.legacy_password, file.accounts.first()) {
        (Some(pw), Some(a)) => {
            if vault.set(&a.vault_key(), &pw).is_ok() && write_file(path, &file).is_ok() {
                (file, None)
            } else {
                (file, Some(pw))
            }
        }
        _ => (file, None),
    }
}

fn with_password(
    vault: &dyn Vault,
    account: &StoredAccount,
    legacy: Option<String>,
) -> Result<Option<SavedCredentials>, String> {
    let password = match legacy {
        Some(pw) => Some(pw),
        None => vault.get(&account.vault_key())?,
    };
    Ok(password.map(|password| SavedCredentials {
        server: account.server.clone(),
        username: account.username.clone(),
        password,
        name: account.name.clone(),
    }))
}

/// Aggiunge la playlist (o ne aggiorna password e nome) e la segna per l'accesso automatico.
pub fn save_with(path: &Path, vault: &dyn Vault, creds: SavedCredentials) -> Result<(), String> {
    let (mut file, _) = read_migrated(path, vault);
    let key = vault_key(&creds.server, &creds.username);
    vault
        .set(&key, &creds.password)
        .map_err(|e| format!("Gestione credenziali di Windows non disponibile: {}", e))?;
    let name = creds.name.trim().to_string();
    match file.accounts.iter_mut().find(|a| a.vault_key() == key) {
        // un nome vuoto (accesso da elenco o form senza nome) non cancella quello scelto
        Some(a) => {
            if !name.is_empty() {
                a.name = name;
            }
        }
        None => file.accounts.push(StoredAccount {
            server: creds.server,
            username: creds.username,
            name,
        }),
    }
    file.last = Some(key);
    write_file(path, &file)
}

/// Credenziali della playlist per l'accesso automatico.
pub fn load_with(path: &Path, vault: &dyn Vault) -> Result<Option<SavedCredentials>, String> {
    let (file, legacy) = read_migrated(path, vault);
    let Some(account) = file
        .last
        .as_deref()
        .and_then(|k| file.accounts.iter().find(|a| a.vault_key() == k))
    else {
        return Ok(None);
    };
    with_password(vault, account, legacy)
}

/// Credenziali di una playlist salvata (None se manca o se il vault non ha la password).
pub fn account_with(
    path: &Path,
    vault: &dyn Vault,
    server: &str,
    username: &str,
) -> Result<Option<SavedCredentials>, String> {
    let (file, legacy) = read_migrated(path, vault);
    match file.find(server, username) {
        Some(account) => with_password(vault, account, legacy),
        None => Ok(None),
    }
}

pub fn list_with(path: &Path, vault: &dyn Vault) -> Vec<AccountSummary> {
    let (file, _) = read_migrated(path, vault);
    file.accounts
        .iter()
        .map(|a| AccountSummary {
            server: a.server.clone(),
            username: a.username.clone(),
            name: a.name.clone(),
            last: file.last.as_deref() == Some(a.vault_key().as_str()),
        })
        .collect()
}

/// Toglie la playlist dall'elenco e la sua password dal vault.
pub fn remove_with(
    path: &Path,
    vault: &dyn Vault,
    server: &str,
    username: &str,
) -> Result<(), String> {
    let (mut file, _) = read_migrated(path, vault);
    let key = vault_key(server, username);
    vault.delete(&key)?;
    file.accounts.retain(|a| a.vault_key() != key);
    if file.last.as_deref() == Some(key.as_str()) {
        file.last = None;
    }
    if file.accounts.is_empty() {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    write_file(path, &file)
}

/// Al prossimo avvio niente accesso automatico: si mostra l'elenco delle playlist.
pub fn clear_last_with(path: &Path, vault: &dyn Vault) -> Result<(), String> {
    let (mut file, _) = read_migrated(path, vault);
    if file.last.take().is_none() {
        return Ok(());
    }
    write_file(path, &file)
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
    name: Option<String>,
) -> Result<(), String> {
    let creds = SavedCredentials {
        server,
        username,
        password,
        name: name.unwrap_or_default(),
    };
    save_with(&credentials_path(&app)?, &KeyringVault, creds)
}

#[tauri::command]
pub fn load_credentials(app: AppHandle) -> Result<Option<SavedCredentials>, String> {
    load_with(&credentials_path(&app)?, &KeyringVault)
}

#[tauri::command]
pub fn list_accounts(app: AppHandle) -> Result<Vec<AccountSummary>, String> {
    Ok(list_with(&credentials_path(&app)?, &KeyringVault))
}

#[tauri::command]
pub fn load_account(
    app: AppHandle,
    server: String,
    username: String,
) -> Result<Option<SavedCredentials>, String> {
    account_with(&credentials_path(&app)?, &KeyringVault, &server, &username)
}

#[tauri::command]
pub fn remove_account(app: AppHandle, server: String, username: String) -> Result<(), String> {
    remove_with(&credentials_path(&app)?, &KeyringVault, &server, &username)
}

#[tauri::command]
pub fn clear_last_account(app: AppHandle) -> Result<(), String> {
    clear_last_with(&credentials_path(&app)?, &KeyringVault)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemVault {
        items: RefCell<HashMap<String, String>>,
        broken: bool,
    }

    impl Vault for MemVault {
        fn get(&self, key: &str) -> Result<Option<String>, String> {
            Ok(self.items.borrow().get(key).cloned())
        }
        fn set(&self, key: &str, password: &str) -> Result<(), String> {
            if self.broken {
                return Err("vault non disponibile".into());
            }
            self.items.borrow_mut().insert(key.into(), password.into());
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), String> {
            self.items.borrow_mut().remove(key);
            Ok(())
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("xp-creds-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("credentials.json")
    }

    fn creds(server: &str, username: &str, password: &str, name: &str) -> SavedCredentials {
        SavedCredentials {
            server: server.into(),
            username: username.into(),
            password: password.into(),
            name: name.into(),
        }
    }

    const LEGACY: &str =
        r#"{ "server": "http://h:8080", "username": "mario", "password": "segreta" }"#;

    #[test]
    fn parse_old_and_new_format() {
        let old = parse_credentials_file(LEGACY).unwrap();
        assert_eq!(old.file.accounts.len(), 1);
        assert_eq!(old.file.accounts[0].vault_key(), "mario@http://h:8080");
        assert_eq!(old.file.last.as_deref(), Some("mario@http://h:8080"));
        assert_eq!(old.legacy_password.as_deref(), Some("segreta"));
        let single =
            parse_credentials_file(r#"{ "server": "http://h:8080", "username": "mario" }"#)
                .unwrap();
        assert_eq!(single.file, old.file);
        assert_eq!(single.legacy_password, None);
        let empty_pw =
            parse_credentials_file(r#"{ "server": "s", "username": "u", "password": "" }"#)
                .unwrap();
        assert_eq!(empty_pw.legacy_password, None);
        assert!(parse_credentials_file("non json").is_none());
        assert!(parse_credentials_file(r#"{ "server": "", "username": "u" }"#).is_none());
        let multi = parse_credentials_file(
            r#"{ "accounts": [ { "server": "http://a", "username": "u1", "name": "Casa" },
                 { "server": "", "username": "x" }, { "server": "http://b", "username": "u2" } ],
                 "last": "u2@http://b" }"#,
        )
        .unwrap();
        assert_eq!(multi.file.accounts.len(), 2);
        assert_eq!(multi.file.accounts[0].name, "Casa");
        assert_eq!(multi.file.accounts[1].name, "");
        assert_eq!(multi.file.last.as_deref(), Some("u2@http://b"));
        assert_eq!(multi.legacy_password, None);
    }

    #[test]
    fn legacy_file_is_migrated_to_the_vault() {
        let path = temp_file("migra");
        std::fs::write(&path, LEGACY).unwrap();
        let vault = MemVault::default();
        let c = load_with(&path, &vault).unwrap().unwrap();
        assert_eq!(c.password, "segreta");
        assert_eq!(
            vault.get("mario@http://h:8080").unwrap().as_deref(),
            Some("segreta")
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("segreta") && !text.contains("password"),
            "{}",
            text
        );
        assert!(text.contains("accounts"), "{}", text);
        // secondo avvio: password letta dal vault
        assert_eq!(load_with(&path, &vault).unwrap().unwrap(), c);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn legacy_file_kept_when_vault_fails() {
        let path = temp_file("rotto");
        std::fs::write(&path, LEGACY).unwrap();
        let vault = MemVault {
            broken: true,
            ..Default::default()
        };
        assert_eq!(
            load_with(&path, &vault).unwrap().unwrap().password,
            "segreta"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), LEGACY);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn several_playlists() {
        let path = temp_file("multi");
        let vault = MemVault::default();
        assert_eq!(load_with(&path, &vault).unwrap(), None);
        assert!(list_with(&path, &vault).is_empty());
        let a = creds("http://a", "u1", "p1", "Casa");
        let b = creds("http://b", "u2", "p2", "");
        save_with(&path, &vault, a.clone()).unwrap();
        save_with(&path, &vault, b.clone()).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("p1"));
        // l'ultima salvata è quella dell'accesso automatico, la prima resta nel vault
        assert_eq!(load_with(&path, &vault).unwrap(), Some(b.clone()));
        assert_eq!(
            account_with(&path, &vault, "http://a", "u1").unwrap(),
            Some(a.clone())
        );
        assert_eq!(account_with(&path, &vault, "http://c", "u1").unwrap(), None);
        let list = list_with(&path, &vault);
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].name.as_str(), list[0].last), ("Casa", false));
        assert_eq!((list[1].username.as_str(), list[1].last), ("u2", true));
        // nuovo accesso alla prima: password aggiornata, nome tenuto, ordine invariato
        save_with(&path, &vault, creds("http://a", "u1", "p1bis", "")).unwrap();
        let again = load_with(&path, &vault).unwrap().unwrap();
        assert_eq!(
            (again.password.as_str(), again.name.as_str()),
            ("p1bis", "Casa")
        );
        assert_eq!(list_with(&path, &vault)[0].username, "u1");
        // rinomina dal form
        save_with(&path, &vault, creds("http://a", "u1", "p1bis", " Ufficio ")).unwrap();
        assert_eq!(list_with(&path, &vault)[0].name, "Ufficio");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn remove_and_clear_last() {
        let path = temp_file("rimuovi");
        let vault = MemVault::default();
        save_with(&path, &vault, creds("http://a", "u1", "p1", "")).unwrap();
        save_with(&path, &vault, creds("http://b", "u2", "p2", "")).unwrap();
        // uscita: niente accesso automatico, l'elenco resta
        clear_last_with(&path, &vault).unwrap();
        assert_eq!(load_with(&path, &vault).unwrap(), None);
        assert_eq!(list_with(&path, &vault).len(), 2);
        assert!(list_with(&path, &vault).iter().all(|a| !a.last));
        save_with(&path, &vault, creds("http://a", "u1", "p1", "")).unwrap();
        remove_with(&path, &vault, "http://a", "u1").unwrap();
        assert_eq!(vault.get("u1@http://a").unwrap(), None);
        assert_eq!(load_with(&path, &vault).unwrap(), None);
        assert_eq!(list_with(&path, &vault).len(), 1);
        // tolta l'ultima, sparisce anche il file
        remove_with(&path, &vault, "http://b", "u2").unwrap();
        assert!(!path.exists());
        assert!(vault.items.borrow().is_empty());
        // playlist senza password nel vault: nessun accesso automatico
        std::fs::write(&path, r#"{ "server": "http://a", "username": "u1" }"#).unwrap();
        assert_eq!(load_with(&path, &vault).unwrap(), None);
        assert_eq!(list_with(&path, &vault).len(), 1);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    /// Prova il vero vault di Windows: `cargo test keyring_roundtrip -- --ignored`.
    #[test]
    #[ignore]
    fn keyring_roundtrip() {
        let key = format!("test-{}@http://prova", std::process::id());
        KeyringVault.set(&key, "pw").unwrap();
        assert_eq!(KeyringVault.get(&key).unwrap().as_deref(), Some("pw"));
        KeyringVault.delete(&key).unwrap();
        assert_eq!(KeyringVault.get(&key).unwrap(), None);
    }
}
