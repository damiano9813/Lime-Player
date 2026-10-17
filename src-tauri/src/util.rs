//! Costanti e piccoli helper condivisi tra i moduli.

use std::path::PathBuf;

pub const USER_AGENT: &str = "IPTVSmartersPro";

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
pub const CORS_HEADERS: &str = "Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Allow-Private-Network: true\r\n\
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n";

pub fn describe_reqwest_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "Timeout: il server non ha risposto in tempo".to_string()
    } else if e.is_connect() {
        format!("Impossibile connettersi al server: {}", e)
    } else if e.is_redirect() {
        "Troppi redirect dal server".to_string()
    } else if e.is_body() || e.is_decode() {
        format!("Risposta interrotta o non leggibile: {}", e)
    } else {
        format!("Errore di rete: {}", e)
    }
}

pub fn preview(s: &str) -> String {
    let p: String = s.chars().take(160).collect();
    p.replace(['\r', '\n'], " ")
}

pub fn env_path(var: &str, rest: &[&str]) -> Option<PathBuf> {
    let mut p = PathBuf::from(std::env::var_os(var)?);
    for part in rest {
        p.push(part);
    }
    Some(p)
}
