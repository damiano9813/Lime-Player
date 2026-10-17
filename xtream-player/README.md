# Xtream Player (Tauri v2)

Player IPTV desktop per Windows compatibile con le API Xtream Codes.

## Struttura

```
xtream-player/
├─ ui/index.html                 UI completa (Tailwind CDN, mpegts.js, hls.js, lista virtualizzata)
└─ src-tauri/
   ├─ Cargo.toml
   ├─ build.rs                   richiesto da Tauri (tauri_build::build)
   ├─ tauri.conf.json            richiesto da tauri::generate_context!()
   ├─ capabilities/default.json  permessi core della finestra
   ├─ icons/icon.ico             richiesto da tauri-build su Windows
   └─ src/main.rs                modelli Serde, client reqwest, proxy locale, comandi Tauri
```

## Prerequisiti (una volta sola)

1. **Microsoft C++ Build Tools** (workload "Sviluppo di applicazioni desktop con C++"):
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```
2. **Rust** (toolchain MSVC):
   ```powershell
   winget install Rustlang.Rustup
   rustup default stable-msvc
   ```
3. **Tauri CLI**:
   ```powershell
   cargo install tauri-cli --version "^2" --locked
   ```
4. WebView2 è già incluso in Windows 10/11.
5. **ffmpeg** (consigliato, abilita tutti i codec nel player integrato):
   ```powershell
   winget install Gyan.FFmpeg
   ```
   L'app converte al volo solo le tracce che WebView2 non decodifica (AC3, E-AC3, DTS, MP2 → AAC; MPEG-2, HEVC non supportato → H.264 con NVENC/QSV/AMF se disponibili). Le tracce compatibili vengono copiate senza perdite.
6. Facoltativo: VLC (`winget install VideoLAN.VLC`), mpv o mpv.net come player esterni.

Riapri il terminale dopo l'installazione per aggiornare il PATH.

## Avvio

```powershell
cd xtream-player\src-tauri
cargo tauri dev
```

La prima compilazione scarica e compila le dipendenze (alcuni minuti).

## Build dell'installer

```powershell
cd xtream-player\src-tauri
cargo tauri build
```

Output: `src-tauri\target\release\xtream-player.exe` e l'installer NSIS in `src-tauri\target\release\bundle\nsis\`.

## Note tecniche

- **Proxy locale**: i server Xtream non inviano header CORS, quindi `fetch` di mpegts.js e hls.js verrebbe bloccato dal WebView. `main.rs` avvia un proxy HTTP su `127.0.0.1` (porta casuale, protetto da un token casuale) che aggiunge CORS, imposta lo User-Agent `IPTVSmartersPro`, segue i redirect, inoltra `Range` (seek nei VOD) e riscrive le playlist HLS.
- **Live**: MPEG-TS via mpegts.js; dopo un errore si riprova e al secondo tentativo si passa a HLS (hls.js). Il formato si può scegliere anche dal menu nei controlli ("Forza ffmpeg" converte sempre l'audio).
- **Codec**: l'app riconosce i codec non supportati (dai metadati dello stream e controllando che audio e video vengano davvero decodificati) e passa da sola alla conversione ffmpeg. La scelta viene ricordata per ogni canale, così lo zapping successivo è immediato. I film MKV/AVI vengono analizzati con ffprobe prima della riproduzione; il seek riavvia ffmpeg dal punto scelto.
- **Buffer adattivo (live)**: parte con circa 1 s di buffer, recupera il ritardo accelerando leggermente la velocità (fino a 1,15×, con tono preservato) e aumenta il buffer solo se si verifica uno scatto; dopo 45 s senza scatti torna a ridurlo. Il menu "Latenza minima / Bilanciata / Stabile" fissa il buffer minimo.
- Prima di aprire il player esterno lo stream interno viene chiuso, per non superare il limite di connessioni dell'account.
- **Credenziali**: salvate in chiaro in `localStorage` e in `%APPDATA%\com.xtreamplayer.desktop\credentials.json`. "Esci e dimentica credenziali" le cancella entrambe.
- I certificati HTTPS non validi vengono accettati, perché molti provider IPTV usano certificati self-signed.
- Le librerie JS vengono caricate da CDN con versioni fissate: serve una connessione a Internet all'avvio.
