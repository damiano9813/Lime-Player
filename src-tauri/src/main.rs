// Nasconde la console in release su Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    xtream_player_lib::run()
}
