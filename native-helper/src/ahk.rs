use crate::protocol::{FrameWriter, VERSION};
use anyhow::{bail, Context, Result};
use crossbeam_channel::{bounded, Sender, TrySendError};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::ffi::c_void;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{PCSTR, PCWSTR};
use windows::Win32::Foundation::{FreeLibrary, HANDLE, HMODULE};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, SetDefaultDllDirectories, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows::Win32::UI::WindowsAndMessaging::AllowSetForegroundWindow;

const DLL_NAME: &str = "AutoHotkey_H.dll";
const MAX_ACTION_UNITS: usize = 128;
const ACTIONS: [&str; 4] = [
    "show_translator",
    "screenshot_translate",
    "selection_translate",
    "screenshot_recognizer",
];

static CALLBACK_SENDER: OnceLock<Sender<String>> = OnceLock::new();

type NewThread = unsafe extern "system" fn(*const u16, *const u16, *const u16) -> *mut c_void;
type AhkReady = unsafe extern "system" fn(*mut c_void) -> i32;

pub struct HookOptions {
    pub session_token: String,
    pub script_path: PathBuf,
    pub expected_dll_sha256: String,
    pub foreground_pid: u32,
}

pub fn run_hook(options: HookOptions) -> Result<()> {
    validate_token(&options.session_token)?;
    if options.foreground_pid == 0 {
        bail!("foreground process id must be non-zero");
    }
    if !cfg!(target_arch = "x86_64") {
        bail!("AutoHotkey worker requires x86_64");
    }
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let trusted_directory = executable
        .parent()
        .context("helper executable has no parent")?;
    let dll_path = fs::canonicalize(trusted_directory.join(DLL_NAME))
        .context("resolve trusted AutoHotkey_H DLL")?;
    if dll_path.parent() != Some(trusted_directory) {
        bail!("AutoHotkey_H DLL resolves outside the helper resource directory");
    }
    verify_pe_x64(&dll_path)?;
    let dll_hash = sha256_file(&dll_path)?;
    if dll_hash != options.expected_dll_sha256.to_ascii_lowercase() {
        bail!("AutoHotkey_H DLL hash mismatch");
    }
    let script = fs::read(&options.script_path).context("read AutoHotkey script")?;
    if script.is_empty() || script.len() > 2 * 1024 * 1024 || script.contains(&0) {
        bail!("AutoHotkey script is empty, oversized, or contains NUL");
    }
    let script = String::from_utf8(script)
        .context("AutoHotkey script must be UTF-8")?
        .trim_start_matches('\u{feff}')
        .to_owned();

    let writer = Arc::new(FrameWriter::new(std::io::stdout()));
    let (sender, receiver) = bounded::<String>(256);
    CALLBACK_SENDER
        .set(sender)
        .map_err(|_| anyhow::anyhow!("AutoHotkey callback queue is already initialized"))?;
    let event_writer = Arc::clone(&writer);
    let foreground_pid = options.foreground_pid;
    thread::spawn(move || {
        while let Ok(action) = receiver.recv() {
            if ACTIONS.contains(&action.as_str()) {
                if action == "show_translator" {
                    // The AHK worker receives the user's hotkey, so Windows grants this
                    // process the right to choose the next foreground process. Transfer
                    // that one-shot right before Electron handles the action event.
                    let _ = unsafe { AllowSetForegroundWindow(foreground_pid) };
                }
                let _ = event_writer.json(&json!({
                    "v": VERSION,
                    "event": "action",
                    "action": action
                }));
            }
        }
    });

    let module = load_trusted_library(&dll_path)?;
    let _library = LibraryGuard(module);
    let new_thread: NewThread = unsafe { symbol(module, b"NewThread\0")? };
    let ahk_ready: AhkReady = unsafe { symbol(module, b"ahkReady\0")? };
    let callback_address = rust_callback as *const () as usize;
    let bootstrap = format!(
        "#NoTrayIcon\nPersistent True\n__toae_callback(action) {{\nDllCall({}, 'Str', action)\n}}\nrust_callback(action) {{\n__toae_callback(action)\n}}\n\n{}",
        callback_address, script
    );
    let script_wide = wide_nul(&bootstrap)?;
    let title_wide = wide_nul("TOAE AutoHotkey")?;
    let args_wide = wide_nul("")?;
    let thread_handle = unsafe {
        new_thread(
            script_wide.as_ptr(),
            title_wide.as_ptr(),
            args_wide.as_ptr(),
        )
    };
    if thread_handle.is_null() {
        bail!("AutoHotkey_H NewThread returned null");
    }

    let startup_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < startup_deadline {
        if unsafe { ahk_ready(thread_handle) } != 0 {
            writer.json(&json!({
                "v": VERSION,
                "event": "hook.ready",
                "running": true
            }))?;
            let mut consecutive_not_ready = 0_u8;
            loop {
                thread::sleep(Duration::from_millis(500));
                if unsafe { ahk_ready(thread_handle) } == 0 {
                    consecutive_not_ready = consecutive_not_ready.saturating_add(1);
                    if consecutive_not_ready >= 10 {
                        bail!("AutoHotkey_H thread stopped unexpectedly");
                    }
                } else {
                    consecutive_not_ready = 0;
                }
            }
        }
        thread::sleep(Duration::from_millis(50));
    }
    bail!("AutoHotkey_H script did not become ready")
}

extern "system" fn rust_callback(action: *const u16) {
    if action.is_null() {
        return;
    }
    let result = std::panic::catch_unwind(|| {
        let mut units = Vec::with_capacity(32);
        for index in 0..MAX_ACTION_UNITS {
            let unit = unsafe { *action.add(index) };
            if unit == 0 {
                break;
            }
            units.push(unit);
        }
        if units.is_empty() || units.len() == MAX_ACTION_UNITS {
            return;
        }
        let Ok(value) = String::from_utf16(&units) else {
            return;
        };
        let Some(sender) = CALLBACK_SENDER.get() else {
            return;
        };
        match sender.try_send(value) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
    });
    let _ = result;
}

fn load_trusted_library(path: &Path) -> Result<HMODULE> {
    let wide = wide_nul(path.to_string_lossy().as_ref())?;
    unsafe {
        SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_SYSTEM32)
            .context("configure secure DLL search path")?;
        LoadLibraryExW(
            PCWSTR(wide.as_ptr()),
            HANDLE(0),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
        .context("load trusted AutoHotkey_H DLL")
    }
}

unsafe fn symbol<T: Copy>(module: HMODULE, name: &'static [u8]) -> Result<T> {
    let address = GetProcAddress(module, PCSTR(name.as_ptr()))
        .context("required AutoHotkey_H export is missing")?;
    Ok(std::mem::transmute_copy(&address))
}

fn wide_nul(value: &str) -> Result<Vec<u16>> {
    if value.encode_utf16().any(|unit| unit == 0) {
        bail!("wide string contains NUL");
    }
    Ok(value.encode_utf16().chain(std::iter::once(0)).collect())
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

pub fn verify_pe_x64(path: &Path) -> Result<()> {
    let bytes = fs::read(path)?;
    if bytes.len() < 0x40 || &bytes[..2] != b"MZ" {
        bail!("native resource is not a PE image");
    }
    let offset = u32::from_le_bytes(bytes[0x3c..0x40].try_into().unwrap()) as usize;
    if offset.checked_add(6).is_none_or(|end| end > bytes.len())
        || &bytes[offset..offset + 4] != b"PE\0\0"
        || u16::from_le_bytes([bytes[offset + 4], bytes[offset + 5]]) != 0x8664
    {
        bail!("native resource is not an x64 PE image");
    }
    Ok(())
}

fn validate_token(token: &str) -> Result<()> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid helper session token");
    }
    Ok(())
}

struct LibraryGuard(HMODULE);
impl Drop for LibraryGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeLibrary(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_pe_resource() {
        let path = std::env::temp_dir().join(format!("toae-not-pe-{}", std::process::id()));
        fs::write(&path, b"not a pe").unwrap();
        assert!(verify_pe_x64(&path).is_err());
        let _ = fs::remove_file(path);
    }
}
