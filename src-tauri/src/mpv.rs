//! Motore di riproduzione integrato: libmpv (`libmpv-2.dll`, caricata a runtime) disegna il video
//! in una finestra nativa figlia della finestra principale, sotto WebView2. La pagina è trasparente
//! sopra il rettangolo del player, quindi i controlli HTML restano sopra il video.
//!
//! I comandi sono sincroni: Tauri li esegue sul thread principale, lo stesso che possiede le
//! finestre, quindi creare e spostare la finestra video non richiede altri passaggi. Gli eventi di
//! mpv arrivano alla pagina con l'evento Tauri `mpv` da un thread dedicato.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::util::USER_AGENT;

const DLL: &str = "libmpv-2.dll";

// ---------------------------------------------------------------------------
// C API di libmpv (client.h, versione 2.x)
// ---------------------------------------------------------------------------

type Handle = *mut c_void;

const FORMAT_STRING: c_int = 1;
const EVENT_SHUTDOWN: c_int = 1;
const EVENT_END_FILE: c_int = 7;
const EVENT_FILE_LOADED: c_int = 8;
const EVENT_PLAYBACK_RESTART: c_int = 21;
const EVENT_PROPERTY_CHANGE: c_int = 22;

#[repr(C)]
struct Event {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct EventProperty {
    name: *const c_char,
    format: c_int,
    data: *mut c_void,
}

#[repr(C)]
struct EventEndFile {
    reason: c_int,
    error: c_int,
}

struct Api {
    _lib: libloading::Library,
    create: unsafe extern "C" fn() -> Handle,
    initialize: unsafe extern "C" fn(Handle) -> c_int,
    set_option_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    set_property_string: unsafe extern "C" fn(Handle, *const c_char, *const c_char) -> c_int,
    command: unsafe extern "C" fn(Handle, *mut *const c_char) -> c_int,
    observe_property: unsafe extern "C" fn(Handle, u64, *const c_char, c_int) -> c_int,
    wait_event: unsafe extern "C" fn(Handle, f64) -> *mut Event,
    error_string: unsafe extern "C" fn(c_int) -> *const c_char,
}

impl Api {
    fn load(path: &PathBuf) -> Result<Api, String> {
        // SAFETY: si carica la DLL di libmpv distribuita con l'app; i simboli hanno le firme di
        // client.h (API 2.x, stabile tra le versioni)
        unsafe {
            let lib = libloading::Library::new(path).map_err(|e| e.to_string())?;
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes())
                        .map_err(|e| format!("{}: {}", $name, e))?
                };
            }
            Ok(Api {
                create: sym!("mpv_create"),
                initialize: sym!("mpv_initialize"),
                set_option_string: sym!("mpv_set_option_string"),
                set_property_string: sym!("mpv_set_property_string"),
                command: sym!("mpv_command"),
                observe_property: sym!("mpv_observe_property"),
                wait_event: sym!("mpv_wait_event"),
                error_string: sym!("mpv_error_string"),
                _lib: lib,
            })
        }
    }

    fn error(&self, code: c_int) -> String {
        // SAFETY: mpv_error_string restituisce sempre una stringa statica
        unsafe { CStr::from_ptr((self.error_string)(code)) }
            .to_string_lossy()
            .into_owned()
    }
}

/// Puntatore all'istanza di mpv: il client API è thread-safe.
#[derive(Clone, Copy)]
struct Mpv(Handle);
// SAFETY: libmpv documenta che tutte le funzioni del client API si possono chiamare da qualsiasi thread
unsafe impl Send for Mpv {}
unsafe impl Sync for Mpv {}

fn cstr(s: &str) -> Result<CString, String> {
    CString::new(s).map_err(|_| "testo con carattere nullo".to_string())
}

impl Mpv {
    fn option(&self, api: &Api, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        // SAFETY: handle valido, stringhe terminate da zero che vivono per tutta la chiamata
        let r = unsafe { (api.set_option_string)(self.0, n.as_ptr(), v.as_ptr()) };
        if r < 0 {
            return Err(format!("opzione {}={}: {}", name, value, api.error(r)));
        }
        Ok(())
    }

    fn set(&self, api: &Api, name: &str, value: &str) -> Result<(), String> {
        let (n, v) = (cstr(name)?, cstr(value)?);
        // SAFETY: come sopra
        let r = unsafe { (api.set_property_string)(self.0, n.as_ptr(), v.as_ptr()) };
        if r < 0 {
            return Err(format!("{}={}: {}", name, value, api.error(r)));
        }
        Ok(())
    }

    fn command(&self, api: &Api, args: &[&str]) -> Result<(), String> {
        let owned = args
            .iter()
            .map(|a| cstr(a))
            .collect::<Result<Vec<_>, _>>()?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        // SAFETY: array di stringhe terminato da NULL, valido per tutta la chiamata
        let r = unsafe { (api.command)(self.0, ptrs.as_mut_ptr()) };
        if r < 0 {
            return Err(format!("{}: {}", args.first().unwrap_or(&""), api.error(r)));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Libreria e istanza
// ---------------------------------------------------------------------------

static API: OnceLock<Result<Api, String>> = OnceLock::new();

struct Player {
    mpv: Mpv,
    hwnd: isize,
}

static PLAYER: Mutex<Option<Player>> = Mutex::new(None);

/// Cartelle dove cercare la DLL: risorse dell'app (installata e in sviluppo), poi quella dell'exe.
fn dll_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        out.push(dir.join(DLL));
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        out.push(dir.join(DLL));
    }
    out
}

fn api(app: &AppHandle) -> Result<&'static Api, String> {
    API.get_or_init(|| {
        let candidates = dll_candidates(app);
        let path = candidates
            .iter()
            .find(|p| p.is_file())
            .ok_or_else(|| format!("{} non trovata", DLL))?;
        Api::load(path).map_err(|e| format!("{} non caricabile: {}", DLL, e))
    })
    .as_ref()
    .map_err(|e| e.clone())
}

/// Proprietà osservate: arrivano alla pagina come stringhe (i nodi, come `track-list`, in JSON).
const OBSERVED: &[&str] = &[
    "pause",
    "paused-for-cache",
    "core-idle",
    "time-pos",
    "duration",
    "demuxer-cache-duration",
    "track-list",
    "aid",
    "sid",
    "volume",
    "mute",
    "video-format",
    "audio-codec-name",
    "width",
    "height",
    "audio-params/channel-count",
    "hwdec-current",
];

/// Opzioni fisse dell'istanza (prima di `mpv_initialize`).
fn init_options(wid: isize) -> Vec<(&'static str, String)> {
    vec![
        ("wid", wid.to_string()),
        ("user-agent", USER_AGENT.to_string()),
        ("hwdec", "auto-safe".into()),
        ("idle", "yes".into()),
        ("keep-open", "no".into()),
        ("osc", "no".into()),
        ("osd-level", "0".into()),
        ("input-default-bindings", "no".into()),
        ("input-vo-keyboard", "no".into()),
        ("input-cursor", "no".into()),
        ("cursor-autohide", "no".into()),
        ("cache", "yes".into()),
        // sottotitoli sopra la barra dei controlli HTML (il valore predefinito di mpv è 22)
        ("sub-margin-y", "44".into()),
        // un provider che chiude la connessione non ferma il live: ffmpeg si ricollega
        (
            "stream-lavf-o",
            "reconnect=1,reconnect_streamed=1,reconnect_delay_max=5".into(),
        ),
        ("audio-client-name", "Xtream Player".into()),
    ]
}

fn create_video_window(parent: isize) -> Result<isize, String> {
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, RegisterClassW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_DISABLED,
    };
    let class: Vec<u16> = "XtreamPlayerVideo\0".encode_utf16().collect();
    // SAFETY: chiamate Win32 sul thread che possiede la finestra principale; la classe usa
    // DefWindowProcW e il pennello nero di sistema (nessuna risorsa da liberare)
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(DefWindowProcW),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: GetStockObject(BLACK_BRUSH) as _,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        // una seconda registrazione fallisce perché la classe esiste già: va bene
        RegisterClassW(&wc);
        // disabilitata: mouse e tastiera vanno sempre alla pagina, anche se la finestra fosse sopra.
        // Niente WS_CLIPSIBLINGS: la WebView sopra copre tutta l'area client e la escluderebbe del tutto.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_CLIPCHILDREN | WS_DISABLED,
            0,
            0,
            16,
            16,
            parent as _,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return Err("impossibile creare la finestra del video".into());
        }
        // sotto WebView2: la pagina trasparente lascia vedere il video
        SetWindowPos(
            hwnd,
            HWND_BOTTOM,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        Ok(hwnd as isize)
    }
}

/// Istanza unica, creata al primo uso insieme alla finestra del video.
fn player(app: &AppHandle) -> Result<(Mpv, isize), String> {
    let mut slot = PLAYER.lock().map_err(|_| "stato di mpv non disponibile")?;
    if let Some(p) = slot.as_ref() {
        return Ok((p.mpv, p.hwnd));
    }
    let api = api(app)?;
    let window = app
        .get_webview_window("main")
        .ok_or("finestra principale non trovata")?;
    let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let hwnd = create_video_window(parent)?;
    // SAFETY: mpv_create non ha precondizioni; NULL indica memoria esaurita
    let handle = unsafe { (api.create)() };
    if handle.is_null() {
        return Err("mpv_create non riuscito".into());
    }
    let mpv = Mpv(handle);
    for (name, value) in init_options(hwnd) {
        mpv.option(api, name, &value)?;
    }
    // SAFETY: handle appena creato, opzioni già impostate
    let r = unsafe { (api.initialize)(mpv.0) };
    if r < 0 {
        return Err(format!("mpv_initialize: {}", api.error(r)));
    }
    for (i, name) in OBSERVED.iter().enumerate() {
        let n = cstr(name)?;
        // SAFETY: handle inizializzato, nome terminato da zero
        unsafe { (api.observe_property)(mpv.0, i as u64, n.as_ptr(), FORMAT_STRING) };
    }
    spawn_events(app.clone(), api, mpv);
    *slot = Some(Player { mpv, hwnd });
    Ok((mpv, hwnd))
}

// ---------------------------------------------------------------------------
// Eventi verso la pagina
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
struct MpvEvent {
    name: String,
    value: Value,
}

/// Motivo di fine file per la pagina (`end-file`).
pub fn end_reason(reason: c_int) -> &'static str {
    match reason {
        0 => "eof",
        2 => "stop",
        3 => "quit",
        4 => "error",
        5 => "redirect",
        _ => "unknown",
    }
}

/// `time-pos` e la cache cambiano decine di volte al secondo: alla pagina ne bastano 4.
pub fn throttled(name: &str) -> bool {
    matches!(name, "time-pos" | "demuxer-cache-duration")
}

fn spawn_events(app: AppHandle, api: &'static Api, mpv: Mpv) {
    std::thread::Builder::new()
        .name("mpv-events".into())
        .spawn(move || {
            // cattura tutto `Mpv` (Send), non solo il puntatore che contiene
            let mpv = mpv;
            let mut last: Vec<(String, Instant)> = Vec::new();
            loop {
                // SAFETY: handle valido per tutta la vita dell'app (l'istanza non si distrugge)
                let ev = unsafe { &*(api.wait_event)(mpv.0, -1.0) };
                let out = match ev.event_id {
                    EVENT_SHUTDOWN => break,
                    EVENT_PROPERTY_CHANGE if !ev.data.is_null() => {
                        // SAFETY: per PROPERTY_CHANGE data punta a mpv_event_property
                        let p = unsafe { &*(ev.data as *const EventProperty) };
                        let name = unsafe { CStr::from_ptr(p.name) }
                            .to_string_lossy()
                            .into_owned();
                        if throttled(&name) {
                            let now = Instant::now();
                            match last.iter_mut().find(|(n, _)| *n == name) {
                                Some((_, t))
                                    if now.duration_since(*t) < Duration::from_millis(250) =>
                                {
                                    continue
                                }
                                Some((_, t)) => *t = now,
                                None => last.push((name.clone(), now)),
                            }
                        }
                        let value = if p.format == FORMAT_STRING && !p.data.is_null() {
                            // SAFETY: con MPV_FORMAT_STRING data punta a un char*
                            let s = unsafe { *(p.data as *const *const c_char) };
                            if s.is_null() {
                                Value::Null
                            } else {
                                Value::String(
                                    unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned(),
                                )
                            }
                        } else {
                            Value::Null
                        };
                        MpvEvent { name, value }
                    }
                    EVENT_END_FILE if !ev.data.is_null() => {
                        // SAFETY: per END_FILE data punta a mpv_event_end_file
                        let e = unsafe { &*(ev.data as *const EventEndFile) };
                        let error = if e.error < 0 {
                            api.error(e.error)
                        } else {
                            String::new()
                        };
                        MpvEvent {
                            name: "end-file".into(),
                            value: json!({ "reason": end_reason(e.reason), "error": error }),
                        }
                    }
                    EVENT_FILE_LOADED => MpvEvent {
                        name: "file-loaded".into(),
                        value: Value::Null,
                    },
                    EVENT_PLAYBACK_RESTART => MpvEvent {
                        name: "playback-restart".into(),
                        value: Value::Null,
                    },
                    _ => continue,
                };
                let _ = app.emit("mpv", out);
            }
        })
        .ok();
}

// ---------------------------------------------------------------------------
// Comandi
// ---------------------------------------------------------------------------

/// Proprietà che la pagina può cambiare direttamente.
pub fn settable(name: &str) -> bool {
    matches!(name, "pause" | "volume" | "mute" | "aid" | "sid")
}

/// Proprietà da impostare prima di `loadfile`.
#[allow(clippy::too_many_arguments)]
pub fn load_properties(
    live: bool,
    start: Option<f64>,
    cache_secs: Option<f64>,
    alang: &str,
    slang: &str,
    audio: &str,
    volume: Option<f64>,
    mute: Option<bool>,
    title: &str,
) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    // live: buffer corto (come il player esterno), avvio rapido; film: lettura più ampia
    let secs = cache_secs
        .filter(|s| s.is_finite() && *s > 0.0)
        .unwrap_or(if live { 2.0 } else { 30.0 });
    out.push(("cache-secs", format!("{}", secs)));
    out.push(("demuxer-readahead-secs", format!("{}", secs)));
    out.push((
        "start",
        match start {
            Some(s) if !live && s.is_finite() && s > 0.0 => format!("{}", s.floor()),
            _ => "none".into(),
        },
    ));
    out.push(("alang", alang.to_string()));
    // sottotitoli: lingua preferita, altrimenti nessuno
    out.push(("slang", slang.to_string()));
    out.push((
        "sid",
        if slang.is_empty() {
            "no".into()
        } else {
            "auto".into()
        },
    ));
    out.push((
        "audio-channels",
        if audio == "orig" {
            "auto-safe"
        } else {
            "stereo"
        }
        .into(),
    ));
    if let Some(v) = volume.filter(|v| v.is_finite()) {
        out.push(("volume", format!("{}", v.clamp(0.0, 100.0).round())));
    }
    if let Some(m) = mute {
        out.push(("mute", if m { "yes" } else { "no" }.into()));
    }
    out.push(("force-media-title", title.replace(['\r', '\n'], " ")));
    out.push(("pause", "no".into()));
    out
}

#[tauri::command]
pub fn mpv_available(app: AppHandle) -> Result<bool, String> {
    Ok(api(&app).is_ok())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn mpv_load(
    app: AppHandle,
    url: String,
    live: bool,
    start: Option<f64>,
    cache_secs: Option<f64>,
    alang: Option<String>,
    slang: Option<String>,
    audio: Option<String>,
    volume: Option<f64>,
    mute: Option<bool>,
    title: Option<String>,
) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "URL dello stream non valido")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Sono supportati solo URL http:// e https://".into());
    }
    let (mpv, _) = player(&app)?;
    let api = api(&app)?;
    // un film convertito sospeso tiene la connessione al provider
    crate::transcode::release_parked();
    for (name, value) in load_properties(
        live,
        start,
        cache_secs,
        alang.as_deref().unwrap_or(""),
        slang.as_deref().unwrap_or(""),
        audio.as_deref().unwrap_or("stereo"),
        volume,
        mute,
        title.as_deref().unwrap_or(""),
    ) {
        mpv.set(api, name, &value)?;
    }
    mpv.command(api, &["loadfile", url.trim(), "replace"])
}

#[tauri::command]
pub fn mpv_stop(app: AppHandle) -> Result<(), String> {
    let slot = PLAYER.lock().map_err(|_| "stato di mpv non disponibile")?;
    let Some(p) = slot.as_ref() else {
        return Ok(());
    };
    let api = api(&app)?;
    show_window(p.hwnd, None);
    p.mpv.command(api, &["stop"])
}

#[tauri::command]
pub fn mpv_set(app: AppHandle, name: String, value: String) -> Result<(), String> {
    if !settable(&name) {
        return Err(format!("proprietà non modificabile: {}", name));
    }
    let (mpv, _) = player(&app)?;
    mpv.set(api(&app)?, &name, &value)
}

#[tauri::command]
pub fn mpv_seek(app: AppHandle, secs: f64) -> Result<(), String> {
    if !secs.is_finite() {
        return Err("posizione non valida".into());
    }
    let (mpv, _) = player(&app)?;
    mpv.command(
        api(&app)?,
        &["seek", &format!("{}", secs.max(0.0)), "absolute"],
    )
}

/// Rettangolo in pixel fisici, relativo all'area client della finestra; `None` nasconde.
fn show_window(hwnd: isize, rect: Option<(i32, i32, i32, i32)>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, SWP_SHOWWINDOW,
    };
    // SAFETY: hwnd è la finestra del video creata da questo modulo e mai distrutta
    unsafe {
        match rect {
            Some((x, y, w, h)) => SetWindowPos(
                hwnd as _,
                HWND_BOTTOM,
                x,
                y,
                w.max(1),
                h.max(1),
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            ),
            None => SetWindowPos(
                hwnd as _,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW,
            ),
        };
    }
}

#[tauri::command]
pub fn mpv_set_rect(
    app: AppHandle,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    visible: bool,
) -> Result<(), String> {
    let hwnd = if visible {
        player(&app)?.1
    } else {
        match PLAYER
            .lock()
            .map_err(|_| "stato di mpv non disponibile")?
            .as_ref()
        {
            Some(p) => p.hwnd,
            None => return Ok(()),
        }
    };
    let ok = [x, y, w, h].iter().all(|v| v.is_finite());
    let rect = (visible && ok && w >= 1.0 && h >= 1.0).then(|| {
        (
            x.round() as i32,
            y.round() as i32,
            w.round() as i32,
            h.round() as i32,
        )
    });
    show_window(hwnd, rect);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get<'a>(props: &'a [(&'static str, String)], name: &str) -> &'a str {
        props
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| v.as_str())
            .unwrap_or("<assente>")
    }

    #[test]
    fn live_and_vod_properties() {
        let live = load_properties(
            true,
            Some(120.0),
            None,
            "ita",
            "",
            "stereo",
            Some(55.4),
            Some(false),
            "Rai 1",
        );
        assert_eq!(get(&live, "cache-secs"), "2");
        assert_eq!(get(&live, "demuxer-readahead-secs"), "2");
        // il live non riprende da una posizione
        assert_eq!(get(&live, "start"), "none");
        assert_eq!(get(&live, "sid"), "no");
        assert_eq!(get(&live, "audio-channels"), "stereo");
        assert_eq!(get(&live, "volume"), "55");
        assert_eq!(get(&live, "mute"), "no");
        assert_eq!(get(&live, "pause"), "no");
        let vod = load_properties(
            false,
            Some(754.8),
            Some(4.0),
            "",
            "ita",
            "orig",
            None,
            None,
            "a\nb",
        );
        assert_eq!(get(&vod, "cache-secs"), "4");
        assert_eq!(get(&vod, "start"), "754");
        assert_eq!(get(&vod, "sid"), "auto");
        assert_eq!(get(&vod, "slang"), "ita");
        assert_eq!(get(&vod, "audio-channels"), "auto-safe");
        assert_eq!(get(&vod, "volume"), "<assente>");
        assert_eq!(get(&vod, "force-media-title"), "a b");
        let vod0 = load_properties(
            false,
            Some(f64::NAN),
            Some(-1.0),
            "",
            "",
            "",
            Some(250.0),
            None,
            "",
        );
        assert_eq!(get(&vod0, "start"), "none");
        assert_eq!(get(&vod0, "cache-secs"), "30");
        assert_eq!(get(&vod0, "volume"), "100");
    }

    #[test]
    fn only_safe_properties_are_settable() {
        for p in ["pause", "volume", "mute", "aid", "sid"] {
            assert!(settable(p), "{}", p);
        }
        for p in ["wid", "script", "input-commands", "stream-lavf-o", ""] {
            assert!(!settable(p), "{}", p);
        }
    }

    #[test]
    fn end_reasons_and_throttling() {
        assert_eq!(end_reason(0), "eof");
        assert_eq!(end_reason(4), "error");
        assert_eq!(end_reason(99), "unknown");
        assert!(throttled("time-pos"));
        assert!(!throttled("pause"));
    }

    #[test]
    fn init_options_embed_the_window() {
        let o = init_options(1234);
        assert_eq!(get(&o, "wid"), "1234");
        assert_eq!(get(&o, "user-agent"), USER_AGENT);
        assert_eq!(get(&o, "input-default-bindings"), "no");
    }
}
