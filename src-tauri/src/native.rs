//! Ponte verso il plugin Kotlin dell'app Android (`NativePlugin.kt`): ExoPlayer sotto la WebView,
//! tasti del telecomando, player esterni e informazioni sul dispositivo.
//!
//! Gli eventi del plugin arrivano su un canale aperto all'avvio e diventano eventi Tauri globali:
//! `mpv` (stessi nomi delle proprietà di mpv, così la pagina non cambia) e `native-key`.

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Emitter, Manager, Runtime, Wry};

/// Pacchetto e classe del plugin in `gen/android/app/src/main/java`.
const PACKAGE: &str = "com.xtreamplayer.app";
const CLASS: &str = "NativePlugin";

pub struct Native(PluginHandle<Wry>);

#[derive(Serialize)]
struct WatchArgs {
    channel: Channel<Value>,
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("xpnative")
        .setup(|app, api| {
            let handle = api.register_android_plugin(PACKAGE, CLASS)?;
            let emitter = app.clone();
            let channel = Channel::new(move |body| {
                let msg = match body {
                    InvokeResponseBody::Json(text) => serde_json::from_str::<Value>(&text).ok(),
                    InvokeResponseBody::Raw(bytes) => serde_json::from_slice::<Value>(&bytes).ok(),
                };
                if let Some(msg) = msg {
                    forward(&emitter, msg);
                }
                Ok(())
            });
            // fuori dal setup: la risposta del plugin passa dal thread principale di Android
            let watcher = handle.clone();
            tauri::async_runtime::spawn(async move {
                let _ = watcher
                    .run_mobile_plugin_async::<Value>("watch", WatchArgs { channel })
                    .await;
            });
            app.manage(Native(handle));
            Ok(())
        })
        .build()
}

/// `{ "kind": "mpv", "name": ..., "value": ... }` o `{ "kind": "key", "key": ... }`.
fn forward<R: Runtime>(app: &AppHandle<R>, msg: Value) {
    let kind = msg.get("kind").and_then(Value::as_str).unwrap_or("");
    let _ = match kind {
        "mpv" => app.emit(
            "mpv",
            serde_json::json!({ "name": msg.get("name"), "value": msg.get("value") }),
        ),
        "key" => app.emit("native-key", msg.get("key")),
        _ => Ok(()),
    };
}

/// Comando del plugin Kotlin; l'errore è il messaggio leggibile restituito da `invoke.reject`.
pub async fn call<T: DeserializeOwned>(
    app: &AppHandle,
    command: &str,
    payload: impl Serialize,
) -> Result<T, String> {
    let native = app
        .try_state::<Native>()
        .ok_or_else(|| "plugin nativo non disponibile".to_string())?;
    native
        .0
        .run_mobile_plugin_async(command, payload)
        .await
        .map_err(|e| e.to_string())
}
