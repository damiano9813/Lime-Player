# Xtream Player (Tauri v2)

Player IPTV desktop per Windows compatibile con le API Xtream Codes.

## Struttura

```
xtream-player/
├─ package.json                  script `npm test`
├─ tests/core.test.js            test della logica pura del frontend (node --test)
├─ ui/
│  ├─ index.html                 markup e stili
│  ├─ vendor/                    generata: app.css (Tailwind), mpegts.js, hls.js
│  └─ js/
│     ├─ core.js                 logica pura testabile: codec, percorsi, URL, buffer adattivo
│     ├─ 01-base.js              utilità, toast, modale, scorciatoie, icone
│     ├─ 02-state.js             costanti e stato condiviso
│     ├─ 03-login.js             login, logout, account
│     ├─ 04-library.js           Live/Film, categorie, liste, ricerca, preferiti, recenti
│     ├─ 05-list.js              lista virtualizzata
│     ├─ 06-player.js            player, conversione ffmpeg, buffer adattivo
│     ├─ 07-controls.js          controlli del player e pannello info
│     └─ 08-main.js              tastiera e avvio
└─ src-tauri/
   ├─ Cargo.toml, build.rs, tauri.conf.json, capabilities/, icons/
   └─ src/
      ├─ main.rs                 avvio e registrazione dei comandi
      ├─ xtream.rs               client Xtream Codes, modelli tolleranti, comandi
      ├─ state.rs, creds.rs      stato condiviso, credenziali
      ├─ proxy.rs                proxy locale (CORS, Range, playlist HLS)
      ├─ media.rs                rilevamento ffmpeg/encoder, ffprobe, argomenti
      ├─ transcode.rs            percorso di conversione ffmpeg
      ├─ ts.rs                   PCR MPEG-TS e salto della raffica iniziale
      ├─ external.rs             player esterni
      └─ util.rs                 costanti e helper condivisi
```

I file in `ui/js/` sono script classici caricati in ordine e condividono lo stesso scope
globale; `core.js` non tocca DOM né Tauri e viene usato anche dai test.

## Test

```powershell
cd xtream-player\src-tauri
cargo test
cd ..
npm test
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
cd xtream-player
npm install
cd src-tauri
cargo tauri dev
```

`npm install` serve una volta sola (e dopo ogni cambio di `package.json`). Prima di ogni
avvio e build Tauri esegue `npm run build:ui`, che copia mpegts.js e hls.js in `ui/vendor/`
e compila Tailwind in `ui/vendor/app.css`: l'app non dipende più da CDN.
La prima compilazione scarica e compila le dipendenze Rust (alcuni minuti).

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
- Librerie e CSS sono locali (`ui/vendor/`, versioni fissate in `package.json`): niente CDN.
- **Cache delle liste**: categorie e liste vengono salvate in `%LOCALAPPDATA%\com.xtreamplayer.desktop\lists\`.
  All'avvio si mostrano subito quelle salvate (se hanno meno di 24 ore) e si aggiornano in
  background se hanno più di 10 minuti; senza rete si usa comunque l'ultima lista. Il pulsante
  di aggiornamento scarica sempre dal server; "Esci" cancella anche la cache.
- **Raffica iniziale**: su tutti i percorsi live il proxy salta i 20-30 s di video vecchio che
  molti server inviano alla connessione e passa al player (o a ffmpeg) solo il bordo live.
- Tasto **Backspace**: torna all'ultimo contenuto visto.
