//! Avvio dell'app, condiviso dall'eseguibile desktop (main.rs) e dall'app Android.

mod cache;
mod catalog;
mod creds;
mod external;
mod guide;
mod media;
// motore integrato: libmpv su Windows, ExoPlayer (plugin Kotlin) su Android, stessi comandi
#[cfg_attr(target_os = "android", path = "mpv_android.rs")]
mod mpv;
#[cfg(target_os = "android")]
mod native;
mod platform;
mod proxy;
mod state;
mod transcode;
mod ts;
#[cfg_attr(target_os = "android", path = "updater_android.rs")]
mod updater;
mod util;
mod xtream;

use std::sync::Arc;

use media::media_tools;
use proxy::{random_token, run_proxy, ProxyCtx};
use state::{AppState, ProxyInfo};
use xtream::build_client;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = build_client();
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).expect("impossibile avviare il proxy locale");
    std_listener
        .set_nonblocking(true)
        .expect("impossibile configurare il proxy locale");
    let port = std_listener
        .local_addr()
        .expect("porta del proxy locale non disponibile")
        .port();
    let token = random_token();
    // solo in sviluppo e su richiesta (XP_DEBUG_PROXY=1): permette di provare il proxy da fuori
    #[cfg(debug_assertions)]
    if debug_proxy_enabled(std::env::var("XP_DEBUG_PROXY").ok().as_deref()) {
        println!("[dev] proxy http://127.0.0.1:{}/ token {}", port, token);
    }
    let proxy_ctx = Arc::new(ProxyCtx {
        client: client.clone(),
        port,
        token: token.clone(),
    });

    platform_plugins(tauri::Builder::default())
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
            creds::import_account,
            creds::load_sync_code,
            creds::save_sync_code,
            creds::list_accounts,
            creds::load_account,
            creds::remove_account,
            creds::clear_last_account,
            external::open_in_external_player,
            media::get_media_capabilities,
            media::probe_stream,
            mpv::mpv_available,
            mpv::mpv_load,
            mpv::mpv_stop,
            mpv::mpv_set,
            mpv::mpv_seek,
            mpv::mpv_set_rect,
            cache::clear_list_cache,
            cache::clear_account_cache,
            catalog::get_short_epg,
            catalog::get_epg_day,
            guide::load_guide,
            guide::get_guide_programmes,
            catalog::get_series_list,
            platform::platform_info,
            platform::open_url,
            platform::leave_app,
            platform::show_keyboard,
            platform::set_orientation,
            catalog::get_series_info,
            catalog::get_vod_info,
            ts::get_stream_tracks,
            transcode::release_stream,
            updater::check_update,
            updater::install_update
        ])
        .run(tauri::generate_context!())
        .expect("errore durante l'avvio dell'applicazione");
}

/// Plugin desktop: istanza unica, stato della finestra e aggiornamenti.
#[cfg(not(target_os = "android"))]
fn platform_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    use tauri::Manager;
    use tauri_plugin_window_state::StateFlags;
    builder
        // va registrato per primo: la seconda istanza si chiude prima di avviare altro
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // niente FULLSCREEN: lo schermo intero del video non deve tornare al riavvio
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
}

/// Plugin Android: ExoPlayer, telecomando e servizi di sistema (`native.rs`).
#[cfg(target_os = "android")]
fn platform_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.plugin(native::init())
}

/// La stampa di porta e token del proxy richiede `XP_DEBUG_PROXY=1`.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn debug_proxy_enabled(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1") | Some("true"))
}

#[cfg(test)]
mod tests {
    use super::debug_proxy_enabled;

    #[test]
    fn proxy_token_printed_only_on_request() {
        assert!(debug_proxy_enabled(Some("1")));
        assert!(debug_proxy_enabled(Some("true")));
        assert!(!debug_proxy_enabled(None));
        assert!(!debug_proxy_enabled(Some("")));
        assert!(!debug_proxy_enabled(Some("0")));
    }
}
