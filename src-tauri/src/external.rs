//! Apertura dello stream in un player esterno (mpv, mpv.net, VLC).

use std::io;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use reqwest::Url;

#[cfg(windows)]
use crate::util::CREATE_NO_WINDOW;
use crate::util::{env_path, USER_AGENT};

pub fn player_candidates(name: &str, known: Vec<Option<PathBuf>>) -> Vec<PathBuf> {
    let mut out = vec![PathBuf::from(name)];
    out.extend(known.into_iter().flatten().filter(|p| p.is_file()));
    out
}

pub fn spawn_detached(cmd: &mut Command) -> io::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ())
}

#[tauri::command]
pub fn open_in_external_player(
    stream_url: String,
    title: Option<String>,
    live: Option<bool>,
    prefer: Option<String>,
) -> Result<String, String> {
    let url = stream_url.trim().to_string();
    let parsed = Url::parse(&url).map_err(|_| "URL dello stream non valido".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Sono supportati solo URL http:// e https://".to_string());
    }
    let title = title.unwrap_or_default().replace(['\r', '\n', '"'], " ");
    let live = live.unwrap_or(false);
    // il player esterno ha bisogno della connessione al provider
    crate::transcode::release_parked();
    // player preferito dalle impostazioni; se manca si prova l'altro
    let order: [Opener; 2] = if prefer.as_deref() == Some("vlc") {
        [open_vlc, open_mpv]
    } else {
        [open_mpv, open_vlc]
    };
    order
        .iter()
        .find_map(|open| open(&url, &title, live))
        .ok_or_else(|| {
            "Nessun player esterno trovato. Installa mpv (https://mpv.io) o VLC (winget install VideoLAN.VLC).".to_string()
        })
}

/// Avvia un player esterno su (url, titolo, live) e ne restituisce il nome; `None` se non parte.
type Opener = fn(&str, &str, bool) -> Option<String>;

fn open_mpv(url: &str, title: &str, live: bool) -> Option<String> {
    let mpv = player_candidates(
        "mpv",
        vec![
            env_path("ProgramFiles", &["mpv", "mpv.exe"]),
            env_path("LOCALAPPDATA", &["Programs", "mpv", "mpv.exe"]),
            env_path(
                "USERPROFILE",
                &["scoop", "apps", "mpv", "current", "mpv.exe"],
            ),
            env_path("USERPROFILE", &["scoop", "shims", "mpv.exe"]),
            env_path("ProgramData", &["chocolatey", "bin", "mpv.exe"]),
            env_path("LOCALAPPDATA", &["Programs", "mpv.net", "mpvnet.exe"]),
            env_path("ProgramFiles", &["mpv.net", "mpvnet.exe"]),
        ],
    );
    for exe in mpv {
        let is_mpvnet = exe
            .file_name()
            .map(|n| n.to_string_lossy().to_ascii_lowercase().contains("mpvnet"))
            .unwrap_or(false);
        let mut cmd = Command::new(&exe);
        cmd.arg(format!("--user-agent={}", USER_AGENT))
            .arg("--force-window=immediate")
            .arg("--keep-open=no")
            .arg("--hwdec=auto-safe");
        if live {
            // buffer ridotto: avvio rapido e latenza bassa, con margine contro i micro-scatti
            cmd.arg("--cache=yes")
                .arg("--cache-secs=2")
                .arg("--demuxer-readahead-secs=2")
                .arg("--video-sync=audio");
        } else {
            cmd.arg("--cache=yes");
        }
        if !title.is_empty() {
            cmd.arg(format!("--force-media-title={}", title));
        }
        if !is_mpvnet {
            cmd.arg("--");
        }
        cmd.arg(url);
        if spawn_detached(&mut cmd).is_ok() {
            return Some(if is_mpvnet { "mpv.net" } else { "mpv" }.to_string());
        }
    }
    None
}

fn open_vlc(url: &str, title: &str, live: bool) -> Option<String> {
    let vlc = player_candidates(
        "vlc",
        vec![
            env_path("ProgramFiles", &["VideoLAN", "VLC", "vlc.exe"]),
            env_path("ProgramFiles(x86)", &["VideoLAN", "VLC", "vlc.exe"]),
            env_path(
                "USERPROFILE",
                &["scoop", "apps", "vlc", "current", "vlc.exe"],
            ),
        ],
    );
    for exe in vlc {
        let mut cmd = Command::new(&exe);
        cmd.arg(format!("--http-user-agent={}", USER_AGENT))
            .arg(if live {
                "--network-caching=1000"
            } else {
                "--network-caching=3000"
            });
        if !title.is_empty() {
            cmd.arg(format!("--meta-title={}", title));
        }
        cmd.arg(url);
        if spawn_detached(&mut cmd).is_ok() {
            return Some("VLC".to_string());
        }
    }
    None
}
