//! Analisi minima di MPEG-TS (sync, PCR, PAT/PMT), salto della raffica iniziale dei server
//! e registro delle tracce dei canali live.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::{AsyncWrite, AsyncWriteExt};

/// Secondi senza dati dal provider dopo cui la connessione live si considera ferma.
pub const STALL_RECONNECT_SECS: f64 = 6.0;
/// Riconnessioni senza video nuovo ammesse in un minuto: oltre, il flusso si chiude e decide il
/// player. Quelle dopo cui sono arrivati dati nuovi non contano: alcuni provider chiudono la
/// connessione ogni pochi secondi e vanno semplicemente richiamati.
pub const MAX_RECONNECTS_PER_MIN: usize = 5;
/// Video nuovo (secondi di PCR) che rende "utile" la connessione precedente.
pub const RECONNECT_PROGRESS_SECS: f64 = 1.0;

/// Ultimo flusso live aperto. L'app ne riproduce uno alla volta e molti account permettono una
/// sola connessione: un flusso superato da uno più nuovo (cambio canale, passaggio a ffmpeg) si
/// chiude subito e soprattutto non si riconnette, altrimenti ruberebbe la connessione al nuovo
/// e i due si chiuderebbero a vicenda.
static LIVE_GEN: AtomicU64 = AtomicU64::new(0);

/// Inoltra uno stream live a `out` (ffmpeg o il player) saltando la raffica iniziale, di cui
/// tiene gli ultimi `keep` secondi. Se la connessione al provider cade o resta ferma per
/// `STALL_RECONNECT_SECS`, la riapre con `reopen` e riprende dal punto in cui era arrivata
/// senza chiudere `out`: il player vede solo una breve pausa nei dati, non un errore.
/// Termina su errore di scrittura (destinazione chiusa), quando `stop` diventa vero o quando
/// la riconnessione non riesce. Con `sid` legge anche PAT/PMT e registra le tracce. Con
/// `exclusive` termina anche appena parte un altro flusso esclusivo (vedi `LIVE_GEN`).
pub async fn pump_live<W, R, Fut>(
    resp: reqwest::Response,
    mut reopen: R,
    out: &mut W,
    stop: Option<&AtomicBool>,
    sid: Option<&str>,
    keep: f64,
    exclusive: bool,
) where
    W: AsyncWrite + Unpin,
    R: FnMut() -> Fut,
    Fut: Future<Output = Result<reqwest::Response, String>>,
{
    let mut body = Some(resp.bytes_stream());
    let mut skipper = BurstSkipper::with_keep(keep);
    let mut resync: Option<Resync> = None;
    let mut clock = PcrClock::default();
    let mut last_data = Instant::now();
    let mut reconnects: Vec<Instant> = Vec::new();
    // ultimo PCR inoltrato al momento della riconnessione precedente
    let mut pcr_at_reconnect: Option<f64> = None;
    // le tabelle si leggono solo finché non si trova la PMT: dopo, nessun costo per pacchetto
    let mut psi = sid.map(|_| PsiScanner::new());
    let gen = LIVE_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let superseded = || exclusive && LIVE_GEN.load(Ordering::SeqCst) != gen;
    loop {
        if stop.map(|s| s.load(Ordering::Relaxed)).unwrap_or(false) || superseded() {
            break;
        }
        let Some(stream) = body.as_mut() else { break };
        let next = match tokio::time::timeout(Duration::from_millis(150), stream.next()).await {
            Ok(n) => n,
            Err(_) => {
                // nessun dato per 150 ms: si rivaluta se la raffica è finita
                if !skipper.done && skipper.start.is_some() && resync.is_none() {
                    if let Some(data) = skipper.push(&[]) {
                        if !emit(out, &mut clock, &data).await {
                            break;
                        }
                    }
                }
                if last_data.elapsed().as_secs_f64() < STALL_RECONNECT_SECS {
                    continue;
                }
                None
            }
        };
        let bytes = match next {
            Some(Ok(b)) => b,
            _ => {
                // connessione al provider caduta o ferma: se ne apre un'altra (la vecchia si
                // chiude prima, molti account ne permettono una sola).
                // La connessione appena caduta ha portato video nuovo: non conta come fallita
                let progressed = match (pcr_at_reconnect, clock.last) {
                    (Some(before), Some(now)) => now - before >= RECONNECT_PROGRESS_SECS,
                    _ => false,
                };
                if progressed {
                    reconnects.clear();
                }
                pcr_at_reconnect = clock.last;
                reconnects.retain(|t| t.elapsed() < Duration::from_secs(60));
                if reconnects.len() >= MAX_RECONNECTS_PER_MIN {
                    break;
                }
                reconnects.push(Instant::now());
                drop(body.take());
                // un flusso più nuovo ha già la connessione: niente riconnessione
                if superseded() {
                    break;
                }
                match reopen().await {
                    // partito un altro flusso durante la riconnessione: la connessione è sua
                    Ok(_) if superseded() => break,
                    Ok(r) => body = Some(r.bytes_stream()),
                    Err(_) => break,
                }
                last_data = Instant::now();
                // si riprende dopo l'ultimo PCR inoltrato; senza riferimento (raffica non ancora
                // finita, flusso senza PCR) si ricomincia come una connessione nuova
                resync = match (skipper.done, clock.pid, clock.last) {
                    (true, Some(pid), Some(last)) => Some(Resync::new(pid, last)),
                    _ => {
                        skipper = BurstSkipper::with_keep(keep);
                        None
                    }
                };
                continue;
            }
        };
        last_data = Instant::now();
        if let (Some(scanner), Some(sid)) = (psi.as_mut(), sid) {
            if let Some(tracks) = scanner.push(&bytes) {
                register_tracks(sid, tracks);
                psi = None;
            }
        }
        let ok = if let Some(rs) = resync.as_mut() {
            match rs.push(&bytes) {
                ResyncStep::Wait => true,
                ResyncStep::Forward(data) => {
                    resync = None;
                    emit(out, &mut clock, &data).await
                }
                // il player non potrebbe usare dati non continui: si chiude e lui riparte
                ResyncStep::GiveUp => break,
            }
        } else if skipper.done {
            emit(out, &mut clock, &bytes).await
        } else {
            match skipper.push(&bytes) {
                Some(data) => emit(out, &mut clock, &data).await,
                None => true,
            }
        };
        if !ok {
            break;
        }
    }
}

/// Scrive verso il player (o ffmpeg) e tiene traccia dell'ultimo PCR inoltrato.
async fn emit<W: AsyncWrite + Unpin>(out: &mut W, clock: &mut PcrClock, data: &[u8]) -> bool {
    clock.feed(data);
    out.write_all(data).await.is_ok()
}

// ---------------------------------------------------------------------------
// Riconnessione: il nuovo collegamento riparte con la raffica del server, che contiene
// in gran parte video già inoltrato. Si scartano i pacchetti fino al primo PCR successivo
// all'ultimo inoltrato e si riprende da lì, così il player riceve un flusso continuo.
// Se la ripresa non è possibile (altra timeline, nessun dato utile) il flusso si chiude: dati
// con timestamp non continui il player li scarterebbe e resterebbe fermo, mentre a flusso
// chiuso riavvia il canale da capo.
// ---------------------------------------------------------------------------

/// Oltre questa distanza dall'ultimo PCR inoltrato il nuovo flusso è un'altra timeline. Indietro
/// si tollera molto: alcuni provider a ogni connessione rimandano 10 minuti già trasmessi.
pub const RESYNC_MAX_AHEAD_SECS: f64 = 30.0;
pub const RESYNC_MAX_BEHIND_SECS: f64 = 3600.0;
/// Senza PCR sul PID atteso per questo tempo la ripresa si abbandona.
pub const RESYNC_NO_PCR_SECS: f64 = 3.0;
/// Attesa massima perché un provider lento arrivi al punto già inoltrato: il player intanto
/// consuma il suo buffer ("Stabile" ne ha decine di secondi).
pub const RESYNC_MAX_WAIT_SECS: f64 = 30.0;

/// Ultimo PCR (sul PID del PCR) dei dati inoltrati; i pacchetti possono arrivare spezzati.
#[derive(Default)]
pub struct PcrClock {
    carry: Vec<u8>,
    pub pid: Option<u16>,
    pub last: Option<f64>,
}

impl PcrClock {
    pub fn feed(&mut self, data: &[u8]) {
        let mut buf = std::mem::take(&mut self.carry);
        buf.extend_from_slice(data);
        let mut i = 0;
        while i + TS_PACKET <= buf.len() {
            if buf[i] != 0x47 {
                match ts_find_sync(&buf, i + 1) {
                    Some(j) => i = j,
                    None => break,
                }
                continue;
            }
            if let Some((pid, pcr)) = ts_packet_pcr(&buf[i..i + TS_PACKET]) {
                if self.pid.is_none() {
                    self.pid = Some(pid);
                }
                if self.pid == Some(pid) {
                    self.last = Some(pcr);
                }
            }
            i += TS_PACKET;
        }
        // il resto (pacchetto incompleto o dati da risincronizzare) si tiene, al massimo 64 KB
        let keep_from = i.max(buf.len().saturating_sub(64 * 1024));
        self.carry = buf.split_off(keep_from.min(buf.len()));
    }
}

#[derive(Debug)]
pub enum ResyncStep {
    /// dati ancora già inoltrati: si scartano
    Wait,
    /// da qui il flusso prosegue quello inoltrato
    Forward(Vec<u8>),
    /// ripresa impossibile (altra timeline, niente PCR, attesa troppo lunga): si chiude il
    /// flusso e il player riavvia il canale
    GiveUp,
}

pub struct Resync {
    pid: u16,
    after: f64,
    pending: Vec<u8>,
    parsed: usize,
    synced: bool,
    start: Instant,
    /// ultimo PCR visto sul PID atteso: finché arrivano, il provider sta recuperando
    last_pcr_at: Option<Instant>,
}

impl Resync {
    pub fn new(pid: u16, after: f64) -> Self {
        Self::new_at(pid, after, Instant::now())
    }

    pub fn new_at(pid: u16, after: f64, now: Instant) -> Self {
        Resync {
            pid,
            after,
            pending: Vec::new(),
            parsed: 0,
            synced: false,
            start: now,
            last_pcr_at: None,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> ResyncStep {
        self.push_at(chunk, Instant::now())
    }

    pub fn push_at(&mut self, chunk: &[u8], now: Instant) -> ResyncStep {
        self.pending.extend_from_slice(chunk);
        if !self.synced {
            match ts_find_sync(&self.pending, 0) {
                Some(i) => {
                    self.parsed = i;
                    self.synced = true;
                }
                None => return self.give_up_if_late(now),
            }
        }
        while self.parsed + TS_PACKET <= self.pending.len() {
            if self.pending[self.parsed] != 0x47 {
                match ts_find_sync(&self.pending, self.parsed + 1) {
                    Some(i) => {
                        self.parsed = i;
                        continue;
                    }
                    None => break,
                }
            }
            let at = self.parsed;
            self.parsed += TS_PACKET;
            let Some((pid, pcr)) = ts_packet_pcr(&self.pending[at..at + TS_PACKET]) else {
                continue;
            };
            if pid != self.pid {
                continue;
            }
            self.last_pcr_at = Some(now);
            if pcr > self.after + RESYNC_MAX_AHEAD_SECS || pcr < self.after - RESYNC_MAX_BEHIND_SECS
            {
                // altra timeline
                return ResyncStep::GiveUp;
            }
            if pcr > self.after {
                return ResyncStep::Forward(self.pending.split_off(at));
            }
            // pacchetti già inoltrati: si liberano subito
            self.pending.drain(..self.parsed);
            self.parsed = 0;
        }
        self.give_up_if_late(now)
    }

    fn give_up_if_late(&mut self, now: Instant) -> ResyncStep {
        let since = |t: Instant| now.duration_since(t).as_secs_f64();
        if since(self.last_pcr_at.unwrap_or(self.start)) > RESYNC_NO_PCR_SECS {
            // nessun PCR dal provider
            ResyncStep::GiveUp
        } else if since(self.start) > RESYNC_MAX_WAIT_SECS {
            // il provider non raggiunge il punto inoltrato
            ResyncStep::GiveUp
        } else if self.pending.len() > 32 * 1024 * 1024 {
            // troppi dati senza ripresa
            ResyncStep::GiveUp
        } else {
            ResyncStep::Wait
        }
    }
}

// ---------------------------------------------------------------------------
// Raffica iniziale: alla connessione molti server Xtream inviano in ~1 s il proprio
// buffer (anche 20-30 s di video già vecchio), poi proseguono in tempo reale. Se il
// video va convertito, codificare quella raffica ritarda l'avvio di secondi. Il proxy
// legge i PCR dei pacchetti MPEG-TS, capisce quando il flusso torna al tempo reale e
// passa solo gli ultimi `keep` secondi: il bordo live più il buffer con cui parte il
// player (`keep=` nell'URL del proxy), che così non deve aspettarlo.
// Con `keep=all` (preset "Stabile") la raffica non si taglia: tutto passa subito, il player
// parte in un attimo con un buffer di decine di secondi, a costo di guardare indietro
// rispetto alla diretta di quanto è lunga la raffica.
// ---------------------------------------------------------------------------

/// Valore di `keep=` nell'URL del proxy: secondi tra 1 e 10 (predefinito `BURST_KEEP_SECS`)
/// oppure `all`, cioè infinito: nessun taglio.
pub fn parse_keep(v: Option<&str>) -> f64 {
    match v.map(str::trim) {
        Some("all") => f64::INFINITY,
        Some(s) => s
            .parse::<f64>()
            .ok()
            .filter(|x| x.is_finite())
            .map(|x| x.clamp(1.0, 10.0))
            .unwrap_or(BURST_KEEP_SECS),
        None => BURST_KEEP_SECS,
    }
}

pub const TS_PACKET: usize = 188;
pub const BURST_KEEP_SECS: f64 = 2.5;

pub fn ts_sync_at(buf: &[u8], i: usize) -> bool {
    i + 2 * TS_PACKET < buf.len()
        && buf[i] == 0x47
        && buf[i + TS_PACKET] == 0x47
        && buf[i + 2 * TS_PACKET] == 0x47
}

pub fn ts_find_sync(buf: &[u8], from: usize) -> Option<usize> {
    (from..buf.len()).find(|&i| ts_sync_at(buf, i))
}

/// PID e PCR (in secondi) di un pacchetto TS, se il pacchetto ne contiene uno.
pub fn ts_packet_pcr(p: &[u8]) -> Option<(u16, f64)> {
    if p.len() < 12 || p[0] != 0x47 {
        return None;
    }
    let pid = (((p[1] & 0x1f) as u16) << 8) | p[2] as u16;
    let afc = (p[3] >> 4) & 0x03;
    if afc != 2 && afc != 3 {
        return None;
    }
    if (p[4] as usize) < 7 || (p[5] & 0x10) == 0 {
        return None;
    }
    let base = ((p[6] as u64) << 25)
        | ((p[7] as u64) << 17)
        | ((p[8] as u64) << 9)
        | ((p[9] as u64) << 1)
        | ((p[10] as u64) >> 7);
    Some((pid, base as f64 / 90000.0))
}

pub struct BurstSkipper {
    pub pending: Vec<u8>,
    pub parsed: usize,
    pub synced: bool,
    pub pcr_pid: Option<u16>,
    pub first_pcr: Option<f64>,
    pub last_pcr: f64,
    pub marks: Vec<(usize, f64)>,
    pub samples: Vec<(f64, f64)>,
    pub start: Option<Instant>,
    pub done: bool,
    /// secondi di raffica da tenere: il buffer con cui parte il player
    pub keep: f64,
}

impl BurstSkipper {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::with_keep(BURST_KEEP_SECS)
    }

    /// `keep` infinito: nessun taglio, il flusso passa così com'è (già `done`).
    pub fn with_keep(keep: f64) -> Self {
        let all = keep == f64::INFINITY;
        BurstSkipper {
            pending: Vec::new(),
            parsed: 0,
            synced: false,
            pcr_pid: None,
            first_pcr: None,
            last_pcr: 0.0,
            marks: Vec::new(),
            samples: Vec::new(),
            start: None,
            done: all,
            keep: if all {
                keep
            } else if keep.is_finite() {
                keep.clamp(1.0, 10.0)
            } else {
                BURST_KEEP_SECS
            },
        }
    }

    pub fn release_all(&mut self) -> Vec<u8> {
        self.done = true;
        std::mem::take(&mut self.pending)
    }

    /// Accumula dati; restituisce i byte da inoltrare quando la raffica è finita.
    pub fn push(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        self.push_at(chunk, Instant::now())
    }

    /// Come `push`, con l'istante di arrivo esplicito (usato dai test).
    pub fn push_at(&mut self, chunk: &[u8], now: Instant) -> Option<Vec<u8>> {
        let start = *self.start.get_or_insert(now);
        self.pending.extend_from_slice(chunk);
        if !self.synced {
            if let Some(i) = ts_find_sync(&self.pending, 0) {
                self.parsed = i;
                self.synced = true;
            }
        }
        while self.synced && self.parsed + TS_PACKET <= self.pending.len() {
            if self.pending[self.parsed] != 0x47 {
                match ts_find_sync(&self.pending, self.parsed + 1) {
                    Some(i) => {
                        self.parsed = i;
                        continue;
                    }
                    None => break,
                }
            }
            if let Some((pid, pcr)) =
                ts_packet_pcr(&self.pending[self.parsed..self.parsed + TS_PACKET])
            {
                if self.pcr_pid.is_none() {
                    self.pcr_pid = Some(pid);
                }
                if self.pcr_pid == Some(pid) {
                    if self.first_pcr.is_none() {
                        self.first_pcr = Some(pcr);
                    } else if pcr + 1.0 < self.last_pcr {
                        // discontinuità o wrap del PCR: si inoltra tutto senza tagliare
                        return Some(self.release_all());
                    }
                    self.last_pcr = pcr;
                    self.marks.push((self.parsed, pcr));
                }
            }
            self.parsed += TS_PACKET;
        }

        let wall = now.duration_since(start).as_secs_f64();
        let media = self.first_pcr.map(|f| self.last_pcr - f).unwrap_or(0.0);
        self.samples.push((wall, media));
        // velocità del flusso (secondi di video per secondo reale) rispetto al campione più
        // recente vecchio almeno 300 ms; dopo la raffica i dati arrivano a grappoli, quindi
        // anche il silenzio (push senza dati) conta come ritorno al tempo reale
        let rate = self
            .samples
            .iter()
            .rev()
            .find(|(w, _)| wall - *w >= 0.3)
            .map(|(w, m)| (media - *m) / (wall - *w))
            .unwrap_or(f64::INFINITY);
        let no_pcr = self.first_pcr.is_none() && wall > 1.0;
        let finished = no_pcr
            || wall > 4.0
            || self.pending.len() > 64 * 1024 * 1024
            || (wall >= 0.35 && rate < 1.6);
        if !finished {
            return None;
        }
        if media - wall < 1.5 || self.marks.is_empty() {
            // nessuna raffica significativa
            return Some(self.release_all());
        }
        let cut = self.last_pcr - self.keep;
        let offset = self
            .marks
            .iter()
            .find(|(_, p)| *p >= cut)
            .map(|(o, _)| *o)
            .unwrap_or(0);
        self.done = true;
        let out = self.pending.split_off(offset);
        self.pending = Vec::new();
        self.marks = Vec::new();
        self.samples = Vec::new();
        Some(out)
    }
}

// ---------------------------------------------------------------------------
// Tracce dei canali live: la PAT indica il PID della PMT, la PMT elenca le tracce con tipo
// di stream e descrittori (lingua ISO 639, AC-3, E-AC-3, DTS, sottotitoli DVB, televideo).
// L'ordine delle tracce audio è quello della PMT, lo stesso che usa ffmpeg per `-map 0:a:N`
// e mpegts.js per la prima traccia: l'indice `index` si passa così com'è al percorso ffmpeg.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TsTrack {
    pub pid: u16,
    /// "video" | "audio" | "subtitle"
    pub kind: String,
    /// posizione tra le tracce dello stesso tipo
    pub index: usize,
    /// nome del codec come lo riporta ffmpeg (h264, mp2, ac3, eac3, aac, dvb_subtitle, ...)
    pub codec: String,
    /// codice ISO 639-2 in minuscolo, vuoto se il canale non lo dichiara
    pub lang: String,
    /// sottotitoli testuali (convertibili in WebVTT); quelli DVB sono immagini
    pub text: bool,
}

/// CRC-32/MPEG-2 delle sezioni PSI.
pub fn crc32_mpeg(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for &b in data {
        crc ^= (b as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// Pacchetto TS → (PID, inizio unità, payload).
fn ts_payload(p: &[u8]) -> Option<(u16, bool, &[u8])> {
    if p.len() < TS_PACKET || p[0] != 0x47 {
        return None;
    }
    let pid = (((p[1] & 0x1f) as u16) << 8) | p[2] as u16;
    let pusi = p[1] & 0x40 != 0;
    let start = match (p[3] >> 4) & 0x03 {
        1 => 4,
        3 => 5 + p[4] as usize,
        _ => return None,
    };
    if start >= TS_PACKET {
        return None;
    }
    Some((pid, pusi, &p[start..TS_PACKET]))
}

/// Codec e tipo di traccia dai dati della PMT, con le stesse regole del demuxer di ffmpeg.
fn classify_stream(
    stream_type: u8,
    descriptors: &[u8],
    hdmv: bool,
) -> Option<(&'static str, &'static str, bool)> {
    let mut registration = [0u8; 4];
    let mut has = |tag: u8| -> bool {
        let mut i = 0;
        while i + 2 <= descriptors.len() {
            let (t, len) = (descriptors[i], descriptors[i + 1] as usize);
            if t == 0x05 && len >= 4 && i + 6 <= descriptors.len() {
                registration.copy_from_slice(&descriptors[i + 2..i + 6]);
            }
            if t == tag {
                return true;
            }
            i += 2 + len;
        }
        false
    };
    let found = match stream_type {
        0x01 | 0x02 => ("video", "mpeg2video", false),
        0x10 => ("video", "mpeg4", false),
        0x1b | 0x20 => ("video", "h264", false),
        0x24 => ("video", "hevc", false),
        0xea => ("video", "vc1", false),
        0x03 | 0x04 => ("audio", "mp2", false),
        0x0f | 0x1c => ("audio", "aac", false),
        0x11 => ("audio", "aac_latm", false),
        0x81 => ("audio", "ac3", false),
        0x87 => ("audio", "eac3", false),
        0x8a => ("audio", "dts", false),
        0x82 | 0x85 | 0x86 if hdmv => ("audio", "dts", false),
        0x84 | 0xa1 if hdmv => ("audio", "eac3", false),
        0x83 if hdmv => ("audio", "truehd", false),
        0x06 => {
            if has(0x6a) {
                ("audio", "ac3", false)
            } else if has(0x7a) {
                ("audio", "eac3", false)
            } else if has(0x7b) {
                ("audio", "dts", false)
            } else if has(0x7c) {
                ("audio", "aac", false)
            } else if has(0x59) {
                ("subtitle", "dvb_subtitle", false)
            } else if has(0x56) {
                ("subtitle", "dvb_teletext", false)
            } else {
                match &registration {
                    b"AC-3" => ("audio", "ac3", false),
                    b"EAC3" => ("audio", "eac3", false),
                    b"DTS1" | b"DTS2" | b"DTS3" => ("audio", "dts", false),
                    b"Opus" => ("audio", "opus", false),
                    _ => return None,
                }
            }
        }
        _ => return None,
    };
    Some(found)
}

/// Lingua dal descrittore ISO 639 (tag 0x0A), oppure da quelli dei sottotitoli
/// (0x59) e del televideo (0x56), che iniziano anch'essi con il codice lingua.
fn descriptor_lang(descriptors: &[u8]) -> String {
    let mut fallback = String::new();
    let mut i = 0;
    while i + 2 <= descriptors.len() {
        let (tag, len) = (descriptors[i], descriptors[i + 1] as usize);
        let body =
            &descriptors[(i + 2).min(descriptors.len())..(i + 2 + len).min(descriptors.len())];
        if len >= 3 && body.len() >= 3 && matches!(tag, 0x0a | 0x56 | 0x59) {
            let code: String = body[..3]
                .iter()
                .filter(|c| c.is_ascii_alphabetic())
                .map(|c| c.to_ascii_lowercase() as char)
                .collect();
            if code.len() == 3 {
                if tag == 0x0a {
                    return code;
                }
                if fallback.is_empty() {
                    fallback = code;
                }
            }
        }
        i += 2 + len;
    }
    fallback
}

/// Elenco delle tracce da una sezione PMT completa (CRC verificato dal chiamante).
pub fn parse_pmt(sec: &[u8]) -> Option<(u8, Vec<TsTrack>)> {
    if sec.len() < 16 || sec[0] != 0x02 {
        return None;
    }
    let end = 3 + ((((sec[1] & 0x0f) as usize) << 8) | sec[2] as usize);
    if end > sec.len() || end < 16 {
        return None;
    }
    let version = (sec[5] >> 1) & 0x1f;
    let pil = (((sec[10] & 0x0f) as usize) << 8) | sec[11] as usize;
    let program_desc = sec.get(12..12 + pil)?;
    // registrazione "HDMV" (Blu-ray): cambia il significato dei tipi 0x80-0x86
    let hdmv = program_desc
        .windows(6)
        .any(|w| w[0] == 0x05 && w[1] >= 4 && &w[2..6] == b"HDMV");
    let mut tracks: Vec<TsTrack> = Vec::new();
    let mut i = 12 + pil;
    while i + 5 <= end - 4 {
        let stream_type = sec[i];
        let pid = (((sec[i + 1] & 0x1f) as u16) << 8) | sec[i + 2] as u16;
        let eil = (((sec[i + 3] & 0x0f) as usize) << 8) | sec[i + 4] as usize;
        let desc = &sec[i + 5..(i + 5 + eil).min(end - 4)];
        if let Some((kind, codec, text)) = classify_stream(stream_type, desc, hdmv) {
            let index = tracks.iter().filter(|t| t.kind == kind).count();
            tracks.push(TsTrack {
                pid,
                kind: kind.to_string(),
                index,
                codec: codec.to_string(),
                lang: descriptor_lang(desc),
                text,
            });
        }
        i += 5 + eil;
    }
    Some((version, tracks))
}

/// PID della PMT del primo programma da una sezione PAT completa.
pub fn parse_pat(sec: &[u8]) -> Option<u16> {
    if sec.len() < 12 || sec[0] != 0x00 {
        return None;
    }
    let end = 3 + ((((sec[1] & 0x0f) as usize) << 8) | sec[2] as usize);
    if end > sec.len() {
        return None;
    }
    let mut i = 8;
    while i + 4 <= end - 4 {
        let program = ((sec[i] as u16) << 8) | sec[i + 1] as u16;
        let pid = (((sec[i + 2] & 0x1f) as u16) << 8) | sec[i + 3] as u16;
        // il programma 0 è la Network Information Table
        if program != 0 {
            return Some(pid);
        }
        i += 4;
    }
    None
}

/// Legge PAT e PMT da un flusso TS a blocchi arbitrari (anche non allineati ai pacchetti).
pub struct PsiScanner {
    carry: Vec<u8>,
    pmt_pid: Option<u16>,
    sections: HashMap<u16, Vec<u8>>,
}

impl PsiScanner {
    pub fn new() -> Self {
        PsiScanner {
            carry: Vec::new(),
            pmt_pid: None,
            sections: HashMap::new(),
        }
    }

    /// Restituisce le tracce alla prima PMT valida.
    pub fn push(&mut self, chunk: &[u8]) -> Option<Vec<TsTrack>> {
        self.carry.extend_from_slice(chunk);
        let mut pos = 0;
        let mut result = None;
        while pos + TS_PACKET <= self.carry.len() && result.is_none() {
            if self.carry[pos] != 0x47 {
                match ts_find_sync(&self.carry, pos + 1) {
                    Some(i) => {
                        pos = i;
                        continue;
                    }
                    None => {
                        // si tengono gli ultimi due pacchetti per ritrovare il sync
                        pos = self.carry.len().saturating_sub(2 * TS_PACKET).max(pos);
                        break;
                    }
                }
            }
            let packet = self.carry[pos..pos + TS_PACKET].to_vec();
            pos += TS_PACKET;
            if let Some((pid, pusi, payload)) = ts_payload(&packet) {
                if pid == 0 || Some(pid) == self.pmt_pid {
                    result = self.feed_section(pid, pusi, payload);
                }
            }
        }
        self.carry.drain(..pos);
        // flusso senza tabelle (o PID sbagliati): non si accumula all'infinito
        if self.carry.len() > 64 * TS_PACKET {
            let keep = self.carry.len() - 2 * TS_PACKET;
            self.carry.drain(..keep);
        }
        result
    }

    fn feed_section(&mut self, pid: u16, pusi: bool, payload: &[u8]) -> Option<Vec<TsTrack>> {
        if pusi {
            let pointer = *payload.first()? as usize;
            if 1 + pointer > payload.len() {
                return None;
            }
            // i byte prima del puntatore chiudono la sezione precedente
            if let Some(buf) = self.sections.get_mut(&pid) {
                buf.extend_from_slice(&payload[1..1 + pointer]);
            }
            if let Some(found) = self.complete(pid) {
                return Some(found);
            }
            self.sections.insert(pid, payload[1 + pointer..].to_vec());
        } else {
            self.sections.get_mut(&pid)?.extend_from_slice(payload);
        }
        self.complete(pid)
    }

    fn complete(&mut self, pid: u16) -> Option<Vec<TsTrack>> {
        let buf = self.sections.get(&pid)?;
        if buf.len() < 3 || buf[0] == 0xff {
            return None;
        }
        let len = 3 + ((((buf[1] & 0x0f) as usize) << 8) | buf[2] as usize);
        if buf.len() < len {
            return None;
        }
        let sec = buf[..len].to_vec();
        self.sections.remove(&pid);
        if len < 8 || crc32_mpeg(&sec) != 0 {
            return None;
        }
        if pid == 0 {
            if let Some(pmt) = parse_pat(&sec) {
                self.pmt_pid = Some(pmt);
            }
            return None;
        }
        parse_pmt(&sec).map(|(_, tracks)| tracks)
    }
}

// Registro delle sessioni: il player passa un `sid` casuale al proxy e poi chiede le tracce.
struct TrackEntry {
    at: Instant,
    tracks: Vec<TsTrack>,
}

fn track_registry() -> &'static Mutex<HashMap<String, TrackEntry>> {
    static REG: OnceLock<Mutex<HashMap<String, TrackEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn register_tracks(sid: &str, tracks: Vec<TsTrack>) {
    if sid.is_empty() || sid.len() > 64 {
        return;
    }
    // solo in sviluppo: i banchi di prova fuori dall'app non possono chiamare i comandi Tauri
    #[cfg(debug_assertions)]
    println!(
        "[dev] tracce {}: {}",
        sid,
        serde_json::to_string(&tracks).unwrap_or_default()
    );
    if let Ok(mut reg) = track_registry().lock() {
        // si tengono solo le sessioni recenti
        if reg.len() >= 64 {
            if let Some(oldest) = reg.iter().min_by_key(|(_, e)| e.at).map(|(k, _)| k.clone()) {
                reg.remove(&oldest);
            }
        }
        reg.insert(
            sid.to_string(),
            TrackEntry {
                at: Instant::now(),
                tracks,
            },
        );
    }
}

/// Tracce lette dalla PMT per la sessione `sid`; `None` finché la PMT non è arrivata.
#[tauri::command]
pub fn get_stream_tracks(sid: String) -> Option<Vec<TsTrack>> {
    track_registry()
        .lock()
        .ok()?
        .get(&sid)
        .map(|e| e.tracks.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Pacchetto TS sintetico: con `pcr` porta un campo di adattamento con PCR.
    fn packet(pid: u16, pcr: Option<f64>) -> Vec<u8> {
        let mut p = vec![0xffu8; TS_PACKET];
        p[0] = 0x47;
        p[1] = ((pid >> 8) & 0x1f) as u8;
        p[2] = (pid & 0xff) as u8;
        match pcr {
            Some(secs) => {
                let base = (secs * 90000.0).round() as u64;
                p[3] = 0x30;
                p[4] = 7;
                p[5] = 0x10;
                p[6] = (base >> 25) as u8;
                p[7] = (base >> 17) as u8;
                p[8] = (base >> 9) as u8;
                p[9] = (base >> 1) as u8;
                p[10] = (((base & 1) << 7) as u8) | 0x7e;
                p[11] = 0;
            }
            None => p[3] = 0x10,
        }
        p
    }

    /// Flusso da `from` a `to` secondi di PCR: un PCR ogni 0,1 s più due pacchetti dati.
    fn chunk(from: f64, to: f64) -> Vec<u8> {
        let mut out = Vec::new();
        let steps = ((to - from) / 0.1).round() as usize;
        for i in 0..steps {
            out.extend(packet(256, Some(from + i as f64 * 0.1)));
            out.extend(packet(257, None));
            out.extend(packet(258, None));
        }
        out
    }

    fn first_pcr(buf: &[u8]) -> Option<f64> {
        buf.chunks(TS_PACKET)
            .find_map(|p| ts_packet_pcr(p).map(|(_, pcr)| pcr))
    }

    #[test]
    fn pcr_roundtrip() {
        let p = packet(0x100, Some(1234.5));
        let (pid, pcr) = ts_packet_pcr(&p).expect("PCR atteso");
        assert_eq!(pid, 0x100);
        assert!((pcr - 1234.5).abs() < 0.001);
        assert!(ts_packet_pcr(&packet(0x100, None)).is_none());
    }

    #[test]
    fn find_sync_skips_garbage() {
        let mut buf = vec![0u8, 1, 2, 0x47, 9];
        let start = buf.len();
        buf.extend(chunk(0.0, 0.3));
        assert_eq!(ts_find_sync(&buf, 0), Some(start));
    }

    #[test]
    fn burst_is_trimmed_to_live_edge() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut s = BurstSkipper::new();
        // raffica: 24 s di video in 300 ms
        let mut out = None;
        for i in 0..4u64 {
            let from = i as f64 * 6.0;
            out = out.or(s.push_at(&chunk(from, from + 6.0), at(i * 100)));
        }
        assert!(out.is_none(), "durante la raffica non si inoltra nulla");
        // poi tempo reale: 0,3 s di video ogni 300 ms
        let mut t = 24.0;
        let mut ms = 600;
        while out.is_none() && ms < 3000 {
            out = s.push_at(&chunk(t, t + 0.3), at(ms));
            t += 0.3;
            ms += 300;
        }
        let out = out.expect("la raffica deve finire");
        assert!(s.done);
        assert_eq!(out[0], 0x47);
        assert_eq!(out.len() % TS_PACKET, 0, "uscita allineata ai pacchetti");
        let first = first_pcr(&out).expect("PCR nell'uscita");
        let last = t - 0.1;
        assert!(
            last - first <= BURST_KEEP_SECS + 0.11,
            "inizio {} troppo vecchio (ultimo {})",
            first,
            last
        );
        assert!(first > 20.0, "deve saltare la raffica, inizio {}", first);
    }

    #[test]
    fn realtime_stream_is_forwarded_whole() {
        let t0 = Instant::now();
        let mut s = BurstSkipper::new();
        let mut sent = 0usize;
        let mut out = None;
        let mut step = 0u64;
        while out.is_none() && step <= 20 {
            let c = chunk(step as f64 * 0.1, step as f64 * 0.1 + 0.1);
            sent += c.len();
            out = s.push_at(&c, t0 + Duration::from_millis(step * 100));
            step += 1;
        }
        let out = out.expect("rilascio atteso");
        assert_eq!(out.len(), sent, "senza raffica si inoltra tutto");
        assert!(step <= 6, "rilascio rapido, avvenuto al passo {}", step);
    }

    #[test]
    fn stream_without_pcr_is_released_whole_and_quickly() {
        // senza PCR non c'è nulla da tagliare: si inoltra tutto appena passati ~0,35 s
        let t0 = Instant::now();
        let mut s = BurstSkipper::new();
        let data: Vec<u8> = (0..30).flat_map(|_| packet(300, None)).collect();
        assert!(s.push_at(&data, t0).is_none());
        assert!(s.push_at(&data, t0 + Duration::from_millis(200)).is_none());
        let out = s
            .push_at(&data, t0 + Duration::from_millis(500))
            .expect("rilascio senza PCR");
        assert_eq!(out.len(), data.len() * 3);
    }

    #[test]
    fn pcr_discontinuity_releases_everything() {
        let t0 = Instant::now();
        let mut s = BurstSkipper::new();
        let a = chunk(100.0, 110.0);
        assert!(s.push_at(&a, t0).is_none());
        let b = chunk(50.0, 50.5);
        let out = s
            .push_at(&b, t0 + Duration::from_millis(100))
            .expect("rilascio su discontinuità");
        assert_eq!(out.len(), a.len() + b.len());
    }

    fn pcrs(buf: &[u8]) -> Vec<f64> {
        buf.chunks(TS_PACKET)
            .filter_map(|p| ts_packet_pcr(p).map(|(_, pcr)| pcr))
            .collect()
    }

    #[test]
    fn burst_keep_is_configurable() {
        assert_eq!(parse_keep(None), BURST_KEEP_SECS);
        assert_eq!(parse_keep(Some("4.5")), 4.5);
        assert_eq!(parse_keep(Some("99")), 10.0);
        assert_eq!(parse_keep(Some("0")), 1.0);
        assert_eq!(parse_keep(Some("x")), BURST_KEEP_SECS);
        // "all": nessun taglio, si inoltra subito
        assert!(parse_keep(Some("all")).is_infinite());
        assert!(BurstSkipper::with_keep(parse_keep(Some("all"))).done);
        assert!(!BurstSkipper::with_keep(f64::NAN).done);
        // con keep=6 la raffica di 24 s lascia al player gli ultimi ~6 s
        let t0 = Instant::now();
        let mut s = BurstSkipper::with_keep(6.0);
        assert!(s.push_at(&chunk(0.0, 24.0), t0).is_none());
        let out = s
            .push_at(&chunk(24.0, 24.3), t0 + Duration::from_millis(500))
            .expect("fine raffica");
        let p = pcrs(&out);
        let span = p.last().unwrap() - p.first().unwrap();
        assert!((5.9..=6.3).contains(&span), "tenuti {} s", span);
    }

    #[test]
    fn pcr_clock_follows_split_packets() {
        let data = chunk(10.0, 11.0);
        let mut c = PcrClock::default();
        // pezzi di dimensione dispari: i pacchetti arrivano spezzati
        for piece in data.chunks(1000) {
            c.feed(piece);
        }
        assert_eq!(c.pid, Some(256));
        assert!((c.last.unwrap() - 10.9).abs() < 0.001);
        // dati non allineati in testa: si risincronizza
        let mut c = PcrClock::default();
        let mut junk = vec![1u8, 2, 3];
        junk.extend(chunk(5.0, 5.5));
        c.feed(&junk);
        assert!((c.last.unwrap() - 5.4).abs() < 0.001);
    }

    #[test]
    fn resync_skips_what_was_already_sent() {
        let t0 = Instant::now();
        let mut r = Resync::new(256, 10.0);
        // la nuova connessione riparte da 5 s: fino a 10 s è già stato inoltrato
        let mut out = None;
        for piece in chunk(5.0, 12.0).chunks(5000) {
            match r.push_at(piece, t0) {
                ResyncStep::Wait => {}
                ResyncStep::Forward(d) => {
                    out = Some(d);
                    break;
                }
                ResyncStep::GiveUp => panic!("stessa timeline: niente abbandono"),
            }
        }
        let out = out.expect("ripresa attesa");
        assert_eq!(out[0], 0x47);
        assert!(
            (pcrs(&out)[0] - 10.1).abs() < 0.001,
            "riprende dopo l'ultimo inoltrato"
        );
    }

    #[test]
    fn resync_gives_up_on_another_timeline_or_without_pcr() {
        let t0 = Instant::now();
        let mut r = Resync::new_at(256, 10.0, t0);
        assert!(matches!(
            r.push_at(&chunk(500.0, 501.0), t0),
            ResyncStep::GiveUp
        ));
        let mut r = Resync::new_at(256, 10.0, t0);
        // nessun PCR sul PID atteso: dopo 3 s si abbandona
        let other: Vec<u8> = (0..20).flat_map(|_| packet(300, None)).collect();
        assert!(matches!(r.push_at(&other, t0), ResyncStep::Wait));
        assert!(matches!(
            r.push_at(&other, t0 + Duration::from_millis(3100)),
            ResyncStep::GiveUp
        ));
    }

    #[test]
    fn resync_waits_for_a_slow_provider_to_catch_up() {
        // il provider riparte 8 s indietro e manda i dati in tempo reale: servono ~8 s per
        // arrivare al punto già inoltrato, ben oltre i 3 s senza PCR, ma i PCR continuano
        let t0 = Instant::now();
        let mut r = Resync::new_at(256, 10.0, t0);
        let mut ms = 0u64;
        let mut t = 2.0;
        let out = loop {
            match r.push_at(&chunk(t, t + 0.5), t0 + Duration::from_millis(ms)) {
                ResyncStep::Wait => {}
                ResyncStep::Forward(d) => break d,
                ResyncStep::GiveUp => panic!("abbandonata dopo {} ms", ms),
            }
            t += 0.5;
            ms += 500;
            assert!(ms < 20_000, "ripresa mai avvenuta");
        };
        assert!((pcrs(&out)[0] - 10.1).abs() < 0.001);
        assert!(ms >= 7_500, "ha atteso il provider: {} ms", ms);
    }

    /// Risposta HTTP finta: i pezzi arrivano dopo le pause indicate.
    fn fake_response(parts: Vec<(u64, Vec<u8>)>) -> reqwest::Response {
        let stream = futures_util::stream::unfold(parts.into_iter(), |mut it| async move {
            let (pause, data) = it.next()?;
            tokio::time::sleep(Duration::from_millis(pause)).await;
            Some((Ok::<Vec<u8>, std::io::Error>(data), it))
        });
        reqwest::Response::from(http::Response::new(reqwest::Body::wrap_stream(stream)))
    }

    #[test]
    fn provider_closing_every_few_seconds_keeps_streaming() {
        // a ogni connessione il provider rimanda 20 s già trasmessi più 2 s nuovi e chiude:
        // 7 riconnessioni (più del limite di 5) che però portano sempre video nuovo
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let out = rt.block_on(async {
            let first = fake_response(vec![(0, chunk(0.0, 22.0))]);
            let mut next_end = 22.0;
            let mut left = 7;
            let reopen = move || {
                let resp = if left > 0 {
                    left -= 1;
                    let end = next_end + 2.0;
                    let r = fake_response(vec![(0, chunk(next_end - 20.0, end))]);
                    next_end = end;
                    Ok(r)
                } else {
                    Err("offline".to_string())
                };
                async move { resp }
            };
            let mut out: Vec<u8> = Vec::new();
            pump_live(first, reopen, &mut out, None, None, f64::INFINITY, false).await;
            out
        });
        let p = pcrs(&out);
        assert!(p.windows(2).all(|w| w[1] > w[0] && w[1] - w[0] < 0.11));
        assert!(
            (p.last().unwrap() - 35.9).abs() < 0.001,
            "tutte le 7 riconnessioni, ultimo PCR {}",
            p.last().unwrap()
        );
    }

    #[test]
    fn newer_exclusive_stream_closes_the_old_one() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let (old_secs, new_len) = rt.block_on(async {
            // vecchio flusso: 3 s di dati a pezzi, e se cade si riconnetterebbe all'infinito
            let slow: Vec<(u64, Vec<u8>)> = (0..30)
                .map(|i| (100, chunk(i as f64 * 0.1, i as f64 * 0.1 + 0.1)))
                .collect();
            let old = async {
                let t = Instant::now();
                let reopen = || async { Ok(fake_response(vec![(100, chunk(50.0, 51.0))])) };
                let mut out: Vec<u8> = Vec::new();
                pump_live(
                    fake_response(slow),
                    reopen,
                    &mut out,
                    None,
                    None,
                    f64::INFINITY,
                    true,
                )
                .await;
                t.elapsed().as_secs_f64()
            };
            // dopo 300 ms parte un nuovo canale
            let new = async {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let reopen = || async { Err::<reqwest::Response, String>("offline".into()) };
                let mut out: Vec<u8> = Vec::new();
                let first = fake_response(vec![(0, chunk(0.0, 1.0))]);
                pump_live(first, reopen, &mut out, None, None, f64::INFINITY, true).await;
                out.len()
            };
            futures_util::future::join(old, new).await
        });
        assert!(
            old_secs < 1.0,
            "il vecchio flusso deve chiudersi subito, durato {} s",
            old_secs
        );
        assert!(new_len > 0);
    }

    #[test]
    fn keep_all_forwards_the_whole_burst_and_still_resumes() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let out = rt.block_on(async {
            let first = fake_response(vec![(0, chunk(0.0, 10.0))]);
            let mut rest = vec![fake_response(vec![(0, chunk(5.0, 12.0))])];
            let reopen = move || {
                let next = rest.pop();
                async move { next.ok_or_else(|| "offline".to_string()) }
            };
            let mut out: Vec<u8> = Vec::new();
            pump_live(first, reopen, &mut out, None, None, f64::INFINITY, false).await;
            out
        });
        let p = pcrs(&out);
        assert!(p[0].abs() < 0.001, "tutta la raffica, dall'inizio");
        assert!(p.windows(2).all(|w| w[1] > w[0] && w[1] - w[0] < 0.11));
        assert!((p.last().unwrap() - 11.9).abs() < 0.001);
    }

    #[test]
    fn dropped_connection_resumes_without_repeating() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        let out = rt.block_on(async {
            // prima connessione: raffica 0-10 s, poi tempo reale fino a 10,3 s, poi cade
            let first = fake_response(vec![(0, chunk(0.0, 10.0)), (400, chunk(10.0, 10.3))]);
            // seconda: il server rimanda la sua raffica (5-12 s), poi cade di nuovo
            let mut rest = vec![fake_response(vec![(0, chunk(5.0, 12.0))])];
            let reopen = move || {
                let next = rest.pop();
                async move { next.ok_or_else(|| "offline".to_string()) }
            };
            let mut out: Vec<u8> = Vec::new();
            pump_live(first, reopen, &mut out, None, None, 3.0, false).await;
            out
        });
        let p = pcrs(&out);
        assert!(!p.is_empty());
        assert!(
            p.windows(2).all(|w| w[1] > w[0]),
            "nessun PCR ripetuto o all'indietro"
        );
        assert!(
            p[0] >= 10.2 - 3.0 - 0.11,
            "raffica tagliata a keep, inizio {}",
            p[0]
        );
        assert!(
            (p.last().unwrap() - 11.9).abs() < 0.001,
            "arriva in fondo alla seconda"
        );
        // nessun salto: la seconda connessione riprende esattamente dopo la prima
        assert!(p.windows(2).all(|w| w[1] - w[0] < 0.11));
    }

    // --- PAT/PMT sintetiche ---

    /// Sezione PSI completa di CRC: `table_id`, id (programma/TS) e corpo dopo l'intestazione.
    fn section(table_id: u8, id: u16, body: &[u8]) -> Vec<u8> {
        let len = 5 + body.len() + 4;
        let mut s = vec![
            table_id,
            0xb0 | ((len >> 8) as u8 & 0x0f),
            len as u8,
            (id >> 8) as u8,
            id as u8,
            0xc1,
            0,
            0,
        ];
        s.extend_from_slice(body);
        let crc = crc32_mpeg(&s);
        s.extend_from_slice(&crc.to_be_bytes());
        s
    }

    fn pat(pmt_pid: u16) -> Vec<u8> {
        // programma 0 (NIT) prima del programma vero
        section(
            0x00,
            1,
            &[
                0,
                0,
                0xe0,
                0x10,
                0,
                1,
                0xe0 | (pmt_pid >> 8) as u8,
                pmt_pid as u8,
            ],
        )
    }

    fn es(stream_type: u8, pid: u16, desc: &[u8]) -> Vec<u8> {
        let mut v = vec![
            stream_type,
            0xe0 | (pid >> 8) as u8,
            pid as u8,
            0xf0 | (desc.len() >> 8) as u8,
            desc.len() as u8,
        ];
        v.extend_from_slice(desc);
        v
    }

    fn lang(code: &str) -> Vec<u8> {
        let mut d = vec![0x0a, 4];
        d.extend_from_slice(code.as_bytes());
        d.push(0);
        d
    }

    fn pmt(streams: &[Vec<u8>]) -> Vec<u8> {
        let mut body = vec![0xe1, 0x00, 0xf0, 0x00]; // PCR PID 0x100, nessun descrittore di programma
        for s in streams {
            body.extend_from_slice(s);
        }
        section(0x02, 1, &body)
    }

    /// Divide una sezione in pacchetti TS sul `pid` (il primo con puntatore a 0).
    fn psi_packets(pid: u16, sec: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut data = vec![0u8];
        data.extend_from_slice(sec);
        for (i, part) in data.chunks(TS_PACKET - 4).enumerate() {
            let mut p = vec![
                0x47,
                ((pid >> 8) as u8 & 0x1f) | if i == 0 { 0x40 } else { 0 },
                pid as u8,
                0x10 | (i as u8 & 0x0f),
            ];
            p.extend_from_slice(part);
            p.resize(TS_PACKET, 0xff);
            out.extend(p);
        }
        out
    }

    /// PMT di un canale DVB con più lingue, sottotitoli e televideo.
    fn multilang_stream() -> Vec<u8> {
        let mut ac3 = vec![0x6a, 1, 0];
        ac3.extend(lang("eng"));
        let mut sub = vec![0x59, 8];
        sub.extend_from_slice(b"ita");
        sub.extend_from_slice(&[0x10, 0, 1, 0, 1]);
        let mut ttx = vec![0x56, 5];
        ttx.extend_from_slice(b"deu");
        ttx.extend_from_slice(&[0x09, 0x00]);
        let streams = vec![
            es(0x1b, 0x100, &[]),
            es(0x03, 0x101, &lang("ITA")),
            es(0x06, 0x102, &ac3),
            es(0x0f, 0x103, &[]),
            es(0x06, 0x104, &sub),
            es(0x06, 0x105, &ttx),
            es(0x06, 0x106, &[]), // dati privati senza descrittori: ffmpeg li ignora
            es(0x87, 0x107, &lang("spa")),
        ];
        let mut ts = Vec::new();
        ts.extend(chunk(0.0, 0.3));
        ts.extend(psi_packets(0, &pat(0x1000)));
        ts.extend(chunk(0.3, 0.5));
        ts.extend(psi_packets(0x1000, &pmt(&streams)));
        ts.extend(chunk(0.5, 0.7));
        ts
    }

    fn check_multilang(tracks: &[TsTrack]) {
        let audio: Vec<_> = tracks.iter().filter(|t| t.kind == "audio").collect();
        let summary: Vec<(usize, &str, &str)> = audio
            .iter()
            .map(|t| (t.index, t.codec.as_str(), t.lang.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (0, "mp2", "ita"),
                (1, "ac3", "eng"),
                (2, "aac", ""),
                (3, "eac3", "spa")
            ]
        );
        assert_eq!(audio[1].pid, 0x102);
        let video: Vec<_> = tracks.iter().filter(|t| t.kind == "video").collect();
        assert_eq!((video.len(), video[0].codec.as_str()), (1, "h264"));
        let subs: Vec<(usize, &str, &str, bool)> = tracks
            .iter()
            .filter(|t| t.kind == "subtitle")
            .map(|t| (t.index, t.codec.as_str(), t.lang.as_str(), t.text))
            .collect();
        assert_eq!(
            subs,
            vec![
                (0, "dvb_subtitle", "ita", false),
                (1, "dvb_teletext", "deu", false)
            ]
        );
        assert!(
            !tracks.iter().any(|t| t.pid == 0x106),
            "flusso dati escluso"
        );
    }

    #[test]
    fn crc_matches_mpeg2_reference() {
        // valore di controllo del CRC-32/MPEG-2 per "123456789"
        assert_eq!(crc32_mpeg(b"123456789"), 0x0376_e6e7);
        let s = pat(0x1000);
        assert_eq!(
            crc32_mpeg(&s),
            0,
            "una sezione con il suo CRC dà resto zero"
        );
    }

    #[test]
    fn pat_and_pmt_give_tracks_in_pmt_order() {
        let mut s = PsiScanner::new();
        let tracks = s.push(&multilang_stream()).expect("tracce dalla PMT");
        check_multilang(&tracks);
    }

    #[test]
    fn tables_split_across_odd_chunks() {
        // blocchi di rete di 1000 byte, non allineati ai pacchetti, e PMT su più pacchetti
        let mut big = Vec::new();
        for i in 0..30u16 {
            big.push(es(0x03, 0x200 + i, &lang(["ita", "eng"][i as usize % 2])));
        }
        let mut ts = vec![0x12, 0x34, 0x56]; // spazzatura prima del sync
        ts.extend(psi_packets(0, &pat(0x1fff)));
        ts.extend(psi_packets(0x1fff, &pmt(&big)));
        assert!(ts.len() >= 3 + 3 * TS_PACKET, "PMT su più pacchetti");
        let mut s = PsiScanner::new();
        let mut found = None;
        for c in ts.chunks(1000) {
            found = found.or(s.push(c));
        }
        let tracks = found.expect("tracce attese");
        assert_eq!(tracks.len(), 30);
        assert_eq!(
            (tracks[29].index, tracks[29].lang.as_str(), tracks[29].pid),
            (29, "eng", 0x21d)
        );
    }

    #[test]
    fn pmt_before_pat_and_bad_crc_are_ignored() {
        let streams = vec![es(0x1b, 0x100, &[]), es(0x0f, 0x101, &lang("ita"))];
        let good = pmt(&streams);
        let mut bad = good.clone();
        let n = bad.len();
        bad[n - 1] ^= 0xff;
        let mut s = PsiScanner::new();
        // PMT prima della PAT: il PID non è ancora noto
        assert!(s.push(&psi_packets(0x1000, &good)).is_none());
        assert!(s.push(&psi_packets(0, &pat(0x1000))).is_none());
        assert!(s.push(&psi_packets(0x1000, &bad)).is_none(), "CRC errato");
        let tracks = s.push(&psi_packets(0x1000, &good)).expect("PMT valida");
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[1].lang, "ita");
    }

    #[test]
    fn registration_descriptor_identifies_audio() {
        let reg = |id: &[u8; 4]| {
            let mut d = vec![0x05, 4];
            d.extend_from_slice(id);
            d
        };
        let sec = pmt(&[
            es(0x06, 0x101, &reg(b"EAC3")),
            es(0x06, 0x102, &reg(b"AC-3")),
            es(0x06, 0x103, &reg(b"ABCD")),
        ]);
        let (version, tracks) = parse_pmt(&sec).unwrap();
        assert_eq!(version, 0);
        let codecs: Vec<&str> = tracks.iter().map(|t| t.codec.as_str()).collect();
        assert_eq!(codecs, vec!["eac3", "ac3"]);
    }

    #[test]
    fn registry_keeps_tracks_per_session() {
        let mut s = PsiScanner::new();
        let tracks = s.push(&multilang_stream()).unwrap();
        register_tracks("test-sid-1", tracks);
        let got = get_stream_tracks("test-sid-1".to_string()).expect("sessione registrata");
        check_multilang(&got);
        assert!(get_stream_tracks("sconosciuta".to_string()).is_none());
        register_tracks("", vec![]);
        assert!(
            get_stream_tracks(String::new()).is_none(),
            "sid vuoto ignorato"
        );
    }
}
