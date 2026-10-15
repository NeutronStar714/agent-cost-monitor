// The window, in Rust.
//
// It loads the local daemon over HTTP rather than bundling the UI, so the renderer
// stays one file that Claude Code, Codex and DSH all read from. `--tauri` exists
// because the browser-app fallback cannot drop its chrome; this can.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// Where a user's own settings live, next to everything else this project owns.
fn config_file() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|home| PathBuf::from(home).join(".agent-cost-monitor.json"))
}

/// The settings file, or null when there is none to read.
///
/// The launcher passes geometry in the environment, which is right when it started us directly.
/// It is not enough when Explorer started us instead: that hand-off exists because a process
/// launched from a host hook cannot create a WebView2 window at all — Windows answers "access
/// denied" — and Explorer cannot carry our environment with it. So the file is read here too, and
/// the environment still wins, because a direct launch is the more specific instruction.
fn read_config() -> serde_json::Value {
    match config_file().and_then(|path| std::fs::read_to_string(path).ok()) {
        Some(text) => serde_json::from_str(&text).unwrap_or(serde_json::Value::Null),
        None => serde_json::Value::Null,
    }
}

/// WebView2's own data folder: writable, per-user, and ours alone.
///
/// Leaving this to the default puts it beside the executable, which for a development build is
/// inside `target/release` — a directory a build can replace — and a data folder left behind by an
/// instance running with different rights is a documented cause of "access denied" at startup.
/// Naming it explicitly means it is always something this user can write to.
fn webview_data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    let dir = base.join("agent-cost-monitor").join("webview2");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Put a failure somewhere the launcher can read, because stderr is not always a channel.
///
/// When the Task Scheduler starts this process there is no pipe to capture, so the launcher saw
/// only "no window appeared" and could not say why — the same blindness, reached by a different
/// route. Writing to the same log the launcher uses closes that gap for every launch context.
fn note_in_log(text: &str) {
    let Some(home) = std::env::var("USERPROFILE").ok() else { return };
    let dir = PathBuf::from(home).join(".cache").join("agent-cost-monitor");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| format!("{}ms", elapsed.as_millis()))
        .unwrap_or_else(|_| "unknown".to_string());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("window.log")) {
        use std::io::Write;
        let _ = writeln!(file, "{stamp}  widget  {text}");
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let config = read_config();

            let port = std::env::var("ACM_WINDOW_PORT")
                .ok()
                .or_else(|| config.get("port").and_then(|value| value.as_u64()).map(|value| value.to_string()))
                .unwrap_or_else(|| "7420".to_string());
            let address: tauri::Url = format!("http://127.0.0.1:{port}/")
                .parse()
                .expect("the window port produced an unusable address");

            // Geometry comes from the launcher, which reads the config file — and from the config
            // file itself when Explorer started us and there was no launcher to pass anything down.
            let number = |key: &str, env: &str, fallback: f64| -> f64 {
                std::env::var(env)
                    .ok()
                    .and_then(|value| value.parse::<f64>().ok())
                    .or_else(|| config.get(key).and_then(|value| value.as_f64()))
                    .unwrap_or(fallback)
            };
            let (width, height) = (number("windowWidth", "ACM_WINDOW_WIDTH", 380.0), number("windowHeight", "ACM_WINDOW_HEIGHT", 600.0));
            let (x, y) = (number("windowX", "ACM_WINDOW_X", 40.0), number("windowY", "ACM_WINDOW_Y", 80.0));
            let on_top = std::env::var("ACM_ALWAYS_ON_TOP")
                .map(|value| value != "0")
                .unwrap_or_else(|_| config.get("alwaysOnTop").and_then(|value| value.as_bool()).unwrap_or(true));

            // The path is relative to THIS file, and icon.png lives in src-tauri/icons. It is the
            // 128px bitmap on purpose: a running window's taskbar button is drawn from the WINDOW's
            // icon, and on a 200%-scaled display that slot is 64px — an exact 2:1 reduction, where
            // a 512 source would be 8:1 and would leave the shell's own filter to guess.
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("the bundled 128px window icon should decode");

            // A widget that panics with "os error 5" tells the user nothing. In a context with no
            // interactive desktop — a service, an SSH session, a host hook, a background job —
            // creating the webview is refused by Windows, and that is worth saying in words rather
            // than in a Rust backtrace. This sentence is written to the launcher's log, which is
            // why it names the cause instead of describing the symptom.
            if let Err(error) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(address))
                // Must match the page's <title> in window/index.html: the launcher finds the
                // window by its title, so a widget titled differently is one it never reuses.
                .title("ACM")
                // `.icon` returns a Result, so the chain has to unwrap it here.
                .icon(icon)?
                .data_directory(webview_data_dir())
                .inner_size(width, height)
                .position(x, y)
                .min_inner_size(300.0, 220.0)
                .always_on_top(on_top)
                .resizable(true)
                .build()
            {
                // The launcher cannot always hear this process — a Task Scheduler launch has no pipe
                // to capture — so the reason is also written where the log lives, for every context.
                note_in_log(&format!("could not create the window: {error}"));
                eprintln!(
                    "agent-cost-monitor: could not create the window: {error}\n\
                     This needs an interactive desktop session with the WebView2 runtime.\n\
                     A process started by a host hook, a service or a background job cannot create\n\
                     one: Windows refuses the window (reported as 'access denied', os error 5), even\n\
                     though a browser can, because a browser hands off to its own running process\n\
                     while this one inherits the restriction. Start it from your own session instead."
                );
                std::process::exit(2);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not start the agent-cost-monitor window");
}
