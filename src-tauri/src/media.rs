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
    /// tutte le tracce audio, nell'ordine di `-map 0:a:N`
    pub audio: Vec<ProbeTrack>,
    /// tutte le tracce di sottotitoli, nell'ordine di `-map 0:s:N`
    pub subtitles: Vec<ProbeTrack>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct ProbeTrack {
    /// posizione tra le tracce dello stesso tipo
    pub index: usize,
    pub codec: String,
    pub lang: String,
    pub title: String,
    pub channels: i64,
    pub default: bool,
    pub forced: bool,
    /// sottotitoli testuali, convertibili in WebVTT (quelli a immagine no)
    pub text: bool,
}

/// Sottotitoli che ffmpeg converte in WebVTT; DVB, PGS e DVD sono immagini.
pub fn is_text_subtitle(codec: &str) -> bool {
    matches!(codec, "subrip" | "srt" | "ass" | "ssa" | "mov_text" | "webvtt" | "text")
}

/// Qualità della conversione video scelta nelle impostazioni (`q=` nel percorso `/t/`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Quality {
    Fast,
    Balanced,
    High,
}

impl Quality {
    pub fn parse(s: &str) -> Quality {
        match s {
            "fast" => Quality::Fast,
            "high" => Quality::High,
            _ => Quality::Balanced,
        }
    }
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

pub fn encoder_args(encoder: &str, quality: Quality) -> Vec<&'static str> {
    use Quality::*;
    let mut args: Vec<&'static str> = vec!["-c:v"];
    match encoder {
        "h264_nvenc" => {
            args.push("h264_nvenc");
            let (preset, tune, cq) = match quality {
                Fast => ("p1", "ull", "25"),
                Balanced => ("p3", "ll", "22"),
                High => ("p5", "ll", "20"),
            };
            args.extend([
                "-preset", preset, "-tune", tune, "-rc", "vbr", "-cq", cq, "-b:v", "0", "-maxrate", "12M",
                "-bufsize", "6M", "-g", "50", "-bf", "0", "-pix_fmt", "yuv420p",
            ]);
        }
        "h264_qsv" => {
            args.push("h264_qsv");
            let (preset, q) = match quality {
                Fast => ("veryfast", "25"),
                Balanced => ("faster", "22"),
                High => ("medium", "20"),
            };
            args.extend([
                "-preset", preset, "-global_quality", q, "-look_ahead", "0", "-g", "50", "-bf", "0",
                "-pix_fmt", "nv12",
            ]);
        }
        "h264_amf" => {
            args.push("h264_amf");
            let (q, qp_i, qp_p) = match quality {
                Fast => ("speed", "25", "27"),
                Balanced => ("balanced", "22", "24"),
                High => ("quality", "20", "22"),
            };
            args.extend([
                "-usage", "lowlatency", "-quality", q, "-rc", "cqp", "-qp_i", qp_i, "-qp_p", qp_p, "-g",
                "50", "-bf", "0", "-pix_fmt", "yuv420p",
            ]);
        }
        // Media Foundation: unico encoder H.264 della build LGPL inclusa nell'installer
        "h264_mf" => {
            args.push("h264_mf");
            let q = match quality {
                Fast => "50",
                Balanced => "60",
                High => "70",
            };
            args.extend([
                "-rate_control", "quality", "-quality", q, "-scenario", "live_streaming", "-g", "50", "-bf",
                "0", "-pix_fmt", "nv12",
            ]);
        }
        _ => {
            let (preset, crf) = match quality {
                Fast => ("ultrafast", "25"),
                Balanced => ("superfast", "22"),
                High => ("veryfast", "20"),
            };
            args.push("libx264");
            args.extend([
                "-preset", preset, "-tune", "zerolatency", "-crf", crf, "-g", "50", "-bf", "0", "-pix_fmt",
                "yuv420p",
            ]);
        }
    }
    args
}

/// Ordine di prova degli encoder H.264: hardware, poi software.
pub const DETECT_ORDER: [&str; 5] = ["h264_nvenc", "h264_qsv", "h264_amf", "libx264", "h264_mf"];

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
    // libx264 manca nella build LGPL: lì resta h264_mf (Media Foundation)
    for enc in DETECT_ORDER {
        let mut args = vec![
            "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=black:s=640x360:r=25:d=0.4",
        ];
        // si prova con la qualità bilanciata, valida per tutte le schede supportate
        args.extend(encoder_args(enc, Quality::Balanced));
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
    // un film convertito in pausa tiene la connessione al provider
    crate::transcode::release_parked();
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
    Ok(parse_probe(&v))
}

/// Riepilogo dell'uscita JSON di ffprobe (`-show_format -show_streams`).
pub fn parse_probe(v: &Value) -> ProbeInfo {
    let mut info = ProbeInfo::default();
    if let Some(format) = v.get("format") {
        info.container = field(format, "format_name");
        info.duration = field(format, "duration").parse::<f64>().unwrap_or(0.0);
    }
    let tag = |s: &Value, name: &str| s.get("tags").map(|t| field(t, name)).unwrap_or_default();
    let flag = |s: &Value, name: &str| s.get("disposition").map(|d| field(d, name) == "1").unwrap_or(false);
    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let codec = field(s, "codec_name");
            match field(s, "codec_type").as_str() {
                // le copertine allegate sono "video" ma non vanno riprodotte
                "video" if !flag(s, "attached_pic") => {
                    info.video_tracks += 1;
                    if info.video_tracks == 1 {
                        info.video_codec = codec;
                        info.video_profile = field(s, "profile");
                        info.pix_fmt = field(s, "pix_fmt");
                        info.field_order = field(s, "field_order");
                        info.width = field(s, "width").parse().unwrap_or(0);
                        info.height = field(s, "height").parse().unwrap_or(0);
                    }
                }
                kind @ ("audio" | "subtitle") => {
                    let channels = field(s, "channels").parse().unwrap_or(0);
                    let list = if kind == "audio" { &mut info.audio } else { &mut info.subtitles };
                    list.push(ProbeTrack {
                        index: list.len(),
                        text: kind == "subtitle" && is_text_subtitle(&codec),
                        codec,
                        lang: tag(s, "language").to_ascii_lowercase(),
                        title: tag(s, "title"),
                        channels,
                        default: flag(s, "default"),
                        // "forzati" ha senso solo per i sottotitoli (alcuni file lo mettono anche sull'audio)
                        forced: kind == "subtitle" && flag(s, "forced"),
                    });
                }
                _ => {}
            }
        }
    }
    info.audio_tracks = info.audio.len();
    if let Some(first) = info.audio.first() {
        info.audio_codec = first.codec.clone();
        info.audio_channels = first.channels;
    }
    info
}

pub fn push_args(args: &mut Vec<String>, items: &[&str]) {
    args.extend(items.iter().map(|s| s.to_string()));
}

/// Cosa deve fare ffmpeg in una sessione del percorso `/t/`.
#[derive(Debug, Clone)]
pub struct FfmpegJob<'a> {
    pub input: &'a str,
    /// "copy" | "h264"
    pub v: &'a str,
    /// "copy" | "aac"
    pub a: &'a str,
    pub live: bool,
    /// punto di partenza dei film convertiti, in secondi
    pub ss: f64,
    pub encoder: &'a str,
    /// l'ingresso arriva su stdin dal proxy (che ha già scartato la raffica iniziale),
    /// quindi niente opzioni HTTP
    pub from_pipe: bool,
    /// traccia audio scelta (`-map 0:a:N`)
    pub audio_index: usize,
    /// "Originale": l'audio multicanale resta 5.1 invece del downmix stereo
    pub surround: bool,
    /// canali della traccia sorgente, 0 se non noti (live)
    pub source_channels: i64,
    pub quality: Quality,
    /// sottotitoli testuali estratti in WebVTT dallo stesso processo: (indice `0:s:N`,
    /// URL di uscita, di solito `tcp://127.0.0.1:<porta>` aperto dal proxy)
    pub subtitle_outputs: Vec<(usize, String)>,
}

impl<'a> FfmpegJob<'a> {
    pub fn new(input: &'a str, v: &'a str, a: &'a str, live: bool, encoder: &'a str) -> Self {
        FfmpegJob {
            input,
            v,
            a,
            live,
            ss: 0.0,
            encoder,
            from_pipe: false,
            audio_index: 0,
            surround: false,
            source_channels: 0,
            quality: Quality::Balanced,
            subtitle_outputs: Vec::new(),
        }
    }
}

/// Argomenti della traccia audio in uscita.
pub fn audio_args(a: &str, surround: bool, source_channels: i64) -> Vec<String> {
    let mut args = Vec::new();
    if a == "copy" {
        push_args(&mut args, &["-c:a", "copy"]);
    } else if surround && source_channels >= 6 {
        push_args(&mut args, &["-c:a", "aac", "-b:a", "384k", "-ac", "6", "-ar", "48000"]);
    } else if surround && source_channels <= 0 {
        // canali non noti (live): 5.1 resta 5.1, stereo e mono escono in stereo, 7.1 diventa 5.1
        push_args(
            &mut args,
            &["-c:a", "aac", "-b:a", "384k", "-af", "aformat=channel_layouts=5.1|stereo", "-ar", "48000"],
        );
    } else {
        push_args(&mut args, &["-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000"]);
    }
    args
}

pub fn build_ffmpeg_args(job: &FfmpegJob) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    push_args(&mut args, &["-hide_banner", "-loglevel", "error", "-nostdin"]);
    if !job.from_pipe {
        push_args(
            &mut args,
            &[
                "-user_agent", USER_AGENT, "-reconnect", "1", "-reconnect_on_network_error", "1",
                "-reconnect_delay_max", "3",
            ],
        );
    }
    if job.live {
        if !job.from_pipe {
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
        if job.ss > 0.5 {
            args.push("-ss".to_string());
            args.push(format!("{:.3}", job.ss));
        }
    }
    if job.from_pipe {
        push_args(&mut args, &["-f", "mpegts"]);
    }
    let audio_map = format!("0:a:{}?", job.audio_index);
    push_args(&mut args, &["-i", job.input, "-map", "0:v:0?", "-map", &audio_map, "-sn", "-dn"]);
    if job.v == "h264" {
        // i canali DVB sono spesso interlacciati (1080i/576i), che WebView2 non decodifica:
        // si deinterlaccia a doppio frame rate (50p) solo i fotogrammi marcati come interlacciati
        push_args(&mut args, &["-vf", "bwdif=mode=send_field:deint=interlaced"]);
        push_args(&mut args, &encoder_args(job.encoder, job.quality));
    } else {
        push_args(&mut args, &["-c:v", "copy"]);
    }
    args.extend(audio_args(job.a, job.surround, job.source_channels));
    push_args(
        &mut args,
        &["-f", "mpegts", "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "pipe:1"],
    );
    // uscite aggiuntive: una per ogni traccia di sottotitoli, con la stessa linea temporale
    // del video (anche dopo un seek con -ss) e senza una seconda connessione al provider
    for (index, url) in &job.subtitle_outputs {
        let map = format!("0:s:{}", index);
        push_args(&mut args, &["-map", &map, "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", url]);
    }
    args
}

/// Estrazione di una traccia di sottotitoli testuali in WebVTT (percorso `/s/`). Con `ss` i
/// tempi partono da zero nel punto scelto, come il video del percorso `/t/` con lo stesso `ss`.
pub fn build_subtitle_args(url: &str, index: usize, ss: f64) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    push_args(
        &mut args,
        &[
            "-hide_banner", "-loglevel", "error", "-nostdin", "-user_agent", USER_AGENT, "-reconnect", "1",
            "-reconnect_on_network_error", "1", "-reconnect_delay_max", "3",
        ],
    );
    if ss > 0.5 {
        args.push("-ss".to_string());
        args.push(format!("{:.3}", ss));
    }
    let map = format!("0:s:{}", index);
    push_args(
        &mut args,
        &["-i", url, "-map", &map, "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", "pipe:1"],
    );
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(args: &[String], item: &str) -> Option<usize> {
        args.iter().position(|a| a == item)
    }

    fn job<'a>(input: &'a str, v: &'a str, a: &'a str, live: bool, encoder: &'a str, from_pipe: bool) -> FfmpegJob<'a> {
        let mut j = FfmpegJob::new(input, v, a, live, encoder);
        j.from_pipe = from_pipe;
        j
    }

    #[test]
    fn live_video_conversion_from_pipe() {
        let a = build_ffmpeg_args(&job("pipe:0", "h264", "aac", true, "h264_nvenc", true));
        let i = pos(&a, "-i").unwrap();
        assert_eq!(a[i + 1], "pipe:0");
        assert_eq!(a[i - 2..i], ["-f".to_string(), "mpegts".to_string()]);
        assert!(pos(&a, "-user_agent").is_none(), "niente opzioni HTTP su stdin");
        assert!(pos(&a, "-reconnect").is_none());
        assert!(a.iter().any(|x| x.starts_with("bwdif=")), "deinterlacciamento atteso");
        assert!(pos(&a, "h264_nvenc").unwrap() > i);
        assert_eq!(a[pos(&a, "-c:a").unwrap() + 1], "aac");
        assert_eq!(a[pos(&a, "-ac").unwrap() + 1], "2", "stereo per impostazione predefinita");
        assert_eq!(a.last().unwrap(), "pipe:1");
    }

    #[test]
    fn live_audio_only_from_pipe_copies_video() {
        let a = build_ffmpeg_args(&job("pipe:0", "copy", "aac", true, "h264_nvenc", true));
        assert_eq!(a[pos(&a, "-c:v").unwrap() + 1], "copy");
        assert!(!a.iter().any(|x| x.starts_with("bwdif=")), "niente filtri con il video copiato");
        assert!(pos(&a, "h264_nvenc").is_none());
        assert!(pos(&a, "-user_agent").is_none());
    }

    #[test]
    fn live_audio_only_from_url() {
        let a = build_ffmpeg_args(&job("http://h/live/1.ts", "copy", "aac", true, "libx264", false));
        assert!(pos(&a, "-user_agent").unwrap() < pos(&a, "-i").unwrap());
        assert!(pos(&a, "-reconnect_streamed").is_some());
        assert_eq!(a[pos(&a, "-c:v").unwrap() + 1], "copy");
        assert!(!a.iter().any(|x| x.starts_with("bwdif=")));
    }

    #[test]
    fn vod_seek_goes_before_input() {
        let mut j = job("http://h/movie/1.mkv", "copy", "copy", false, "libx264", false);
        j.ss = 120.5;
        let a = build_ffmpeg_args(&j);
        let ss = pos(&a, "-ss").expect("-ss atteso");
        assert_eq!(a[ss + 1], "120.500");
        assert!(ss < pos(&a, "-i").unwrap());
        assert!(pos(&a, "-reconnect_streamed").is_none());
        assert_eq!(a[pos(&a, "-c:a").unwrap() + 1], "copy");
        j.ss = 0.2;
        assert!(pos(&build_ffmpeg_args(&j), "-ss").is_none(), "seek trascurabile ignorato");
    }

    #[test]
    fn chosen_audio_track_is_mapped() {
        let a = build_ffmpeg_args(&job("pipe:0", "copy", "aac", true, "libx264", true));
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:0?"), "prima traccia predefinita");
        let mut j = job("pipe:0", "copy", "copy", true, "libx264", true);
        j.audio_index = 2;
        let a = build_ffmpeg_args(&j);
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:2?"));
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "0:v:0?"));
        assert_eq!(a.iter().filter(|x| *x == "-map").count(), 2, "una sola traccia audio");
        assert_eq!(a[pos(&a, "-c:a").unwrap() + 1], "copy");
    }

    #[test]
    fn surround_keeps_six_channels() {
        let after = |a: &[String], k: &str| a[a.iter().position(|x| x == k).unwrap() + 1].clone();
        // "Originale" con sorgente 5.1 nota (film)
        let a = audio_args("aac", true, 6);
        assert_eq!((after(&a, "-ac"), after(&a, "-b:a")), ("6".to_string(), "384k".to_string()));
        // 7.1 → 5.1
        assert_eq!(after(&audio_args("aac", true, 8), "-ac"), "6");
        // "Originale" con sorgente stereo: resta stereo
        let a = audio_args("aac", true, 2);
        assert_eq!((after(&a, "-ac"), after(&a, "-b:a")), ("2".to_string(), "192k".to_string()));
        // "Originale" senza canali noti (live): 5.1 o stereo secondo la sorgente
        let a = audio_args("aac", true, 0);
        assert!(!a.contains(&"-ac".to_string()));
        assert_eq!(after(&a, "-af"), "aformat=channel_layouts=5.1|stereo");
        assert_eq!(after(&a, "-b:a"), "384k");
        // "Stereo": sempre downmix
        assert_eq!(after(&audio_args("aac", false, 6), "-ac"), "2");
        // la copia non tocca i canali
        assert_eq!(audio_args("copy", true, 6), vec!["-c:a".to_string(), "copy".to_string()]);
        // nel comando completo, dopo l'ingresso
        let mut j = job("http://h/movie/1.mkv", "copy", "aac", false, "libx264", false);
        j.surround = true;
        j.source_channels = 6;
        let full = build_ffmpeg_args(&j);
        assert_eq!(after(&full, "-ac"), "6");
        assert!(pos(&full, "-ac").unwrap() > pos(&full, "-i").unwrap());
    }

    #[test]
    fn quality_presets() {
        let after = |args: &[&str], k: &str| args[args.iter().position(|x| *x == k).unwrap() + 1].to_string();
        let nv = |q| {
            let a = encoder_args("h264_nvenc", q);
            (after(&a, "-preset"), after(&a, "-tune"), after(&a, "-cq"))
        };
        let t = |a: &str, b: &str, c: &str| (a.to_string(), b.to_string(), c.to_string());
        assert_eq!(nv(Quality::Fast), t("p1", "ull", "25"));
        assert_eq!(nv(Quality::Balanced), t("p3", "ll", "22"));
        assert_eq!(nv(Quality::High), t("p5", "ll", "20"));
        assert_eq!(after(&encoder_args("h264_qsv", Quality::Fast), "-global_quality"), "25");
        assert_eq!(after(&encoder_args("h264_qsv", Quality::High), "-global_quality"), "20");
        assert_eq!(after(&encoder_args("h264_amf", Quality::Fast), "-quality"), "speed");
        assert_eq!(after(&encoder_args("h264_amf", Quality::High), "-quality"), "quality");
        assert_eq!(after(&encoder_args("libx264", Quality::Fast), "-crf"), "25");
        assert_eq!(after(&encoder_args("libx264", Quality::Balanced), "-crf"), "22");
        assert_eq!(after(&encoder_args("libx264", Quality::High), "-crf"), "20");
        assert_eq!(after(&encoder_args("h264_mf", Quality::Fast), "-quality"), "50");
        assert_eq!(after(&encoder_args("h264_mf", Quality::Balanced), "-quality"), "60");
        assert_eq!(after(&encoder_args("h264_mf", Quality::High), "-quality"), "70");
        assert_eq!(after(&encoder_args("h264_mf", Quality::High), "-rate_control"), "quality");
        assert_eq!(Quality::parse("fast"), Quality::Fast);
        assert_eq!(Quality::parse("high"), Quality::High);
        assert_eq!(Quality::parse(""), Quality::Balanced);
        assert_eq!(Quality::parse("boh"), Quality::Balanced);
        // la qualità arriva al comando completo
        let mut j = job("pipe:0", "h264", "aac", true, "h264_nvenc", true);
        j.quality = Quality::High;
        let a = build_ffmpeg_args(&j);
        assert_eq!(a[pos(&a, "-preset").unwrap() + 1], "p5");
    }

    #[test]
    fn every_encoder_has_args() {
        for enc in ["h264_nvenc", "h264_qsv", "h264_amf", "libx264", "h264_mf", "sconosciuto"] {
            for q in [Quality::Fast, Quality::Balanced, Quality::High] {
                let args = encoder_args(enc, q);
                assert_eq!(args[0], "-c:v");
                assert!(args[1] == enc || (enc == "sconosciuto" && args[1] == "libx264"), "{} -> {}", enc, args[1]);
                assert!(args.contains(&"-pix_fmt"));
                assert!(args.contains(&"-g") && args.contains(&"-bf"), "GOP corto e niente B-frame");
            }
        }
    }

    #[test]
    fn media_foundation_is_the_last_fallback() {
        // hardware prima, poi libx264 (build GPL) e infine h264_mf (build LGPL dell'installer)
        assert_eq!(DETECT_ORDER.last(), Some(&"h264_mf"));
        let pos = |e: &str| DETECT_ORDER.iter().position(|x| *x == e).unwrap();
        assert!(pos("h264_nvenc") < pos("libx264") && pos("libx264") < pos("h264_mf"));
    }

    #[test]
    fn subtitles_from_the_same_ffmpeg_process() {
        let mut j = job("http://h/movie/1.mkv", "copy", "copy", false, "libx264", false);
        j.ss = 600.0;
        j.subtitle_outputs = vec![(0, "tcp://127.0.0.1:5001".into()), (2, "tcp://127.0.0.1:5002".into())];
        let a = build_ffmpeg_args(&j);
        let ts_out = pos(&a, "pipe:1").expect("uscita video");
        // il video resta la prima uscita, senza sottotitoli
        assert!(pos(&a, "-sn").unwrap() < ts_out);
        let tail = &a[ts_out + 1..];
        assert_eq!(
            tail,
            [
                "-map", "0:s:0", "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", "tcp://127.0.0.1:5001", "-map",
                "0:s:2", "-c:s", "webvtt", "-flush_packets", "1", "-f", "webvtt", "tcp://127.0.0.1:5002",
            ]
            .map(String::from)
        );
        // un solo -ss, sull'ingresso: video e sottotitoli partono dallo stesso punto
        assert_eq!(a.iter().filter(|x| *x == "-ss").count(), 1);
        assert!(pos(&a, "-ss").unwrap() < pos(&a, "-i").unwrap());
        // senza sottotitoli l'ultima uscita è il video
        assert_eq!(build_ffmpeg_args(&job("pipe:0", "copy", "aac", true, "libx264", true)).last().unwrap(), "pipe:1");
    }

    #[test]
    fn subtitle_extraction_to_webvtt() {
        let a = build_subtitle_args("http://h/movie/1.mkv", 1, 0.0);
        assert!(pos(&a, "-ss").is_none());
        let i = pos(&a, "-i").unwrap();
        assert_eq!(a[i + 1], "http://h/movie/1.mkv");
        assert!(pos(&a, "-user_agent").unwrap() < i);
        assert_eq!(a[pos(&a, "-map").unwrap() + 1], "0:s:1");
        assert_eq!(a[pos(&a, "-c:s").unwrap() + 1], "webvtt");
        assert_eq!(a[pos(&a, "-f").unwrap() + 1], "webvtt");
        assert_eq!(a.last().unwrap(), "pipe:1");
        // con il seek dei film convertiti i tempi partono dallo stesso punto del video
        let a = build_subtitle_args("http://h/movie/1.mkv", 0, 754.25);
        let ss = pos(&a, "-ss").unwrap();
        assert_eq!(a[ss + 1], "754.250");
        assert!(ss < pos(&a, "-i").unwrap());
    }

    #[test]
    fn probe_lists_all_tracks() {
        let v: Value = serde_json::from_str(
            r#"{"format":{"format_name":"matroska,webm","duration":"5400.5"},
               "streams":[
                 {"codec_type":"video","codec_name":"hevc","pix_fmt":"yuv420p10le","width":3840,"height":2160,"field_order":"progressive","disposition":{"attached_pic":0}},
                 {"codec_type":"audio","codec_name":"eac3","channels":6,"tags":{"language":"ITA","title":"Italiano 5.1"},"disposition":{"default":1,"forced":1}},
                 {"codec_type":"audio","codec_name":"aac","channels":"2","tags":{"language":"eng"}},
                 {"codec_type":"subtitle","codec_name":"subrip","tags":{"language":"ita"},"disposition":{"forced":1}},
                 {"codec_type":"subtitle","codec_name":"hdmv_pgs_subtitle","tags":{"language":"eng","title":"SDH"}},
                 {"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}},
                 {"codec_type":"attachment","codec_name":"ttf"}
               ]}"#,
        )
        .unwrap();
        let p = parse_probe(&v);
        assert_eq!(p.container, "matroska,webm");
        assert!((p.duration - 5400.5).abs() < 1e-9);
        assert_eq!((p.video_codec.as_str(), p.width, p.video_tracks), ("hevc", 3840, 1), "copertina esclusa");
        assert_eq!(p.audio_tracks, 2);
        assert_eq!((p.audio_codec.as_str(), p.audio_channels), ("eac3", 6), "riepilogo della prima traccia");
        assert_eq!(
            p.audio[0],
            ProbeTrack {
                index: 0,
                codec: "eac3".into(),
                lang: "ita".into(),
                title: "Italiano 5.1".into(),
                channels: 6,
                default: true,
                forced: false,
                text: false,
            }
        );
        assert_eq!((p.audio[1].index, p.audio[1].lang.as_str(), p.audio[1].channels), (1, "eng", 2));
        assert_eq!(p.subtitles.len(), 2);
        assert!(p.subtitles[0].text && p.subtitles[0].forced);
        assert_eq!((p.subtitles[1].index, p.subtitles[1].text, p.subtitles[1].title.as_str()), (1, false, "SDH"), "PGS è un'immagine");
        assert!(is_text_subtitle("ass") && is_text_subtitle("mov_text") && is_text_subtitle("webvtt"));
        assert!(!is_text_subtitle("dvb_subtitle") && !is_text_subtitle("dvd_subtitle"));
    }
}
