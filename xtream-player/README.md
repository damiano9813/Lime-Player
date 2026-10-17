# Xtream Player (Tauri v2)

Player IPTV desktop per Windows compatibile con le API Xtream Codes.

## Struttura

```
xtream-player/
├─ package.json                  script `npm test`, `npm run fetch:ffmpeg`
├─ scripts/fetch-ffmpeg.mjs      scarica ffmpeg/ffprobe LGPL (versione fissata, SHA-256)
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
│     ├─ 08-content.js           guida TV, serie ed episodi, catch-up, scheda film
│     └─ 09-main.js              tastiera e avvio
└─ src-tauri/
   ├─ Cargo.toml, build.rs, tauri.conf.json, capabilities/, icons/
   ├─ binaries/                  generata: ffmpeg/ffprobe per l'installer (non versionata)
   └─ src/
      ├─ main.rs                 avvio e registrazione dei comandi
      ├─ xtream.rs               client Xtream Codes, modelli tolleranti, comandi
      ├─ catalog.rs              guida TV (base64), serie con episodi, scheda film
      ├─ cache.rs                cache su disco delle liste
      ├─ state.rs                stato condiviso
      ├─ creds.rs                credenziali (password in Gestione credenziali di Windows)
      ├─ updater.rs              aggiornamenti dalle release GitHub
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
cd xtream-player
npm run fetch:ffmpeg   # una volta: tauri-build vuole i file di bundle.externalBin
npm test
cd src-tauri
cargo test
```

`cargo test keyring_roundtrip -- --ignored` prova il vero vault di Windows (crea e cancella una
voce di prova).

**Banco di prova del proxy** (senza aprire l'app): avvia il proxy reale su
`http://127.0.0.1:17999/` con token `bench` per le pagine di prova nel browser; in sviluppo le
tracce lette dalla PMT dei live vengono stampate su stdout (`[dev] tracce <sid>: ...`).

```powershell
cd xtream-player\src-tauri
$env:XP_BENCH_PORT = "17999"; $env:XP_BENCH_SECS = "600"
cargo test proxy_bench -- --ignored --nocapture
```

Per usare invece il proxy dell'app aperta, avviala con `XP_DEBUG_PROXY=1`: solo nelle build di
sviluppo stampa `[dev] proxy http://127.0.0.1:<porta>/ token <token>` (senza la variabile, o in
release, porta e token non compaiono mai).

```powershell
cd xtream-player\src-tauri
$env:XP_DEBUG_PROXY = "1"
cargo tauri dev
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
5. **ffmpeg** è incluso nell'installer (vedi "ffmpeg e licenza"): `npm run fetch:ffmpeg` lo
   scarica in `src-tauri/binaries/` (circa 165 MB una volta sola), e `cargo tauri dev`/`build` lo
   eseguono da soli prima di compilare (se i file ci sono già non scaricano nulla). tauri-build
   copia i due eseguibili anche accanto all'exe di sviluppo (`target\debug\`), quindi anche in
   sviluppo si usa la stessa build dell'installer. L'app cerca ffmpeg prima nella cartella
   dell'eseguibile, poi nel PATH e nelle installazioni note (`winget install Gyan.FFmpeg`).
   L'app converte al volo solo le tracce che WebView2 non decodifica (AC3, E-AC3, DTS, MP2 → AAC; MPEG-2, HEVC non supportato → H.264 con NVENC/QSV/AMF se disponibili, altrimenti libx264 o Media Foundation). Le tracce compatibili vengono copiate senza perdite.
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

Con `createUpdaterArtifacts` la build firma l'installer per l'aggiornamento automatico: serve la
chiave privata (vedi "Aggiornamenti").

```powershell
cd xtream-player\src-tauri
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$env:USERPROFILE\.tauri\xtream-player.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""   # la password scelta alla generazione
cargo tauri build
```

Output: `src-tauri\target\release\xtream-player.exe` e in `src-tauri\target\release\bundle\nsis\`
l'installer `Xtream Player_<versione>_x64-setup.exe` con la sua firma `.sig`. L'installer copia
`ffmpeg.exe`, `ffprobe.exe` e `ffmpeg-LICENSE.txt` accanto a `xtream-player.exe`.

## Aggiornamenti

All'avvio l'app legge `latest.json` dall'ultima release di GitHub
(`https://github.com/damiano9813/Lime-Player/releases/latest/download/latest.json`, in `plugins.updater` di
`tauri.conf.json`); se c'è una versione più recente compare un avviso e il pulsante
"Nuova versione … disponibile" nella barra laterale. "Aggiorna ora" ferma lo stream, scarica
l'installer, ne verifica la firma con la chiave pubblica (`pubkey`) e lo avvia; l'app si riavvia
aggiornata. Nelle Impostazioni, "Cerca aggiornamenti" ripete il controllo.

- **Chiavi di firma** (una volta): `cargo tauri signer generate -w "$env:USERPROFILE\.tauri\xtream-player.key"`.
  La chiave pubblica va in `plugins.updater.pubkey`; la chiave privata (e la sua password) resta
  solo sul tuo PC e nei segreti del repository, **mai nel repository**. Se la perdi, le versioni
  installate non accettano aggiornamenti firmati con una chiave nuova (vanno reinstallate a mano).
- **Pubblicare una versione con GitHub Actions**: aumenta `version` in `tauri.conf.json` e in
  `Cargo.toml`, poi `git tag v1.2.3` e `git push --tags`: il workflow
  `.github/workflows/release.yml` (`tauri-apps/tauri-action`) esegue i test, compila, firma e crea
  una release in bozza con installer, `.sig` e `latest.json`; pubblicala da GitHub. Segreti del
  repository: `TAURI_SIGNING_PRIVATE_KEY` (contenuto del file `.key`) e
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- **A mano**: dopo `cargo tauri build` crea su GitHub la release `v1.2.3` e carica l'installer e un
  `latest.json` come questo (`signature` = testo del file `.sig`; nell'URL GitHub sostituisce gli
  spazi del nome file con punti):
  ```json
  {
    "version": "1.2.3",
    "notes": "Novità della versione",
    "pub_date": "2026-10-18T12:00:00Z",
    "platforms": {
      "windows-x86_64": {
        "signature": "<contenuto di Xtream Player_1.2.3_x64-setup.exe.sig>",
        "url": "https://github.com/damiano9813/Lime-Player/releases/download/v1.2.3/Xtream.Player_1.2.3_x64-setup.exe"
      }
    }
  }
  ```

## ffmpeg e licenza

L'installer include `ffmpeg.exe` e `ffprobe.exe` della build **LGPL** di
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (release, nome dell'archivio e
SHA-256 fissati in `scripts/fetch-ffmpeg.mjs`), copiati senza modifiche ed eseguiti come
programmi separati. FFmpeg è distribuito sotto GNU LGPL 2.1 o successiva: il testo della licenza è
in `ffmpeg-LICENSE.txt` nella cartella d'installazione; il codice sorgente è su
<https://ffmpeg.org/download.html> e gli script della build su
<https://github.com/BtbN/FFmpeg-Builds>. La build LGPL non contiene libx264: senza una GPU
NVIDIA/Intel/AMD utilizzabile il video viene convertito con l'encoder H.264 di Windows
(Media Foundation, `h264_mf`). Il ffmpeg nella cartella dell'app ha la precedenza su quello nel
PATH.

## Note tecniche

- **Proxy locale**: i server Xtream non inviano header CORS, quindi `fetch` di mpegts.js e hls.js verrebbe bloccato dal WebView. `main.rs` avvia un proxy HTTP su `127.0.0.1` (porta casuale, protetto da un token casuale) che aggiunge CORS, imposta lo User-Agent `IPTVSmartersPro`, segue i redirect, inoltra `Range` (seek nei VOD) e riscrive le playlist HLS.
- **Live**: MPEG-TS via mpegts.js; dopo un errore si riprova e al secondo tentativo si passa a HLS (hls.js). Il formato si sceglie nelle Impostazioni ("Forza ffmpeg" converte sempre l'audio).
- **Codec**: l'app riconosce i codec non supportati (dai metadati dello stream e controllando che audio e video vengano davvero decodificati) e passa da sola alla conversione ffmpeg. La scelta viene ricordata per ogni canale, così lo zapping successivo è immediato. Film ed episodi vengono analizzati con ffprobe prima della riproduzione; il seek riavvia ffmpeg dal punto scelto.
- **Buffer adattivo (live)**: parte con circa 1 s di buffer, recupera il ritardo accelerando leggermente la velocità (fino a 1,15×, con tono preservato) e aumenta il buffer solo se si verifica uno scatto; dopo 45 s senza scatti torna a ridurlo. Nelle Impostazioni "Minimo / Medio / Stabile" fissa il buffer minimo.
- Prima di aprire il player esterno lo stream interno viene chiuso, per non superare il limite di connessioni dell'account.
- **Credenziali**: la password sta in Gestione credenziali di Windows (Credenziali generiche,
  voce `Xtream Player/<utente>@<server>`, crate `keyring`); `%APPDATA%\com.xtreamplayer.desktop\credentials.json`
  e `localStorage` (`xp.credentials`) contengono solo server e utente. L'accesso automatico legge
  la password da Rust (`load_credentials`). Un vecchio file o un `localStorage` con la password in
  chiaro vengono migrati al primo avvio. "Esci e dimentica credenziali" cancella file, voce del
  vault e `localStorage`.
- I certificati HTTPS non validi vengono accettati, perché molti provider IPTV usano certificati self-signed.
- Librerie e CSS sono locali (`ui/vendor/`, versioni fissate in `package.json`): niente CDN.
- **Cache delle liste**: categorie e liste vengono salvate in `%LOCALAPPDATA%\com.xtreamplayer.desktop\lists\`.
  All'avvio si mostrano subito quelle salvate (se hanno meno di 24 ore) e si aggiornano in
  background se hanno più di 10 minuti; senza rete si usa comunque l'ultima lista. Il pulsante
  di aggiornamento scarica sempre dal server; "Esci" cancella anche la cache.
- **Raffica iniziale**: su tutti i percorsi live il proxy salta i 20-30 s di video vecchio che
  molti server inviano alla connessione e passa al player (o a ffmpeg) solo il bordo live.
- Tasto **Backspace**: torna all'ultimo contenuto visto.
- **Guida TV**: programma in onda e successivo nel pannello info (con barra di avanzamento),
  nell'OSD a schermo intero e nelle righe visibili della lista (richiesta solo a scroll fermo,
  al massimo 4 richieste insieme, memorizzata 10 minuti).
- **Serie TV**: terza sezione con stagioni ed episodi; ripresa per episodio, episodio
  successivo automatico, ↑/↓ tra gli episodi. Preferiti e recenti si riferiscono alla serie.
- **Catch-up**: per i canali con archivio (icona accanto al nome) il pannello "Rivedi i
  programmi passati" elenca i programmi degli ultimi giorni; si aprono con
  `/timeshift/<utente>/<password>/<minuti>/<AAAA-MM-GG:HH-MM>/<id>.ts` e si riproducono come un film.
- **Scheda film**: trama, genere, anno, regia, cast, durata e locandina (`get_vod_info`).
  Se ffprobe non c'è o l'analisi non riesce, i codec dichiarati dal pannello (film ed episodi)
  bastano a scegliere il percorso di conversione.
- **Impostazioni** (ingranaggio nella barra laterale): buffer e modalità dei live, uscita audio
  (Stereo / Originale), lingua audio e sottotitoli preferite, qualità della conversione, player
  esterno preferito (mpv o VLC), "Svuota cache liste", stato di ffmpeg e dell'encoder con nuovo
  rilevamento. Salvate in `localStorage` (`xp.settings`, `xp.latMode`, `xp.liveFormat`).
- **Tracce audio dei live**: mentre inoltra il flusso, `ts.rs` legge PAT e PMT (tipo di stream,
  descrittori AC-3/E-AC-3/DTS/AAC, lingua ISO 639, sottotitoli DVB e televideo) e registra le
  tracce sotto il `sid` casuale che il player mette nell'URL di `/p/` e `/t/`; il comando
  `get_stream_tracks(sid)` le restituisce. L'ordine è quello della PMT, lo stesso di ffmpeg:
  scegliendo un'altra traccia dal pulsante "Audio e sottotitoli" il percorso ffmpeg riparte con
  `-map 0:a:N` (audio copiato se è AAC/MP3, altrimenti convertito in AAC) e la scelta resta
  ricordata per il canale. I sottotitoli DVB e il televideo sono immagini: elencati come non
  disponibili.
- **Film ed episodi**: prima dell'avvio ffprobe elenca tutte le tracce (indice, codec, lingua,
  titolo, canali): lingua audio e sottotitoli preferite si applicano senza riavvii. Cambiare
  traccia audio riavvia ffmpeg dal punto attuale (gli MP4 compatibili restano in lettura diretta
  sulla prima traccia).
- **Sottotitoli testuali** (SRT, ASS, mov_text, WebVTT): li estrae in WebVTT lo stesso processo
  ffmpeg che converte il film (`subs=` nel percorso `/t/`, uscite su socket locali), quindi
  nessuna connessione in più al provider (molti account ne hanno una sola) e tempi già allineati
  dopo un seek; il percorso `/s/{token}?u=..&i=N&ss=..&sid=..` li passa al `<track>` man mano che
  arrivano. Senza `sid`, `/s/` avvia un'estrazione separata (usata per gli MP4 in lettura diretta
  quando l'account ha più connessioni). Il `<track>` si aggiunge a riproduzione avviata: aggiunto
  prima, bloccherebbe il video finché il file non è completo. I sottotitoli a immagine (PGS, DVD,
  DVB) andrebbero bruciati nel video: non disponibili.
- **Audio 5.1**: con "Stereo" l'audio convertito esce in stereo (192 kbit/s); con "Originale" una
  sorgente multicanale resta 5.1 (`-ac 6 -b:a 384k`; nei live, dove i canali non sono noti
  prima, `aformat=channel_layouts=5.1|stereo`). L'audio AAC copiato mantiene sempre i suoi canali.
- **Qualità della conversione video** (`q=` nel percorso `/t/`): Veloce / Bilanciata / Alta =
  NVENC p1+ull cq 25 / p3+ll cq 22 / p5+ll cq 20; QSV veryfast/faster/medium con
  global_quality 25/22/20; AMF speed/balanced/quality; libx264 ultrafast/superfast/veryfast con
  crf 25/22/20; Media Foundation (`h264_mf`, build LGPL) `-rate_control quality` con quality
  50/60/70. Il rilevamento dell'encoder prova la qualità Bilanciata nell'ordine NVENC, QSV, AMF,
  libx264, Media Foundation.
- **Download sospeso dei film convertiti**: con molto buffer avanti mpegts.js chiude la richiesta
  `/t/` e poi la riapre con `Range: bytes=N-`. Il proxy tiene in attesa il processo ffmpeg (fino a
  10 minuti) con gli ultimi 16 MB prodotti e riprende dallo stesso byte, senza ricominciare dal
  punto del seek; l'attesa si chiude appena serve la connessione (nuovo stream, analisi, player
  esterno, stop).
