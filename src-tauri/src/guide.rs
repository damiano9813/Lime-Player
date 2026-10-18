//! Guida TV completa da `xmltv.php`, per la griglia della sezione Live TV.
//!
//! Una sola richiesta al server (non uno stream: non occupa la connessione dell'account)
//! porta la guida di tutti i canali. Il file può superare le centinaia di MB: si scarica in
//! streaming su disco, si analizza in streaming con quick-xml e in memoria resta solo un
//! indice per `epg_channel_id` (minuscolo) con i programmi di una finestra di giorni e le
//! descrizioni accorciate. Una copia compatta in JSON sta nella cartella dell'account
//! accanto alle liste (`lists/<account>/xmltv.json`), così ai riavvii la guida è subito pronta.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesStart, Event};
use quick_xml::{Reader, XmlVersion};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::cache::{account_dir, account_hash, now_secs};
use crate::catalog::EpgEntry;
use crate::state::AppState;
use crate::util::describe_reqwest_error;
use crate::xtream::normalize_server;

/// Sotto questa età la guida salvata si usa senza riscaricarla.
const FRESH_SECS: u64 = 6 * 3600;
/// Programmi tenuti: fino a 8 giorni fa (archivio del catch-up) e 8 giorni avanti.
const PAST_SECS: i64 = 8 * 86400;
const FUTURE_SECS: i64 = 8 * 86400;
/// Le descrizioni servono solo al suggerimento sui blocchi della griglia.
const DESC_MAX_CHARS: usize = 280;
/// Oltre questa dimensione il download si interrompe (file anomalo o risposta infinita).
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_SECS: u64 = 15 * 60;
/// Canali chiesti al massimo in una volta (righe visibili della griglia).
const MAX_QUERY_IDS: usize = 400;
const FILE_NAME: &str = "xmltv.json";

/// Programma: inizio e fine (secondi Unix), inizio nell'ora locale del file
/// ("AAAA-MM-GG HH:MM:SS", per il catch-up), titolo, descrizione.
/// Una tupla si salva come array JSON: il file resta compatto.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prog(pub i64, pub i64, pub String, pub String, pub String);

pub type Channels = HashMap<String, Vec<Prog>>;

#[derive(Serialize, Deserialize)]
struct GuideFile {
    fetched_at: u64,
    channels: Channels,
}

struct Loaded {
    account: String,
    fetched_at: u64,
    channels: Arc<Channels>,
}

/// Risposta di `load_guide` ed evento `guide-updated`.
#[derive(Debug, Clone, Serialize)]
pub struct GuideStatus {
    pub channels: usize,
    pub programmes: usize,
    pub fetched_at: u64,
    pub from_cache: bool,
}

/// Evento `guide-progress` durante il download e l'analisi.
#[derive(Debug, Clone, Serialize)]
struct Progress {
    bytes: u64,
    total: Option<u64>,
    parsing: bool,
}

static GUIDE: Mutex<Option<Loaded>> = Mutex::new(None);
static REFRESHING: AtomicBool = AtomicBool::new(false);
static LOAD_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn load_lock() -> &'static tokio::sync::Mutex<()> {
    LOAD_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Dimentica la guida in memoria (logout, "Svuota cache").
pub fn forget() {
    if let Ok(mut g) = GUIDE.lock() {
        *g = None;
    }
}

// ---------------------------------------------------------------------------
// Orari XMLTV
// ---------------------------------------------------------------------------

/// Giorni dal 1970-01-01 (calendario gregoriano, algoritmo di H. Hinnant).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "+0200", "-05:30", "+02" → secondi; assente o non valido = UTC.
fn parse_offset(s: &str) -> i64 {
    let s = s.trim();
    let sign = match s.as_bytes().first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => return 0,
    };
    let digits: String = s[1..].chars().filter(|c| *c != ':').take_while(|c| c.is_ascii_digit()).collect();
    let (h, m) = match digits.len() {
        2 => (digits.parse::<i64>().unwrap_or(0), 0),
        4 => (digits[..2].parse::<i64>().unwrap_or(0), digits[2..].parse::<i64>().unwrap_or(0)),
        _ => return 0,
    };
    if h > 14 || m > 59 {
        return 0;
    }
    sign * (h * 3600 + m * 60)
}

/// "20261018140000 +0200" → (secondi Unix, "2026-10-18 14:00:00" nell'ora del file).
pub fn parse_xmltv_time(s: &str) -> Option<(i64, String)> {
    let s = s.trim();
    let n_digits = s.bytes().take_while(|b| b.is_ascii_digit()).count();
    if n_digits < 12 {
        return None;
    }
    let num = |a: usize, b: usize| s[a..b].parse::<i64>().ok();
    let (y, mo, d, h, mi) = (num(0, 4)?, num(4, 6)?, num(6, 8)?, num(8, 10)?, num(10, 12)?);
    let sec = if n_digits >= 14 { num(12, 14)? } else { 0 };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    let local = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + sec;
    let ts = local - parse_offset(&s[n_digits..]);
    Some((ts, format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, mo, d, h, mi, sec)))
}

// ---------------------------------------------------------------------------
// Analisi in streaming
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Pending {
    channel: String,
    start: i64,
    stop: i64,
    start_local: String,
    title: Option<String>,
    desc: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
enum Field {
    None,
    Title,
    Desc,
}

fn channel_key(id: &str) -> String {
    id.trim().to_lowercase()
}

fn clean_text(s: &str, max: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        return t;
    }
    let mut out: String = t.chars().take(max).collect();
    out.push('…');
    out
}

fn programme_from(e: &BytesStart) -> Option<Pending> {
    let mut p = Pending::default();
    let mut stop_raw = String::new();
    for a in e.attributes().flatten() {
        let Ok(v) = a.normalized_value(XmlVersion::Implicit1_0) else { continue };
        match a.key.local_name().as_ref() {
            "channel" => p.channel = channel_key(&v),
            "start" => {
                let (ts, local) = parse_xmltv_time(&v)?;
                p.start = ts;
                p.start_local = local;
            }
            "stop" => stop_raw = v.into_owned(),
            _ => {}
        }
    }
    if p.channel.is_empty() || p.start_local.is_empty() {
        return None;
    }
    // senza "stop" la fine è l'inizio del programma successivo (vedi `finish`)
    p.stop = parse_xmltv_time(&stop_raw).map(|(ts, _)| ts).unwrap_or(0);
    Some(p)
}

fn keep(out: &mut Channels, p: Pending, from: i64, to: i64) {
    // la fine può mancare: qui si scarta solo ciò che è certamente fuori dalla finestra
    if p.start >= to || (p.stop > 0 && p.stop <= from) || p.start < from - 2 * 86400 {
        return;
    }
    let title = p.title.map(|t| clean_text(&t, 300)).unwrap_or_default();
    let desc = p.desc.map(|d| clean_text(&d, DESC_MAX_CHARS)).unwrap_or_default();
    out.entry(p.channel).or_default().push(Prog(p.start, p.stop, p.start_local, title, desc));
}

/// Ordina, toglie i doppioni, ricava le fine mancanti e taglia alla finestra.
fn finish(out: &mut Channels, from: i64, to: i64) {
    for list in out.values_mut() {
        list.sort_by_key(|p| p.0);
        list.dedup_by_key(|p| p.0);
        for i in 0..list.len() {
            if list[i].1 == 0 {
                list[i].1 = list.get(i + 1).map(|n| n.0).unwrap_or(0);
            }
        }
        list.retain(|p| p.1 > p.0 && p.1 > from && p.0 < to);
    }
}

pub fn programme_count(c: &Channels) -> usize {
    c.values().map(Vec::len).sum()
}

/// Legge un documento XMLTV e tiene i programmi che toccano `[from, to)`.
/// Un file troncato o con errori a metà dà i programmi letti fino a quel punto.
pub fn parse_xmltv<R: BufRead>(src: R, from: i64, to: i64) -> Result<Channels, String> {
    let mut reader = Reader::from_reader(src);
    reader.config_mut().check_end_names = false;
    let mut buf = Vec::with_capacity(4096);
    let mut out: Channels = HashMap::new();
    let mut cur: Option<Pending> = None;
    let mut field = Field::None;
    let mut text = String::new();
    loop {
        let ev = match reader.read_event_into(&mut buf) {
            Ok(ev) => ev,
            Err(e) => {
                if out.is_empty() && cur.is_none() {
                    return Err(format!("Guida XMLTV non leggibile: {}", e));
                }
                break;
            }
        };
        match ev {
            Event::Start(e) => match e.local_name().as_ref() {
                "programme" => cur = programme_from(&e),
                "title" if cur.is_some() => {
                    field = Field::Title;
                    text.clear();
                }
                "desc" if cur.is_some() => {
                    field = Field::Desc;
                    text.clear();
                }
                _ => {}
            },
            Event::Empty(e) if e.local_name().as_ref() == "programme" => {
                if let Some(p) = programme_from(&e) {
                    keep(&mut out, p, from, to);
                }
            }
            Event::Text(t) if field != Field::None => text.push_str(&t.xml10_content()),
            Event::CData(t) if field != Field::None => text.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if field != Field::None => match r.resolve_char_ref() {
                Ok(Some(c)) => text.push(c),
                _ => match resolve_predefined_entity(&r) {
                    Some(s) => text.push_str(s),
                    None => {
                        text.push('&');
                        text.push_str(&r);
                        text.push(';');
                    }
                },
            },
            Event::End(e) => match e.local_name().as_ref() {
                "title" | "desc" => {
                    if let Some(p) = cur.as_mut() {
                        // più titoli (lingue diverse): vale il primo non vuoto
                        let slot = if field == Field::Title { &mut p.title } else { &mut p.desc };
                        if slot.as_deref().map_or(true, str::is_empty) {
                            *slot = Some(std::mem::take(&mut text));
                        }
                    }
                    field = Field::None;
                }
                "programme" => {
                    if let Some(p) = cur.take() {
                        keep(&mut out, p, from, to);
                    }
                    field = Field::None;
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if let Some(p) = cur.take() {
        keep(&mut out, p, from, to);
    }
    finish(&mut out, from, to);
    Ok(out)
}

/// Apre il file scaricato; alcuni server lo mandano compresso con gzip.
fn open_reader(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Guida scaricata non leggibile: {}", e))?;
    let mut br = BufReader::with_capacity(1 << 16, file);
    let gz = br.fill_buf().map(|b| b.starts_with(&[0x1f, 0x8b])).unwrap_or(false);
    if gz {
        Ok(Box::new(BufReader::with_capacity(1 << 16, flate2::bufread::MultiGzDecoder::new(br))))
    } else {
        Ok(Box::new(br))
    }
}

// ---------------------------------------------------------------------------
// Download, disco e memoria
// ---------------------------------------------------------------------------

fn guide_path(app: &AppHandle, server: &str, username: &str) -> Option<PathBuf> {
    account_dir(app, server, username).map(|d| d.join(FILE_NAME))
}

fn read_disk(path: &Path) -> Option<GuideFile> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_disk(path: &Path, file: &GuideFile) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = path.with_extension("json.tmp");
    let ok = std::fs::File::create(&tmp).ok().is_some_and(|f| {
        let mut w = BufWriter::new(f);
        serde_json::to_writer(&mut w, file).is_ok() && w.flush().is_ok()
    });
    if ok {
        let _ = std::fs::rename(&tmp, path);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// Scrive la copia su disco fuori dal thread asincrono e restituisce la guida.
async fn save(path: Option<PathBuf>, file: GuideFile) -> Result<GuideFile, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(p) = path {
            write_disk(&p, &file);
        }
        file
    })
    .await
    .map_err(|e| format!("Salvataggio della guida interrotto: {}", e))
}

async fn fetch_xmltv(
    app: &AppHandle,
    client: &reqwest::Client,
    server: &str,
    username: &str,
    password: &str,
) -> Result<GuideFile, String> {
    if username.trim().is_empty() || password.is_empty() {
        return Err("Username e password sono obbligatori".to_string());
    }
    let dir = account_dir(app, server, username).ok_or("Cartella della cache non disponibile")?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Impossibile creare la cartella della cache: {}", e))?;
    let tmp = dir.join("xmltv.download");
    let resp = client
        .get(format!("{}/xmltv.php", server))
        .query(&[("username", username.trim()), ("password", password)])
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .send()
        .await
        .map_err(describe_reqwest_error)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => "Il server non offre la guida completa (xmltv.php, HTTP 404)".to_string(),
            401 | 403 => "Accesso alla guida completa negato (xmltv.php, HTTP 401/403)".to_string(),
            code => format!("La guida completa non è disponibile (xmltv.php, HTTP {})", code),
        });
    }
    let total = resp.content_length();
    let mut out = BufWriter::with_capacity(1 << 20, std::fs::File::create(&tmp).map_err(|e| format!("Impossibile salvare la guida: {}", e))?);
    let mut stream = resp.bytes_stream();
    let (mut bytes, mut last) = (0u64, 0u64);
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(describe_reqwest_error)?;
            out.write_all(&chunk).map_err(|e| format!("Impossibile salvare la guida: {}", e))?;
            bytes += chunk.len() as u64;
            if bytes > MAX_BYTES {
                return Err("La guida completa è troppo grande (oltre 2 GB)".to_string());
            }
            if bytes - last >= 1 << 20 {
                last = bytes;
                let _ = app.emit("guide-progress", Progress { bytes, total, parsing: false });
            }
        }
        out.flush().map_err(|e| format!("Impossibile salvare la guida: {}", e))
    }
    .await;
    drop(out);
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let _ = app.emit("guide-progress", Progress { bytes, total, parsing: true });
    let now = now_secs() as i64;
    let path = tmp.clone();
    let channels = tauri::async_runtime::spawn_blocking(move || {
        let r = open_reader(&path).and_then(|rd| parse_xmltv(rd, now - PAST_SECS, now + FUTURE_SECS));
        let _ = std::fs::remove_file(&path);
        r
    })
    .await
    .map_err(|e| format!("Analisi della guida interrotta: {}", e))??;
    if programme_count(&channels) == 0 {
        return Err("La guida completa (xmltv.php) è vuota o non contiene programmi recenti".to_string());
    }
    Ok(GuideFile { fetched_at: now_secs(), channels })
}

fn status_of(l: &Loaded, from_cache: bool) -> GuideStatus {
    GuideStatus {
        channels: l.channels.len(),
        programmes: programme_count(&l.channels),
        fetched_at: l.fetched_at,
        from_cache,
    }
}

fn install(account: &str, file: GuideFile) -> GuideStatus {
    let l = Loaded { account: account.to_string(), fetched_at: file.fetched_at, channels: Arc::new(file.channels) };
    let st = status_of(&l, false);
    if let Ok(mut g) = GUIDE.lock() {
        *g = Some(l);
    }
    st
}

fn loaded_status(account: &str) -> Option<GuideStatus> {
    let g = GUIDE.lock().ok()?;
    g.as_ref().filter(|l| l.account == account).map(|l| status_of(l, true))
}

/// Guida più vecchia di `FRESH_SECS`: si riscarica in background e la UI riceve `guide-updated`.
fn refresh_in_background(app: AppHandle, client: reqwest::Client, server: String, username: String, password: String, fetched_at: u64) {
    if now_secs().saturating_sub(fetched_at) < FRESH_SECS || REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok(file) = fetch_xmltv(&app, &client, &server, &username, &password).await {
            if let Ok(file) = save(guide_path(&app, &server, &username), file).await {
                let st = install(&account_hash(&server, &username), file);
                let _ = app.emit("guide-updated", st);
            }
        }
        REFRESHING.store(false, Ordering::SeqCst);
    });
}

/// Prepara la guida completa dell'account: memoria, poi disco, poi download.
/// `cache`: "prefer" (predefinito) o "refresh" (scarica sempre).
#[tauri::command]
pub async fn load_guide(
    app: AppHandle,
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    cache: Option<String>,
) -> Result<GuideStatus, String> {
    let server = normalize_server(&server)?;
    let account = account_hash(&server, &username);
    let refresh = cache.as_deref() == Some("refresh");
    let client = state.client.clone();
    let _guard = load_lock().lock().await;

    if !refresh {
        if let Some(st) = loaded_status(&account) {
            refresh_in_background(app, client, server, username, password, st.fetched_at);
            return Ok(st);
        }
        if let Some(path) = guide_path(&app, &server, &username) {
            let file = tauri::async_runtime::spawn_blocking(move || read_disk(&path)).await.ok().flatten();
            if let Some(file) = file {
                let mut st = install(&account, file);
                st.from_cache = true;
                refresh_in_background(app, client, server, username, password, st.fetched_at);
                return Ok(st);
            }
        }
    }

    match fetch_xmltv(&app, &client, &server, &username, &password).await {
        Ok(file) => {
            let file = save(guide_path(&app, &server, &username), file).await?;
            Ok(install(&account, file))
        }
        // senza rete resta meglio la guida già caricata
        Err(e) => loaded_status(&account).ok_or(e),
    }
}

/// Programmi dei canali chiesti (`epg_channel_id`) che toccano `[from, to)`.
/// I canali assenti dalla guida mancano dalla risposta: la UI usa la guida per canale.
#[tauri::command]
pub async fn get_guide_programmes(
    server: String,
    username: String,
    channel_ids: Vec<String>,
    from: i64,
    to: i64,
) -> Result<HashMap<String, Vec<EpgEntry>>, String> {
    let server = normalize_server(&server)?;
    let account = account_hash(&server, &username);
    let channels = {
        let g = GUIDE.lock().map_err(|_| "Guida non disponibile".to_string())?;
        match g.as_ref().filter(|l| l.account == account) {
            Some(l) => l.channels.clone(),
            None => return Err("Guida completa non caricata".to_string()),
        }
    };
    Ok(programmes_for(&channels, &channel_ids, from, to))
}

pub fn programmes_for(channels: &Channels, ids: &[String], from: i64, to: i64) -> HashMap<String, Vec<EpgEntry>> {
    let mut out = HashMap::new();
    for id in ids.iter().take(MAX_QUERY_IDS) {
        if out.contains_key(id) {
            continue;
        }
        let Some(list) = channels.get(&channel_key(id)) else { continue };
        let entries = list
            .iter()
            .filter(|p| p.1 > from && p.0 < to)
            .map(|p| EpgEntry {
                id: String::new(),
                title: p.3.clone(),
                description: p.4.clone(),
                start: p.2.clone(),
                start_ts: p.0,
                end_ts: p.1,
                now_playing: false,
                has_archive: false,
            })
            .collect();
        out.insert(id.clone(), entries);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn xmltv_times_with_offsets() {
        // 2026-10-18 12:00:00 UTC = 1792324800
        assert_eq!(parse_xmltv_time("20261018140000 +0200").unwrap(), (1792324800, "2026-10-18 14:00:00".to_string()));
        assert_eq!(parse_xmltv_time("20261018120000").unwrap().0, 1792324800, "senza fuso = UTC");
        assert_eq!(parse_xmltv_time("20261018063000 -05:30").unwrap().0, 1792324800);
        assert_eq!(parse_xmltv_time("202610181400 +02").unwrap().0, 1792324800, "senza secondi, fuso di due cifre");
        assert_eq!(parse_xmltv_time("19991231235959 +0000").unwrap().0, 946684799);
        assert_eq!(parse_xmltv_time("20240229000000 +0000").unwrap().0, 1709164800, "anno bisestile");
        assert!(parse_xmltv_time("2026101814").is_none());
        assert!(parse_xmltv_time("20261318140000").is_none(), "mese non valido");
        assert!(parse_xmltv_time("").is_none());
    }

    const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv generator-info-name="panel">
  <channel id="Rai1.it"><display-name>Rai 1</display-name><icon src="http://x/1.png"/></channel>
  <programme start="20261018140000 +0200" stop="20261018150000 +0200" channel="Rai1.it">
    <title lang="it">Tom &amp; Jerry &#8211; speciale</title>
    <title lang="en">Tom and Jerry</title>
    <desc lang="it"><![CDATA[Cartoni <animati>]]>   in   replica</desc>
    <category lang="it">Bambini</category>
  </programme>
  <programme start="20261018130000 +0200" stop="20261018140000 +0200" channel="rai1.it"><title>Prima</title></programme>
  <programme start="20261018130000 +0200" stop="20261018140000 +0200" channel="rai1.it"><title>Doppione</title></programme>
  <programme start="20261018150000 +0200" channel="Rai1.it"><title>Senza fine</title></programme>
  <programme start="20261018160000 +0200" stop="20261018170000 +0200" channel="Rai1.it"><title>Dopo</title></programme>
  <programme start="20261001100000 +0200" stop="20261001110000 +0200" channel="Rai1.it"><title>Vecchio</title></programme>
  <programme start="20261018140000 +0200" stop="20261018150000 +0200" channel="Canale5.it"/>
  <programme start="rotto" channel="Canale5.it"><title>Scartato</title></programme>
</tv>"#;

    #[test]
    fn xmltv_is_parsed_by_channel_and_window() {
        let now = 1792324800;
        let c = parse_xmltv(Cursor::new(SAMPLE), now - 86400, now + 86400).unwrap();
        let rai = &c["rai1.it"];
        let titles: Vec<&str> = rai.iter().map(|p| p.3.as_str()).collect();
        assert_eq!(titles, ["Prima", "Tom & Jerry – speciale", "Senza fine", "Dopo"], "ordinati, doppione e vecchio scartati");
        assert_eq!(rai[1].0, now);
        assert_eq!(rai[1].1, now + 3600);
        assert_eq!(rai[1].2, "2026-10-18 14:00:00");
        assert_eq!(rai[1].4, "Cartoni <animati> in replica", "CDATA e spazi compattati");
        assert_eq!(rai[2].1, rai[3].0, "fine mancante = inizio del successivo");
        let c5 = &c["canale5.it"];
        assert_eq!(c5.len(), 1, "programma vuoto tenuto, orario rotto scartato");
        assert_eq!(c5[0].3, "");
        assert_eq!(programme_count(&c), 5);
    }

    #[test]
    fn query_returns_window_and_marks_missing_channels() {
        let now = 1792324800;
        let c = parse_xmltv(Cursor::new(SAMPLE), now - 86400, now + 86400).unwrap();
        let ids = vec!["Rai1.it".to_string(), "assente".to_string(), "Canale5.it".to_string()];
        let r = programmes_for(&c, &ids, now, now + 3600);
        assert_eq!(r["Rai1.it"].len(), 1, "solo i programmi che toccano la finestra");
        assert_eq!(r["Rai1.it"][0].title, "Tom & Jerry – speciale");
        assert_eq!(r["Rai1.it"][0].start, "2026-10-18 14:00:00");
        assert!(!r.contains_key("assente"));
        assert_eq!(r["Canale5.it"].len(), 1);
        let empty = programmes_for(&c, &ids, now + 30 * 86400, now + 31 * 86400);
        assert!(empty["Rai1.it"].is_empty(), "canale presente senza programmi: lista vuota, non assente");
    }

    #[test]
    fn truncated_or_broken_documents() {
        let now = 1792324800;
        let cut = &SAMPLE[..SAMPLE.find("<programme start=\"20261018160000").unwrap() + 40];
        let c = parse_xmltv(Cursor::new(cut), now - 86400, now + 86400).unwrap();
        let titles: Vec<&str> = c["rai1.it"].iter().map(|p| p.3.as_str()).collect();
        assert_eq!(titles, ["Prima", "Tom & Jerry – speciale"], "si tengono i programmi completi letti prima del taglio");
        assert!(parse_xmltv(Cursor::new("<tv></tv>"), 0, i64::MAX).unwrap().is_empty());
        assert!(parse_xmltv(Cursor::new("niente xml"), 0, i64::MAX).unwrap().is_empty());
    }

    #[test]
    fn long_descriptions_are_shortened() {
        let long = "parola ".repeat(200);
        let t = clean_text(&long, DESC_MAX_CHARS);
        assert_eq!(t.chars().count(), DESC_MAX_CHARS + 1);
        assert!(t.ends_with('…'));
        assert_eq!(clean_text("  a \n b ", 10), "a b");
    }

    #[test]
    fn gzip_files_are_read() {
        use flate2::write::GzEncoder;
        let dir = std::env::temp_dir().join(format!("xp-guide-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (plain, gz) = (dir.join("g.xml"), dir.join("g.xml.gz"));
        std::fs::write(&plain, SAMPLE).unwrap();
        let mut enc = GzEncoder::new(Vec::new(), flate2::Compression::fast());
        enc.write_all(SAMPLE.as_bytes()).unwrap();
        std::fs::write(&gz, enc.finish().unwrap()).unwrap();
        let now = 1792324800;
        for p in [&plain, &gz] {
            let c = parse_xmltv(open_reader(p).unwrap(), now - 86400, now + 86400).unwrap();
            assert_eq!(programme_count(&c), 5);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn disk_copy_roundtrip() {
        let now = 1792324800;
        let c = parse_xmltv(Cursor::new(SAMPLE), now - 86400, now + 86400).unwrap();
        let dir = std::env::temp_dir().join(format!("xp-guide-disk-{}", std::process::id()));
        let path = dir.join(FILE_NAME);
        write_disk(&path, &GuideFile { fetched_at: 42, channels: c.clone() });
        let back = read_disk(&path).unwrap();
        assert_eq!(back.fetched_at, 42);
        assert_eq!(back.channels, c);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Verifica su una guida reale salvata: `XP_SAMPLES=<cartella> cargo test xmltv_real -- --ignored --nocapture`
    /// (file `xmltv.xml` o `xmltv.xml.gz`, scaricato da `<server>/xmltv.php?username=..&password=..`).
    #[test]
    #[ignore = "richiede una guida reale nella cartella XP_SAMPLES"]
    fn xmltv_real() {
        let dir = PathBuf::from(std::env::var("XP_SAMPLES").expect("imposta XP_SAMPLES"));
        let path = [dir.join("xmltv.xml"), dir.join("xmltv.xml.gz")].into_iter().find(|p| p.exists()).expect("xmltv.xml mancante");
        let t = std::time::Instant::now();
        let c = parse_xmltv(open_reader(&path).unwrap(), 0, i64::MAX).unwrap();
        println!("{} canali, {} programmi in {:?}", c.len(), programme_count(&c), t.elapsed());
        let (id, list) = c.iter().max_by_key(|(_, l)| l.len()).unwrap();
        println!("{}: primo {:?}", id, list.first());
        assert!(programme_count(&c) > 0);
    }
}
