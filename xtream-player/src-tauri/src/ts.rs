//! Analisi minima di MPEG-TS (sync, PCR) e salto della raffica iniziale dei server.

use std::time::Instant;

// ---------------------------------------------------------------------------
// Raffica iniziale: alla connessione molti server Xtream inviano in ~1 s il proprio
// buffer (anche 20-30 s di video già vecchio), poi proseguono in tempo reale. Se il
// video va convertito, codificare quella raffica ritarda l'avvio di secondi. Il proxy
// legge i PCR dei pacchetti MPEG-TS, capisce quando il flusso torna al tempo reale e
// passa a ffmpeg solo gli ultimi secondi, cioè il bordo live.
// ---------------------------------------------------------------------------

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
}

impl BurstSkipper {
    pub fn new() -> Self {
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
            done: false,
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
            if let Some((pid, pcr)) = ts_packet_pcr(&self.pending[self.parsed..self.parsed + TS_PACKET]) {
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
        let cut = self.last_pcr - BURST_KEEP_SECS;
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
        buf.chunks(TS_PACKET).find_map(|p| ts_packet_pcr(p).map(|(_, pcr)| pcr))
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
        assert!(last - first <= BURST_KEEP_SECS + 0.11, "inizio {} troppo vecchio (ultimo {})", first, last);
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
}
