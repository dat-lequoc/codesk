#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use std::{
                fs,
                process::{Command, Stdio},
            };
            use tauri::Manager;
            set_macos_app_icon();
            let resources = app.path().resource_dir()?;
            let gateway = resources.join("bin/codesk-gateway");
            let daemon = resources.join("bin/codeskd");
            let client_data = app.path().app_data_dir()?.join("client");
            fs::create_dir_all(&client_data)?;
            if daemon.exists() {
                let current = reqwest_health_version("127.0.0.1:4243");
                let required = Command::new(&daemon)
                    .arg("--version")
                    .output()
                    .ok()
                    .and_then(|output| String::from_utf8(output.stdout).ok())
                    .and_then(|text| text.split_whitespace().last().map(str::to_string));
                if let (Some(current), Some(required)) = (current, required) {
                    if version_lt(&current, &required) {
                        let _ = Command::new("pkill").args(["-x", "codeskd"]).status();
                        std::thread::sleep(std::time::Duration::from_millis(350));
                    }
                }
            }
            let already_running = std::net::TcpStream::connect("127.0.0.1:4242").is_ok();
            if already_running {
                // Another app instance owns this gateway. Register as an
                // additional owner so it survives until the last window closes,
                // and so quitting that other instance does not orphan our daemon.
                post_gateway(
                    "/api/owners",
                    &format!("{{\"pid\":{}}}", std::process::id()),
                );
            } else if gateway.exists() {
                let log_dir = app.path().app_log_dir()?;
                fs::create_dir_all(&log_dir)?;
                let stdout = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(log_dir.join("gateway.log"))?;
                let stderr = stdout.try_clone()?;
                Command::new(&gateway)
                    .env("CODESK_DAEMON_BINARY", &daemon)
                    .env("CODESK_CLIENT_DATA_DIR", &client_data)
                    .env("PORT", "4242")
                    // The gateway and the codeskd it spawns are ours: they must
                    // exit when this process does. See ARCHITECTURE.md §6.5.
                    .env("CODESK_OWNER_PID", std::process::id().to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(stdout))
                    .stderr(Stdio::from(stderr))
                    .spawn()?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Codesk desktop")
        .run(|_app, event| {
            // Immediate teardown on a graceful quit. The gateway's owner
            // watchdog is the backstop for SIGKILL and crashes, but waiting a
            // second for it would leave the daemon alive past the app's exit.
            // Sending our pid releases only our ownership, so a second running
            // instance keeps its gateway.
            if matches!(event, tauri::RunEvent::Exit) {
                post_gateway(
                    "/api/shutdown",
                    &format!("{{\"pid\":{}}}", std::process::id()),
                );
            }
        });
}

/// Best-effort POST to the local gateway with a short timeout.
///
/// Used on the app's exit path, so it must never block quitting: a gateway that
/// is already gone, wedged, or not ours simply fails the connect and returns.
fn post_gateway(route: &str, body: &str) {
    use std::io::Write;
    let Ok(address) = "127.0.0.1:4242".parse() else {
        return;
    };
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&address, std::time::Duration::from_millis(500))
    else {
        return;
    };
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(500)));
    let request = format!(
        "POST {route} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(request.as_bytes());
    let _ = stream.flush();
    // Give the gateway a moment to read the request before the socket closes.
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
    let mut discard = Vec::new();
    let _ = std::io::Read::read_to_end(&mut stream, &mut discard);
}

#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
    if let Some(icon) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe {
            NSApplication::sharedApplication(main_thread).setApplicationIconImage(Some(&icon));
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn set_macos_app_icon() {}

fn reqwest_health_version(address: &str) -> Option<String> {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect_timeout(
        &address.parse().ok()?,
        std::time::Duration::from_millis(250),
    )
    .ok()?;
    stream
        .write_all(b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .ok()?;
    let mut body = String::new();
    stream.read_to_string(&mut body).ok()?;
    let json = body.split("\r\n\r\n").nth(1)?;
    let marker = "\"version\":\"";
    let start = json.find(marker)? + marker.len();
    let end = json[start..].find('"')? + start;
    Some(json[start..end].to_string())
}

fn version_lt(left: &str, right: &str) -> bool {
    let parse = |value: &str| {
        value
            .split('.')
            .map(|part| part.parse::<u32>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let a = parse(left);
    let b = parse(right);
    (0..3)
        .find_map(|index| {
            let x = *a.get(index).unwrap_or(&0);
            let y = *b.get(index).unwrap_or(&0);
            (x != y).then_some(x < y)
        })
        .unwrap_or(false)
}
