//! Contenuti aggiuntivi Xtream: guida TV (EPG), serie con stagioni ed episodi, scheda film.
//! Le risposte variano molto tra pannelli: tutto passa da `serde_json::Value` e dai
//! convertitori tolleranti di `xtream.rs`.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::cache::{load_list, CacheKey, Listing};
use crate::state::AppState;
use crate::xtream::{api_get, field, flex_f64, flex_string, normalize_server, parse_list, value_to_string};

/// Le risposte di guida, serie e film restano valide 10 minuti in memoria.
const MEMO_SECS: u64 = 600;

static MEMO: Mutex<Option<HashMap<String, (Instant, Value)>>> = Mutex::new(None);

fn memo_get(key: &str) -> Option<Value> {
    let guard = MEMO.lock().ok()?;
    let (at, v) = guard.as_ref()?.get(key)?;
    (at.elapsed() < Duration::from_secs(MEMO_SECS)).then(|| v.clone())
}

fn memo_put(key: String, v: Value) {
    if let Ok(mut guard) = MEMO.lock() {
        let map = guard.get_or_insert_with(HashMap::new);
        if map.len() > 2000 {
            map.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(MEMO_SECS));
        }
        map.insert(key, (Instant::now(), v));
    }
}

/// Chiamata API con memoria: la chiave include account e parametri.
async fn api_memo(
    client: &reqwest::Client,
    server: &str,
    username: &str,
    password: &str,
    extra: &[(&str, &str)],
) -> Result<Value, String> {
    let server = normalize_server(server)?;
    let key = format!(
        "{}|{}|{}",
        server,
        username.trim(),
        extra.iter().map(|(k, v)| format!("{}={}", k, v)).collect::<Vec<_>>().join("&")
    );
    if let Some(v) = memo_get(&key) {
        return Ok(v);
    }
    let v = api_get(client, &server, username, password, extra).await?;
    memo_put(key, v.clone());
    Ok(v)
}

/// Titoli e descrizioni EPG arrivano in base64; alcuni pannelli li mandano in chiaro.
pub fn decode_b64_text(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        return String::new();
    }
    let looks_b64 = t.len() % 4 == 0 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=');
    if looks_b64 {
        if let Ok(bytes) = STANDARD.decode(t) {
            if let Ok(text) = String::from_utf8(bytes) {
                if !text.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
                    return text.trim().to_string();
                }
            }
        }
    }
    t.to_string()
}

// ---------------------------------------------------------------------------
// Guida TV
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct EpgEntry {
    pub id: String,
    pub title: String,
    pub description: String,
    /// orario di inizio come lo scrive il server (fuso del server), usato per il catch-up
    pub start: String,
    pub start_ts: i64,
    pub end_ts: i64,
    pub now_playing: bool,
    pub has_archive: bool,
}

pub fn parse_epg(v: &Value) -> Vec<EpgEntry> {
    let list = v.get("epg_listings").cloned().unwrap_or(Value::Null);
    let items: Vec<Value> = match list {
        Value::Array(a) => a,
        Value::Object(m) => m.into_iter().map(|(_, x)| x).collect(),
        _ => Vec::new(),
    };
    let mut out: Vec<EpgEntry> = items
        .iter()
        .filter(|x| x.is_object())
        .map(|x| {
            let start_ts = field(x, "start_timestamp").parse::<i64>().unwrap_or(0);
            let mut end_ts = field(x, "stop_timestamp").parse::<i64>().unwrap_or(0);
            if end_ts == 0 {
                end_ts = field(x, "end_timestamp").parse::<i64>().unwrap_or(0);
            }
            EpgEntry {
                id: field(x, "id"),
                title: decode_b64_text(&field(x, "title")),
                description: decode_b64_text(&field(x, "description")),
                start: field(x, "start"),
                start_ts,
                end_ts,
                now_playing: field(x, "now_playing") == "1",
                has_archive: field(x, "has_archive") == "1",
            }
        })
        .filter(|e| e.start_ts > 0 && e.end_ts > e.start_ts)
        .collect();
    out.sort_by_key(|e| e.start_ts);
    out
}

/// Programma in onda e successivi (`get_short_epg`).
#[tauri::command]
pub async fn get_short_epg(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    stream_id: String,
    limit: Option<u32>,
) -> Result<Vec<EpgEntry>, String> {
    let limit = limit.unwrap_or(4).clamp(1, 20).to_string();
    let v = api_memo(
        &state.client,
        &server,
        &username,
        &password,
        &[("action", "get_short_epg"), ("stream_id", stream_id.trim()), ("limit", &limit)],
    )
    .await?;
    Ok(parse_epg(&v))
}

/// Programmi della giornata e dei giorni precedenti (`get_simple_data_table`), per il catch-up.
#[tauri::command]
pub async fn get_epg_day(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    stream_id: String,
) -> Result<Vec<EpgEntry>, String> {
    let v = api_memo(
        &state.client,
        &server,
        &username,
        &password,
        &[("action", "get_simple_data_table"), ("stream_id", stream_id.trim())],
    )
    .await?;
    Ok(parse_epg(&v))
}

// ---------------------------------------------------------------------------
// Serie
// ---------------------------------------------------------------------------

/// Una serie con gli stessi nomi di campo dei canali e dei film, così la lista
/// virtualizzata la mostra senza casi speciali. `alias` permette di rileggere sia la
/// risposta del server sia la copia salvata in cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesItem {
    #[serde(default, deserialize_with = "flex_string")]
    pub num: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub name: String,
    #[serde(rename = "stream_id", alias = "series_id", default, deserialize_with = "flex_string")]
    pub stream_id: String,
    #[serde(rename = "stream_icon", alias = "cover", default, deserialize_with = "flex_string")]
    pub stream_icon: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub category_id: String,
    #[serde(default, deserialize_with = "flex_f64")]
    pub rating: f64,
    #[serde(default, deserialize_with = "flex_string")]
    pub plot: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub genre: String,
    #[serde(rename = "release_date", alias = "releaseDate", default, deserialize_with = "flex_string")]
    pub release_date: String,
    #[serde(default, deserialize_with = "flex_string")]
    pub last_modified: String,
}

#[tauri::command]
pub async fn get_series_list(
    app: AppHandle,
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    category_id: String,
    cache: Option<String>,
) -> Result<Listing<SeriesItem>, String> {
    let server = normalize_server(&server)?;
    let cat = category_id.trim().to_string();
    let cat = if cat == "all" || cat == "*" { String::new() } else { cat };
    let key = CacheKey { server: server.clone(), username: username.clone(), action: "get_series".into(), category: cat.clone() };
    let client = state.client.clone();
    load_list(app, key, cache.as_deref().unwrap_or("prefer"), move || {
        let (client, server, username, password, cat) =
            (client.clone(), server.clone(), username.clone(), password.clone(), cat.clone());
        async move {
            let mut extra: Vec<(&str, &str)> = vec![("action", "get_series")];
            if !cat.is_empty() {
                extra.push(("category_id", cat.as_str()));
            }
            let v = api_get(&client, &server, &username, &password, &extra).await?;
            let mut list: Vec<SeriesItem> = parse_list::<SeriesItem>(v)
                .into_iter()
                .filter(|s| !s.stream_id.is_empty())
                .collect();
            for s in list.iter_mut() {
                if s.name.is_empty() {
                    s.name = format!("Serie {}", s.stream_id);
                }
            }
            Ok(list)
        }
    })
    .await
}

/// Codec dichiarati dal pannello (stesso significato dei nomi di ffprobe).
#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Codecs {
    pub video_codec: String,
    pub pix_fmt: String,
    pub field_order: String,
    pub width: i64,
    pub height: i64,
    pub audio_codec: String,
    pub audio_channels: i64,
}

fn parse_codecs(info: &Value) -> Codecs {
    let video = info.get("video").cloned().unwrap_or(Value::Null);
    let audio = info.get("audio").cloned().unwrap_or(Value::Null);
    Codecs {
        video_codec: field(&video, "codec_name").to_ascii_lowercase(),
        pix_fmt: field(&video, "pix_fmt"),
        field_order: field(&video, "field_order"),
        width: field(&video, "width").parse().unwrap_or(0),
        height: field(&video, "height").parse().unwrap_or(0),
        audio_codec: field(&audio, "codec_name").to_ascii_lowercase(),
        audio_channels: field(&audio, "channels").parse().unwrap_or(0),
    }
}

fn first_image(v: &Value) -> String {
    match v {
        Value::Array(a) => a.iter().map(value_to_string).find(|s| s.starts_with("http")).unwrap_or_default(),
        other => {
            let s = value_to_string(other);
            if s.starts_with("http") { s } else { String::new() }
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MediaMeta {
    pub name: String,
    pub plot: String,
    pub cast: String,
    pub director: String,
    pub genre: String,
    pub release_date: String,
    pub rating: f64,
    pub duration_secs: i64,
    pub image: String,
    pub backdrop: String,
    pub trailer: String,
}

fn parse_meta(info: &Value) -> MediaMeta {
    let image = [field(info, "movie_image"), field(info, "cover_big"), field(info, "cover")]
        .into_iter()
        .find(|s| s.starts_with("http"))
        .unwrap_or_default();
    let release = [field(info, "release_date"), field(info, "releaseDate"), field(info, "releasedate")]
        .into_iter()
        .find(|s| !s.is_empty())
        .unwrap_or_default();
    let rating = info.get("rating").map(value_to_string).unwrap_or_default().replace(',', ".").parse::<f64>().unwrap_or(0.0);
    MediaMeta {
        name: field(info, "name"),
        plot: [field(info, "plot"), field(info, "description")].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
        cast: [field(info, "cast"), field(info, "actors")].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
        director: field(info, "director"),
        genre: field(info, "genre"),
        release_date: release,
        rating,
        duration_secs: field(info, "duration_secs").parse().unwrap_or(0),
        image,
        backdrop: info.get("backdrop_path").map(first_image).unwrap_or_default(),
        trailer: field(info, "youtube_trailer"),
    }
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Season {
    pub season_number: i64,
    pub name: String,
    pub episode_count: i64,
    pub air_date: String,
    pub cover: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Episode {
    pub id: String,
    pub season: i64,
    pub episode_num: i64,
    pub title: String,
    pub container_extension: String,
    pub plot: String,
    pub image: String,
    pub duration_secs: i64,
    pub release_date: String,
    pub codecs: Codecs,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SeriesInfo {
    pub meta: MediaMeta,
    pub seasons: Vec<Season>,
    pub episodes: Vec<Episode>,
}

pub fn parse_series_info(v: &Value) -> SeriesInfo {
    let info = v.get("info").cloned().unwrap_or(Value::Null);
    let mut seasons: Vec<Season> = v
        .get("seasons")
        .and_then(|s| s.as_array())
        .map(|a| {
            a.iter()
                .filter(|s| s.is_object())
                .map(|s| Season {
                    season_number: field(s, "season_number").parse().unwrap_or(0),
                    name: field(s, "name"),
                    episode_count: field(s, "episode_count").parse().unwrap_or(0),
                    air_date: field(s, "air_date"),
                    cover: [field(s, "cover_big"), field(s, "cover")].into_iter().find(|c| c.starts_with("http")).unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    // "episodes" è un oggetto { "1": [...], "2": [...] } oppure un array di array
    let groups: Vec<Value> = match v.get("episodes") {
        Some(Value::Object(m)) => m.values().cloned().collect(),
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    };
    let mut episodes: Vec<Episode> = Vec::new();
    for g in groups {
        let list = match g {
            Value::Array(a) => a,
            obj @ Value::Object(_) => vec![obj],
            _ => continue,
        };
        for e in list.iter().filter(|e| e.is_object()) {
            let id = field(e, "id");
            if id.is_empty() {
                continue;
            }
            let einfo = e.get("info").cloned().unwrap_or(Value::Null);
            episodes.push(Episode {
                id,
                season: field(e, "season").parse().unwrap_or(0),
                episode_num: field(e, "episode_num").parse().unwrap_or(0),
                title: field(e, "title"),
                container_extension: field(e, "container_extension").trim_start_matches('.').to_ascii_lowercase(),
                plot: [field(&einfo, "plot"), field(&einfo, "overview")].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
                image: [field(&einfo, "movie_image"), field(&einfo, "cover_big")].into_iter().find(|s| s.starts_with("http")).unwrap_or_default(),
                duration_secs: field(&einfo, "duration_secs").parse().unwrap_or(0),
                release_date: [field(&einfo, "release_date"), field(&einfo, "releasedate"), field(&einfo, "air_date")].into_iter().find(|s| !s.is_empty()).unwrap_or_default(),
                codecs: parse_codecs(&einfo),
            });
        }
    }
    episodes.sort_by_key(|e| (e.season, e.episode_num));
    // stagioni mancanti o senza episodi dichiarati: si ricavano dagli episodi
    for e in &episodes {
        if !seasons.iter().any(|s| s.season_number == e.season) {
            seasons.push(Season { season_number: e.season, name: format!("Stagione {}", e.season), ..Default::default() });
        }
    }
    seasons.retain(|s| episodes.iter().any(|e| e.season == s.season_number));
    seasons.sort_by_key(|s| s.season_number);
    for s in seasons.iter_mut() {
        s.episode_count = episodes.iter().filter(|e| e.season == s.season_number).count() as i64;
    }
    SeriesInfo { meta: parse_meta(&info), seasons, episodes }
}

#[tauri::command]
pub async fn get_series_info(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    series_id: String,
) -> Result<SeriesInfo, String> {
    let v = api_memo(
        &state.client,
        &server,
        &username,
        &password,
        &[("action", "get_series_info"), ("series_id", series_id.trim())],
    )
    .await?;
    Ok(parse_series_info(&v))
}

// ---------------------------------------------------------------------------
// Film
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct VodInfo {
    pub meta: MediaMeta,
    pub codecs: Codecs,
}

pub fn parse_vod_info(v: &Value) -> VodInfo {
    let info = v.get("info").cloned().unwrap_or(Value::Null);
    let mut meta = parse_meta(&info);
    if meta.name.is_empty() {
        meta.name = v.get("movie_data").map(|m| field(m, "name")).unwrap_or_default();
    }
    VodInfo { meta, codecs: parse_codecs(&info) }
}

#[tauri::command]
pub async fn get_vod_info(
    state: State<'_, AppState>,
    server: String,
    username: String,
    password: String,
    vod_id: String,
) -> Result<VodInfo, String> {
    let v = api_memo(
        &state.client,
        &server,
        &username,
        &password,
        &[("action", "get_vod_info"), ("vod_id", vod_id.trim())],
    )
    .await?;
    Ok(parse_vod_info(&v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_titles_are_decoded_and_plain_text_kept() {
        assert_eq!(decode_b64_text("TW9ybmluZyBMaXZl"), "Morning Live");
        assert_eq!(decode_b64_text("Q2l0dMOg"), "Città");
        assert_eq!(decode_b64_text("Tg1 Notte"), "Tg1 Notte", "testo in chiaro con spazi");
        assert_eq!(decode_b64_text("Telegiornale"), "Telegiornale", "base64 valido ma non UTF-8");
        assert_eq!(decode_b64_text("News"), "News", "parola valida in base64 ma decodifica non testuale");
        assert_eq!(decode_b64_text("  "), "");
    }

    #[test]
    fn epg_is_parsed_sorted_and_filtered() {
        let v = json!({"epg_listings": [
            {"id": "2", "title": "QWZ0ZXJub29u", "description": "", "start": "2026-10-13 14:00:00",
             "start_timestamp": "1791900000", "stop_timestamp": "1791903600", "now_playing": 0, "has_archive": "1"},
            {"id": "1", "title": "TW9ybmluZyBMaXZl", "start": "2026-10-13 10:30:00",
             "start_timestamp": 1791887400, "stop_timestamp": 1791891900, "now_playing": 1},
            {"id": "x", "title": "rotto", "start_timestamp": "0", "stop_timestamp": "0"}
        ]});
        let e = parse_epg(&v);
        assert_eq!(e.len(), 2);
        assert_eq!(e[0].title, "Morning Live");
        assert!(e[0].now_playing);
        assert_eq!(e[1].title, "Afternoon");
        assert!(e[1].has_archive);
        assert!(parse_epg(&json!({"epg_listings": []})).is_empty());
        assert!(parse_epg(&json!(null)).is_empty());
    }

    #[test]
    fn series_item_reads_server_and_cache_forms() {
        let server = json!({"series_id": 49938, "name": "Serie", "cover": "http://img/c.jpg", "category_id": "1914",
                            "rating": "7,5", "releaseDate": "2024", "plot": "Trama"});
        let s: SeriesItem = serde_json::from_value(server).unwrap();
        assert_eq!(s.stream_id, "49938");
        assert_eq!(s.stream_icon, "http://img/c.jpg");
        assert_eq!(s.release_date, "2024");
        assert!((s.rating - 7.5).abs() < 1e-9);
        // la copia in cache usa i nomi serializzati e deve rileggersi uguale
        let cached = serde_json::to_value(&s).unwrap();
        assert_eq!(cached["stream_id"], "49938");
        let back: SeriesItem = serde_json::from_value(cached).unwrap();
        assert_eq!(back.stream_id, "49938");
        assert_eq!(back.stream_icon, "http://img/c.jpg");
    }

    #[test]
    fn series_info_flattens_episodes_by_season() {
        let v = json!({
            "seasons": [{"season_number": 1, "name": "Season 1", "episode_count": "9", "cover": "images/noposter.jpg"}],
            "info": {"name": "Serie", "cover": "http://img/s.jpg", "plot": "Trama", "rating": "8", "backdrop_path": ["http://img/b.jpg"]},
            "episodes": {
                "2": [{"id": "21", "episode_num": 1, "title": "S02E01", "container_extension": "MKV", "season": 2,
                        "info": {"duration_secs": 3000, "video": {"codec_name": "HEVC", "pix_fmt": "yuv420p10le", "width": 3840},
                                 "audio": {"codec_name": "eac3", "channels": 6}}}],
                "1": [{"id": "12", "episode_num": 2, "title": "S01E02", "season": 1},
                      {"id": "11", "episode_num": 1, "title": "S01E01", "season": "1"}]
            }
        });
        let s = parse_series_info(&v);
        assert_eq!(s.meta.name, "Serie");
        assert_eq!(s.meta.image, "http://img/s.jpg");
        assert_eq!(s.meta.backdrop, "http://img/b.jpg");
        let ids: Vec<&str> = s.episodes.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, ["11", "12", "21"]);
        assert_eq!(s.seasons.iter().map(|x| x.season_number).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(s.seasons[0].episode_count, 2, "conteggio reale, non quello dichiarato");
        assert_eq!(s.seasons[0].cover, "", "immagine non valida scartata");
        let e = &s.episodes[2];
        assert_eq!(e.container_extension, "mkv");
        assert_eq!(e.codecs.video_codec, "hevc");
        assert_eq!(e.codecs.pix_fmt, "yuv420p10le");
        assert_eq!(e.codecs.audio_codec, "eac3");
        assert_eq!(e.codecs.audio_channels, 6);
        // variante con array di array
        let alt = parse_series_info(&json!({"episodes": [[{"id": "5", "season": 3, "episode_num": 1}]]}));
        assert_eq!(alt.episodes.len(), 1);
        assert_eq!(alt.seasons[0].season_number, 3);
    }

    #[test]
    fn vod_info_meta_and_codecs() {
        let v = json!({
            "info": {"movie_image": "http://img/p.jpg", "plot": "Trama", "cast": "A, B", "rating": 6.3, "director": "D",
                     "release_date": "2026-09-09", "backdrop_path": ["http://img/b.jpg"], "duration_secs": 7808,
                     "youtube_trailer": "abc", "video": {"codec_name": "h264", "field_order": "tt"}, "audio": {"codec_name": "ac3"}},
            "movie_data": {"stream_id": 1, "name": "Film (2026)"}
        });
        let i = parse_vod_info(&v);
        assert_eq!(i.meta.name, "Film (2026)");
        assert_eq!(i.meta.image, "http://img/p.jpg");
        assert_eq!(i.meta.duration_secs, 7808);
        assert!((i.meta.rating - 6.3).abs() < 1e-9);
        assert_eq!(i.codecs.video_codec, "h264");
        assert_eq!(i.codecs.field_order, "tt");
        assert_eq!(i.codecs.audio_codec, "ac3");
        let empty = parse_vod_info(&json!([]));
        assert_eq!(empty.meta.name, "");
        assert_eq!(empty.codecs, Codecs::default());
    }

    /// Verifica su risposte reali di un provider salvate in una cartella:
    /// `XP_SAMPLES=<cartella> cargo test real_samples -- --ignored --nocapture`
    #[test]
    #[ignore = "richiede risposte reali salvate nella cartella XP_SAMPLES"]
    fn real_samples() {
        let dir = std::env::var("XP_SAMPLES").expect("imposta XP_SAMPLES");
        let read = |n: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(format!("{}/{}", dir, n)).unwrap()).unwrap() };
        let epg = parse_epg(&read("epg_day.json"));
        println!("guida: {} programmi, primo {:?}", epg.len(), epg.first().map(|e| (&e.title, &e.start)));
        assert!(!epg.is_empty());
        assert!(epg.iter().all(|e| !e.title.contains('=') || e.title.contains(' ')), "titoli decodificati");
        let short = parse_epg(&read("epg_short.json"));
        println!("in onda/dopo: {:?}", short.iter().map(|e| &e.title).collect::<Vec<_>>());
        let list: Vec<SeriesItem> = parse_list(read("series_list.json"));
        println!("serie: {}, prima {:?}", list.len(), list.first().map(|s| (&s.stream_id, &s.name, &s.genre)));
        assert!(!list.is_empty() && list.iter().all(|s| !s.stream_id.is_empty()));
        let info = parse_series_info(&read("series_info.json"));
        println!(
            "serie: {} stagioni, {} episodi, primo {:?}",
            info.seasons.len(),
            info.episodes.len(),
            info.episodes.first().map(|e| (&e.id, &e.title, &e.container_extension, &e.codecs.video_codec, &e.codecs.audio_codec))
        );
        assert!(!info.episodes.is_empty());
        let vod = parse_vod_info(&read("vod_info.json"));
        println!("film: {:?} {}s codec {:?}/{:?}", vod.meta.name, vod.meta.duration_secs, vod.codecs.video_codec, vod.codecs.audio_codec);
        assert!(!vod.meta.name.is_empty());
    }
}
