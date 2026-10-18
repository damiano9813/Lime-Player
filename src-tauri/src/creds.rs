//! Credenziali salvate: server e utente in `credentials.json` nella cartella di configurazione
//! dell'app, la password in Gestione credenziali di Windows (crate `keyring`). Il vecchio file
//! con la password in chiaro viene migrato al primo caricamento.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const SERVICE: &str = "com.xtreamplayer.desktop";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedCredentials {
    pub server: String,
    pub username: String,
    pub password: String,
}

/// Contenuto di `credentials.json`: niente password.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredAccount {
    pub server: String,
    pub username: String,
}

impl StoredAccount {
    /// Nome della voce nel vault: una per coppia utente/server.
    pub fn vault_key(&self) -> String {
        format!("{}@{}", self.username, self.server)
    }
}

/// Lettura di `credentials.json`, anche nel vecchio formato con `password` in chiaro.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFile {
    pub account: StoredAccount,
    pub legacy_password: Option<String>,
}

pub fn parse_credentials_file(text: &str) -> Option<ParsedFile> {
    #[derive(Deserialize)]
    struct Raw {
        server: String,
        username: String,
        #[serde(default)]
        password: Option<String>,
    }
    let raw: Raw = serde_json::from_str(text).ok()?;
    if raw.server.trim().is_empty() || raw.username.trim().is_empty() {
        return None;
    }
    Some(ParsedFile {
        account: StoredAccount {
            server: raw.server,
            username: raw.username,
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

fn write_account(path: &Path, account: &StoredAccount) -> Result<(), String> {
    let json = serde_json::to_string_pretty(account).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("Salvataggio credenziali fallito: {}", e))
}

fn read_file(path: &Path) -> Option<ParsedFile> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| parse_credentials_file(&t))
}

pub fn save_with(path: &Path, vault: &dyn Vault, creds: SavedCredentials) -> Result<(), String> {
    let account = StoredAccount {
        server: creds.server,
        username: creds.username,
    };
    // la password del vecchio account non serve più
    if let Some(old) = read_file(path) {
        if old.account.vault_key() != account.vault_key() {
            let _ = vault.delete(&old.account.vault_key());
        }
    }
    vault
        .set(&account.vault_key(), &creds.password)
        .map_err(|e| format!("Gestione credenziali di Windows non disponibile: {}", e))?;
    write_account(path, &account)
}

pub fn load_with(path: &Path, vault: &dyn Vault) -> Result<Option<SavedCredentials>, String> {
    let Some(parsed) = read_file(path) else {
        return Ok(None);
    };
    let key = parsed.account.vault_key();
    if let Some(pw) = parsed.legacy_password {
        // migrazione: password nel vault, file riscritto senza; se il vault non risponde il
        // file resta com'era e si riprova al prossimo avvio
        if vault.set(&key, &pw).is_ok() {
            write_account(path, &parsed.account)?;
        }
        return Ok(Some(SavedCredentials {
            server: parsed.account.server,
            username: parsed.account.username,
            password: pw,
        }));
    }
    Ok(vault.get(&key)?.map(|password| SavedCredentials {
        server: parsed.account.server,
        username: parsed.account.username,
        password,
    }))
}

pub fn clear_with(path: &Path, vault: &dyn Vault) -> Result<(), String> {
    if let Some(parsed) = read_file(path) {
        vault.delete(&parsed.account.vault_key())?;
    }
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
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
    let creds = SavedCredentials {
        server,
        username,
        password,
    };
    save_with(&credentials_path(&app)?, &KeyringVault, creds)
}

#[tauri::command]
pub fn load_credentials(app: AppHandle) -> Result<Option<SavedCredentials>, String> {
    load_with(&credentials_path(&app)?, &KeyringVault)
}

#[tauri::command]
pub fn clear_credentials(app: AppHandle) -> Result<(), String> {
    clear_with(&credentials_path(&app)?, &KeyringVault)
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

    const LEGACY: &str =
        r#"{ "server": "http://h:8080", "username": "mario", "password": "segreta" }"#;

    #[test]
    fn parse_old_and_new_format() {
        let old = parse_credentials_file(LEGACY).unwrap();
        assert_eq!(old.account.vault_key(), "mario@http://h:8080");
        assert_eq!(old.legacy_password.as_deref(), Some("segreta"));
        let new = parse_credentials_file(r#"{ "server": "http://h:8080", "username": "mario" }"#)
            .unwrap();
        assert_eq!(new.account, old.account);
        assert_eq!(new.legacy_password, None);
        let empty_pw =
            parse_credentials_file(r#"{ "server": "s", "username": "u", "password": "" }"#)
                .unwrap();
        assert_eq!(empty_pw.legacy_password, None);
        assert!(parse_credentials_file("non json").is_none());
        assert!(parse_credentials_file(r#"{ "server": "", "username": "u" }"#).is_none());
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
    fn save_load_clear() {
        let path = temp_file("salva");
        let vault = MemVault::default();
        assert_eq!(load_with(&path, &vault).unwrap(), None);
        let a = SavedCredentials {
            server: "http://a".into(),
            username: "u1".into(),
            password: "p1".into(),
        };
        save_with(&path, &vault, a.clone()).unwrap();
        assert!(!std::fs::read_to_string(&path).unwrap().contains("p1"));
        assert_eq!(load_with(&path, &vault).unwrap(), Some(a));
        // cambio account: la vecchia password esce dal vault
        let b = SavedCredentials {
            server: "http://b".into(),
            username: "u2".into(),
            password: "p2".into(),
        };
        save_with(&path, &vault, b.clone()).unwrap();
        assert_eq!(vault.get("u1@http://a").unwrap(), None);
        assert_eq!(load_with(&path, &vault).unwrap(), Some(b));
        clear_with(&path, &vault).unwrap();
        assert!(!path.exists());
        assert!(vault.items.borrow().is_empty());
        // file senza password nel vault: nessun accesso automatico
        std::fs::write(&path, r#"{ "server": "http://a", "username": "u1" }"#).unwrap();
        assert_eq!(load_with(&path, &vault).unwrap(), None);
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
