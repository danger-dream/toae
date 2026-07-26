use crate::clipboard;
use crate::protocol::{read_frame, Frame, FrameWriter, VERSION};
use anyhow::{bail, Context, Result};
use serde_json::json;
use std::io::BufReader;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationTextChildPattern, IUIAutomationTextPattern,
    UIA_TextChildPatternId, UIA_TextPatternId,
};

const MAX_SELECTION_CHARS: usize = 1_000_000;
const MAX_PARENT_DEPTH: usize = 32;

pub struct SelectedText {
    pub text: String,
    pub method: &'static str,
    pub clipboard_restored: Option<bool>,
}

pub fn get_selected_text(
    deadline_ms: u64,
    session_token: &str,
    cancelled: &AtomicBool,
    clipboard_lock: &Mutex<()>,
) -> Result<SelectedText> {
    let deadline_ms = deadline_ms.clamp(300, 1_500);
    let started = Instant::now();
    let uia_budget = Duration::from_millis((deadline_ms * 2 / 3).clamp(200, 1_000));
    if let Ok(text) = run_uia_isolated(session_token, uia_budget) {
        if cancelled.load(Ordering::SeqCst) {
            bail!("selection request cancelled");
        }
        let text = text.trim().to_owned();
        if !text.is_empty() {
            return Ok(SelectedText {
                text,
                method: "uia",
                clipboard_restored: None,
            });
        }
    }

    if cancelled.load(Ordering::SeqCst) {
        bail!("selection request cancelled");
    }
    let elapsed = started.elapsed();
    let total = Duration::from_millis(deadline_ms);
    let remaining = total.saturating_sub(elapsed);
    if remaining < Duration::from_millis(150) {
        bail!("UI Automation timed out and no deadline remains for clipboard fallback");
    }
    let _clipboard_guard = clipboard_lock
        .lock()
        .map_err(|_| anyhow::anyhow!("clipboard selection lock poisoned"))?;
    if cancelled.load(Ordering::SeqCst) {
        bail!("selection request cancelled");
    }
    let copied = clipboard::copy_selected_text(Instant::now() + remaining)?;
    Ok(SelectedText {
        text: copied.text,
        method: "clipboard",
        clipboard_restored: Some(copied.restored),
    })
}

pub fn run_uia_worker(session_token: String) -> Result<()> {
    validate_token(&session_token)?;
    let writer = FrameWriter::new(std::io::stdout());
    match selected_text_uia() {
        Ok(text) => writer.json(&json!({
            "v": VERSION,
            "event": "uia.result",
            "ok": true,
            "text": text
        })),
        Err(error) => writer.json(&json!({
            "v": VERSION,
            "event": "uia.result",
            "ok": false,
            "error": { "code": "uia_unavailable", "message": error.to_string().chars().take(300).collect::<String>() }
        })),
    }
}

fn run_uia_isolated(session_token: &str, timeout: Duration) -> Result<String> {
    validate_token(session_token)?;
    let executable = std::env::current_exe().context("resolve helper executable")?;
    let mut child = Command::new(executable)
        .arg("--uia-worker")
        .arg("--session-token")
        .arg(session_token)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .context("start isolated UI Automation worker")?;
    let stdout = child
        .stdout
        .take()
        .context("UI Automation worker stdout is unavailable")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let result = read_frame(&mut BufReader::new(stdout));
        let _ = sender.send(result);
    });

    let value = match receiver.recv_timeout(timeout) {
        Ok(Ok(Some(Frame::Json(value)))) => value,
        Ok(Ok(Some(_))) => {
            let _ = child.kill();
            bail!("UI Automation worker returned an unexpected frame");
        }
        Ok(Ok(None)) => {
            let _ = child.wait();
            bail!("UI Automation worker exited without a result");
        }
        Ok(Err(error)) => {
            let _ = child.kill();
            return Err(error).context("read UI Automation worker response");
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            bail!("UI Automation worker timed out");
        }
    };
    let _ = child.wait();
    if value.get("v").and_then(|value| value.as_u64()) != Some(VERSION)
        || value.get("event").and_then(|value| value.as_str()) != Some("uia.result")
    {
        bail!("UI Automation worker response is incompatible");
    }
    if value.get("ok").and_then(|value| value.as_bool()) != Some(true) {
        bail!("UI Automation did not expose selected text");
    }
    let text = value
        .get("text")
        .and_then(|value| value.as_str())
        .context("UI Automation result omitted text")?;
    if text.chars().count() > MAX_SELECTION_CHARS {
        bail!("UI Automation selection exceeds size limit");
    }
    Ok(text.to_owned())
}

fn selected_text_uia() -> Result<String> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .context("initialize COM for UI Automation")?;
        let _uninitialize = ComUninitialize;
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                .context("create UI Automation client")?;
        let walker = automation
            .RawViewWalker()
            .context("create UI Automation tree walker")?;
        let mut element = automation
            .GetFocusedElement()
            .context("read focused UI Automation element")?;

        for _ in 0..MAX_PARENT_DEPTH {
            if element
                .CurrentIsPassword()
                .map(|value| value.as_bool())
                .unwrap_or(false)
            {
                bail!("selected text belongs to a protected password field");
            }
            if let Ok(pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
            {
                let text = read_text_pattern(&pattern)?;
                if !text.trim().is_empty() {
                    return Ok(text);
                }
            }
            if let Ok(child_pattern) =
                element.GetCurrentPatternAs::<IUIAutomationTextChildPattern>(UIA_TextChildPatternId)
            {
                if let Ok(container) = child_pattern.TextContainer() {
                    if container
                        .CurrentIsPassword()
                        .map(|value| value.as_bool())
                        .unwrap_or(false)
                    {
                        bail!("selected text belongs to a protected password field");
                    }
                    if let Ok(pattern) =
                        container.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    {
                        let text = read_text_pattern(&pattern)?;
                        if !text.trim().is_empty() {
                            return Ok(text);
                        }
                    }
                }
            }
            element = match walker.GetParentElement(&element) {
                Ok(parent) => parent,
                Err(_) => break,
            };
        }
        bail!("focused element does not expose a non-empty text selection")
    }
}

unsafe fn read_text_pattern(pattern: &IUIAutomationTextPattern) -> Result<String> {
    let ranges = pattern
        .GetSelection()
        .context("read UI Automation selection ranges")?;
    let length = ranges.Length().context("read UI Automation range count")?;
    let mut output = String::new();
    for index in 0..length.min(128) {
        let range = ranges
            .GetElement(index)
            .context("read UI Automation selection range")?;
        let remaining = MAX_SELECTION_CHARS.saturating_sub(output.chars().count());
        if remaining == 0 {
            bail!("UI Automation selection exceeds size limit");
        }
        let text = range
            .GetText(i32::try_from(remaining).unwrap_or(i32::MAX))
            .context("read UI Automation range text")?
            .to_string();
        output.push_str(&text);
    }
    Ok(output)
}

fn validate_token(token: &str) -> Result<()> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("invalid helper session token");
    }
    Ok(())
}

struct ComUninitialize;
impl Drop for ComUninitialize {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}
