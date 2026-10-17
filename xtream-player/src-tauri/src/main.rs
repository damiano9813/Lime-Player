// Nasconde la console in release su Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod catalog;
mod creds;
mod external;
mod media;
mod proxy;
mod state;
mod transcode;
mod ts;
mod util;
mod xtream;

use std::sync::Arc;

use media::media_tools;
use proxy::{random_token, run_proxy, ProxyCtx};
use state::{AppState, ProxyInfo};
use xtream::build_client;

fn main() {
    let client = build_client();
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("impossibile avviare il proxy locale");
    std_listener
        .set_nonblocking(true)
        .expect("impossibile configurare il proxy locale");
    let port = std_listener
        .local_addr()
        .expect("porta del proxy locale non disponibile")
        .port();
    let token = random_token();
    // solo in sviluppo: permette di provare il proxy da fuori (test dei codec)
    #[cfg(debug_assertions)]
    println!("[dev] proxy http://127.0.0.1:{}/ token {}", port, token);
    let proxy_ctx = Arc::new(ProxyCtx {
        client: client.clone(),
        port,
        token: token.clone(),
    });

    tauri::Builder::default()
        .manage(AppState {
            client,
            proxy: ProxyInfo { port, token },
        })
        .setup(move |_app| {
            tauri::async_runtime::spawn(run_proxy(std_listener, proxy_ctx));
            // rileva ffmpeg ed encoder all'avvio, così il primo fallback è immediato
            tauri::async_runtime::spawn(async {
                let _ = media_tools(false).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            xtream::xtream_login,
            xtream::get_categories,
            xtream::get_streams,
            state::get_proxy_info,
            creds::save_credentials,
            creds::load_credentials,
            creds::clear_credentials,
            external::open_in_external_player,
            media::get_media_capabilities,
            media::probe_stream,
            cache::clear_list_cache,
            catalog::get_short_epg,
            catalog::get_epg_day,
            catalog::get_series_list,
            catalog::get_series_info,
            catalog::get_vod_info,
            ts::get_stream_tracks,
            transcode::release_stream
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio dell'applicazione");
}
