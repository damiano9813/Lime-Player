//! Rilevamento di ffmpeg/encoder, analisi con ffprobe e argomenti di conversione.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::Value;

#[cfg(windows)]
use crate::util::CREATE_NO_WINDOW;
use crate::util::{env_path, preview, USER_AGENT};
use crate::xtream::field;

// ---------------------------------------------------------------------------
// ffmpeg: WebView2 non decodifica AC3/E-AC3/DTS/MP2, MPEG-2 video e spesso HEVC.
// Solo le tracce non supportate vengono convertite (audio -> AAC, video -> H.264
// con encoder hardware se disponibile); le altre vengono copiate senza perdite.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct MediaTools {
    pub ffmpeg: Option<PathBuf>,
    pub ffprobe: Option<PathBuf>,
    pub encoder: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaCaps {
    pub ffmpeg: Option<String>,
    pub ffprobe: Option<String>,
    pub h264_encoder: Option<String>,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ProbeInfo {
    pub container: String,
    pub duration: f64,
    pub video_codec: String,
    pub video_profile: String,
    pub pix_fmt: String,
    pub field_order: String,
    pub width: i64,
    pub height: i64,
    pub audio_codec: String,
    pub audio_channels: i64,
    pub video_tracks: usize,
    pub audio_tracks: usize,
}

pub static MEDIA_TOOLS: Mutex<Option<Arc<MediaTools>>> = Mutex::new(None);

pub fn tool_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    let known = [
        env_path("LOCALAPPDATA", &["Microsoft", "WinGet", "Links"]),
        env_path("ProgramFiles", &["ffmpeg", "bin"]),
        Some(PathBuf::from(r"C:\ffmpeg\bin")),
        env_path("USERPROFILE", &["scoop", "shims"]),
        env_path("USERPROFILE", &["scoop", "apps", "ffmpeg", "current", "bin"]),
        env_path("ProgramData", &["chocolatey", "bin"]),
    ];
    dirs.extend(known.into_iter().flatten());
    // pacchetti winget (Gyan.FFmpeg, BtbN.FFmpeg): ...\Packages\<id>\<build>\bin
    if let Some(pkgs) = env_path("LOCALAPPDATA", &["Microsoft", "WinGet", "Packages"]) {
        if let Ok(entries) = std::fs::read_dir(&pkgs) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_ascii_lowercase();
                if !name.contains("ffmpeg") {
                    continue;
                }
                if let Ok(builds) = std::fs::read_dir(e.path()) {
                    for b in builds.flatten() {
                        dirs.push(b.path().join("bin"));
                    }
                }
            }
        }
    }
    dirs
}

pub fn find_tool(name: &str) -> Option<PathBuf> {
    let file = format!("{}.exe", name);
    tool_dirs()
        .into_iter()
        .map(|d| d.join(&file))
        .find(|p| p.is_file())
}

pub fn tokio_cmd(exe: &Path) -> tokio::process::Command {
    let mut std_cmd = Command::new(exe);
    std_cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std_cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut cmd = tokio::process::Command::from(std_cmd);
    cmd.kill_on_drop(true);
    cmd
}

pub async fn run_output(exe: &Path, args: &[&str], secs: u64) -> Option<std::process::Output> {
    let mut cmd = tokio_cmd(exe);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    match tokio::time::timeout(Duration::from_secs(secs), cmd.output()).await {
        Ok(Ok(out)) => Some(out),
        _ => None,
    }
}

pub fn encoder_args(encoder: &str) -> Vec<&'static str> {
    match encoder {
        "h264_nvenc" => vec![
            "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-rc", "vbr", "-cq", "23",
            "-b:v", "0", "-maxrate", "12M", "-bufsize", "6M", "-g", "50", "-bf", "0",
            "-pix_fmt", "yuv420p",
        ],
        "h264_qsv" => vec![
            "-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "23", "-look_ahead",
            "0", "-g", "50", "-bf", "0", "-pix_fmt", "nv12",
        ],
        "h264_amf" => vec![
            "-c:v", "h264_amf", "-usage", "lowlatency", "-quality", "speed", "-rc", "cqp",
            "-qp_i", "22", "-qp_p", "24", "-g", "50", "-bf", "0", "-pix_fmt", "yuv420p",
        ],
        _ => vec![
            "-c:v", "libx264", "-preset", "superfast", "-tune", "zerolatency", "-crf", "23",
            "-g", "50", "-bf", "0", "-pix_fmt", "yuv420p",
        ],
    }
}

pub async fn detect_media_tools() -> MediaTools {
    let ffmpeg = match find_tool("ffmpeg") {
        Some(p) => p,
        None => return MediaTools::default(),
    };
    let ffprobe = ffmpeg
        .parent()
        .map(|d| d.join("ffprobe.exe"))
        .filter(|p| p.is_file())
        .or_else(|| find_tool("ffprobe"));
    let version = run_output(&ffmpeg, &["-hide_banner", "-version"], 8)
        .await
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string()
        })
        .unwrap_or_default();
    // un encoder hardware elencato non è detto che funzioni: si prova davvero
    let mut encoder = None;
    for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"] {
        let mut args = vec![
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=black:s=640x360:r=25:d=0.4",
        ];
        args.extend(encoder_args(enc));
        args.extend(["-f", "null", "-"]);
        if let Some(out) = run_output(&ffmpeg, &args, 15).await {
            if out.status.success() {
                encoder = Some(enc.to_string());
                break;
            }
        }
    }
    MediaTools {
        ffmpeg: Some(ffmpeg),
        ffprobe,
        encoder,
        version,
    }
}

pub async fn media_tools(refresh: bool) -> Arc<MediaTools> {
    if !refresh {
        if let Ok(guard) = MEDIA_TOOLS.lock() {
            if let Some(t) = guard.as_ref() {
                if t.ffmpeg.is_some() {
                    return t.clone();
                }
            }
        }
    }
    let tools = Arc::new(detect_media_tools().await);
    if let Ok(mut guard) = MEDIA_TOOLS.lock() {
        *guard = Some(tools.clone());
    }
    tools
}

#[tauri::command]
pub async fn get_media_capabilities(refresh: Option<bool>) -> Result<MediaCaps, String> {
    let t = media_tools(refresh.unwrap_or(false)).await;
    Ok(MediaCaps {
        ffmpeg: t.ffmpeg.as_ref().map(|p| p.display().to_string()),
        ffprobe: t.ffprobe.as_ref().map(|p| p.display().to_string()),
        h264_encoder: t.encoder.clone(),
        version: t.version.clone(),
    })
}

#[tauri::command]
pub async fn probe_stream(stream_url: String) -> Result<ProbeInfo, String> {
    let url = Url::parse(stream_url.trim()).map_err(|_| "URL dello stream non valido".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Sono supportati solo URL http:// e https://".to_string());
    }
    let tools = media_tools(false).await;
    let ffprobe = tools
        .ffprobe
        .clone()
        .ok_or_else(|| "ffprobe non trovato: installa ffmpeg (winget install Gyan.FFmpeg)".to_string())?;
    let out = run_output(
        &ffprobe,
        &[
            "-v", "error", "-user_agent", USER_AGENT, "-rw_timeout", "15000000", "-probesize",
            "3000000", "-analyzeduration", "3000000", "-print_format", "json", "-show_format",
            "-show_streams", url.as_str(),
        ],
        25,
    )
    .await
    .ok_or_else(|| "Analisi dello stream scaduta".to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffprobe: {}", preview(err.trim())));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe: {}", e))?;
    let mut info = ProbeInfo::default();
    if let Some(format) = v.get("format") {
        info.container = field(format, "format_name");
        info.duration = field(format, "duration").parse::<f64>().unwrap_or(0.0);
    }
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let attached = s
                .get("disposition")
                .map(|d| field(d, "attached_pic") == "1")
                .unwrap_or(false);
            match field(s, "codec_type").as_str() {
                "video" if !attached => {
                    info.video_tracks += 1;
                    if info.video_tracks == 1 {
                        info.video_codec = field(s, "codec_name");
                        info.video_profile = field(s, "profile");
                        info.pix_fmt = field(s, "pix_fmt");
                        info.field_order = field(s, "field_order");
                        info.width = field(s, "width").parse().unwrap_or(0);
                        info.height = field(s, "height").parse().unwrap_or(0);
                    }
                }
                "audio" => {
                    info.audio_tracks += 1;
                    if info.audio_tracks == 1 {
                        info.audio_codec = field(s, "codec_name");
                        info.audio_channels = field(s, "channels").parse().unwrap_or(0);
                    }
                }
                _ => {}
            }
        }
    }
    Ok(info)
}

pub fn push_args(args: &mut Vec<String>, items: &[&str]) {
    args.extend(items.iter().map(|s| s.to_string()));
}

/// `from_pipe`: l'ingresso arriva su stdin dal proxy (che ha già scartato la raffica
/// iniziale), quindi niente opzioni HTTP.
pub fn build_ffmpeg_args(
    url: &str,
    v: &str,
    a: &str,
    live: bool,
    ss: f64,
    encoder: &str,
    from_pipe: bool,
) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    push_args(&mut args, &["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if !from_pipe {
        push_args(
            &mut args,
            &[
                "-user_agent", USER_AGENT, "-reconnect", "1", "-reconnect_on_network_error", "1",
                "-reconnect_delay_max", "3",
            ],
        );
    }
    if live {
        if !from_pipe {
            // dopo un cambio canale il provider può contare ancora per un attimo la
            // connessione precedente (limite connessioni): si riprova invece di fallire
            push_args(&mut args, &["-reconnect_streamed", "1", "-reconnect_on_http_error", "4xx,5xx"]);
        }
        // analisi breve e nessun buffer interno: il primo pacchetto esce il prima possibile
        push_args(
            &mut args,
            &[
                "-fflags", "+nobuffer+discardcorrupt+genpts", "-flags", "low_delay", "-probesize",
                "1000000", "-analyzeduration", "1000000",
            ],
        );
    } else {
        push_args(&mut args, &["-fflags", "+genpts", "-probesize", "5000000", "-analyzeduration", "5000000"]);
        if ss > 0.5 {
            args.push("-ss".to_string());
            args.push(format!("{:.3}", ss));
        }
    }
    if from_pipe {
        push_args(&mut args, &["-f", "mpegts"]);
    }
    push_args(&mut args, &["-i", url, "-map", "0:v:0?", "-map", "0:a:0?", "-sn", "-dn"]);
    if v == "h264" {
        // i canali DVB sono spesso interlacciati (1080i/576i), che WebView2 non decodifica:
        // si deinterlaccia a doppio frame rate (50p) solo i fotogrammi marcati come interlacciati
        push_args(&mut args, &["-vf", "bwdif=mode=send_field:deint=interlaced"]);
        push_args(&mut args, &encoder_args(encoder));
    } else {
        push_args(&mut args, &["-c:v", "copy"]);
    }
    if a == "copy" {
        push_args(&mut args, &["-c:a", "copy"]);
    } else {
        push_args(&mut args, &["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]);
    }
    push_args(
        &mut args,
        &["-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "pipe:1"],
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(args: &[String], item: &str) -> Option<usize> {
        args.iter().position(|a| a == item)
    }

    #[test]
    fn live_video_conversion_from_pipe() {
        let a = build_ffmpeg_args("pipe:0", "h264", "aac", true, 0.0, "h264_nvenc", true);
        let i = pos(&a, "-i").unwrap();
        assert_eq!(a[i + 1], "pipe:0");
        assert_eq!(a[i - 2..i], ["-f".to_string(), "mpegts".to_string()]);
        assert!(pos(&a, "-user_agent").is_none(), "niente opzioni HTTP su stdin");
        assert!(pos(&a, "-reconnect").is_none());
        assert!(a.iter().any(|x| x.starts_with("bwdif=")), "deinterlacciamento atteso");
        assert!(pos(&a, "h264_nvenc").unwrap() > i);
        assert_eq!(a[pos(&a, "-c:a").unwrap() + 1], "aac");
        assert_eq!(a.last().unwrap(), "pipe:1");
    }

    #[test]
    fn live_audio_only_from_url() {
        let a = build_ffmpeg_args("http://h/live/1.ts", "copy", "aac", true, 0.0, "libx264", false);
        assert!(pos(&a, "-user_agent").unwrap() < pos(&a, "-i").unwrap());
        assert!(pos(&a, "-reconnect_streamed").is_some());
        assert_eq!(a[pos(&a, "-c:v").unwrap() + 1], "copy");
        assert!(!a.iter().any(|x| x.starts_with("bwdif=")));
    }

    #[test]
    fn vod_seek_goes_before_input() {
        let a = build_ffmpeg_args("http://h/movie/1.mkv", "copy", "copy", false, 120.5, "libx264", false);
        let ss = pos(&a, "-ss").expect("-ss atteso");
        assert_eq!(a[ss + 1], "120.500");
        assert!(ss < pos(&a, "-i").unwrap());
        assert!(pos(&a, "-reconnect_streamed").is_none());
        assert_eq!(a[pos(&a, "-c:a").unwrap() + 1], "copy");
        let near_zero = build_ffmpeg_args("http://h/movie/1.mkv", "copy", "copy", false, 0.2, "libx264", false);
        assert!(pos(&near_zero, "-ss").is_none(), "seek trascurabile ignorato");
    }

    #[test]
    fn every_encoder_has_args() {
        for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "libx264", "sconosciuto"] {
            let args = encoder_args(enc);
            assert_eq!(args[0], "-c:v");
            assert!(args.contains(&"-pix_fmt"));
        }
    }
}
