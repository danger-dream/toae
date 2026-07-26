use anyhow::{bail, Context, Result};
use std::mem::size_of;
use std::ptr::copy_nonoverlapping;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{DeleteObject, HBITMAP, HGDIOBJ};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardSequenceNumber, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{
    GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE,
};
use windows::Win32::System::Ole::{CF_BITMAP, CF_DSPBITMAP, CF_UNICODETEXT};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL,
};
use windows::Win32::UI::WindowsAndMessaging::{CopyImage, IMAGE_BITMAP, LR_CREATEDIBSECTION};

const MAX_CLIPBOARD_BYTES: usize = 128 * 1024 * 1024;
const MAX_FORMATS: usize = 512;
const MAX_TEXT_UNITS: usize = 1_000_000;
const COPY_KEY: VIRTUAL_KEY = VIRTUAL_KEY(0x43);

pub struct ClipboardSelection {
    pub text: String,
    pub restored: bool,
}

enum SnapshotData {
    Global(Vec<u8>),
    Bitmap(HBITMAP),
}

struct SnapshotItem {
    format: u32,
    data: SnapshotData,
}

struct ClipboardSnapshot {
    items: Vec<SnapshotItem>,
}

impl Drop for ClipboardSnapshot {
    fn drop(&mut self) {
        for item in &mut self.items {
            if let SnapshotData::Bitmap(bitmap) = item.data {
                unsafe {
                    let _ = DeleteObject(HGDIOBJ(bitmap.0));
                }
                item.data = SnapshotData::Global(Vec::new());
            }
        }
    }
}

struct OpenClipboardGuard;
impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

pub fn copy_selected_text(deadline: Instant) -> Result<ClipboardSelection> {
    let snapshot = snapshot_clipboard(deadline)?;
    let sentinel = format!("TOAE-CLIPBOARD-SENTINEL-{}", Uuid::new_v4());
    let sentinel_sequence = set_sentinel(&sentinel, deadline)?;
    let _release = KeyReleaseGuard;
    send_ctrl_c()?;

    let mut copied_sequence = sentinel_sequence;
    let mut copied_text = None;
    while Instant::now() < deadline {
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if sequence != sentinel_sequence {
            copied_sequence = sequence;
            copied_text = read_unicode_text(deadline).ok();
            if copied_text
                .as_deref()
                .is_some_and(|value| value != sentinel)
            {
                break;
            }
        }
        thread::sleep(Duration::from_millis(15));
    }

    let expected_sequence = if copied_text.is_some() {
        copied_sequence
    } else {
        sentinel_sequence
    };
    let restored = restore_if_unchanged(&snapshot, expected_sequence, deadline)?;
    let text = copied_text
        .filter(|value| value != &sentinel)
        .unwrap_or_default();
    if text.trim().is_empty() {
        bail!("target application did not place selected Unicode text on the clipboard");
    }
    Ok(ClipboardSelection { text, restored })
}

fn snapshot_clipboard(deadline: Instant) -> Result<ClipboardSnapshot> {
    let _guard = open_clipboard(deadline)?;
    let mut items = Vec::new();
    let mut format = 0_u32;
    loop {
        format = unsafe { EnumClipboardFormats(format) };
        if format == 0 {
            break;
        }
        if items.len() >= MAX_FORMATS {
            bail!("clipboard contains too many formats to snapshot safely");
        }
        let handle = unsafe { GetClipboardData(format) }
            .with_context(|| format!("materialize clipboard format {format}"))?;
        if format == u32::from(CF_BITMAP.0) || format == u32::from(CF_DSPBITMAP.0) {
            let copy =
                unsafe { CopyImage(HANDLE(handle.0), IMAGE_BITMAP, 0, 0, LR_CREATEDIBSECTION) }?;
            if copy.is_invalid() {
                bail!("clipboard bitmap could not be copied safely");
            }
            items.push(SnapshotItem {
                format,
                data: SnapshotData::Bitmap(HBITMAP(copy.0)),
            });
            continue;
        }
        let global = HGLOBAL(handle.0 as *mut std::ffi::c_void);
        let bytes = copy_global(global).with_context(|| {
            format!("clipboard format {format} is not a safely materializable HGLOBAL")
        })?;
        items.push(SnapshotItem {
            format,
            data: SnapshotData::Global(bytes),
        });
    }
    Ok(ClipboardSnapshot { items })
}

fn copy_global(handle: HGLOBAL) -> Result<Vec<u8>> {
    let size = unsafe { GlobalSize(handle) };
    if size == 0 || size > MAX_CLIPBOARD_BYTES {
        bail!("clipboard allocation has an invalid size");
    }
    let pointer = unsafe { GlobalLock(handle) };
    if pointer.is_null() {
        bail!("clipboard allocation cannot be locked");
    }
    let bytes = unsafe { std::slice::from_raw_parts(pointer.cast::<u8>(), size) }.to_vec();
    unsafe {
        let _ = GlobalUnlock(handle);
    }
    Ok(bytes)
}

pub fn write_text(value: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(500);
    let _guard = open_clipboard(deadline)?;
    unsafe { EmptyClipboard() }.context("empty clipboard for overlay color")?;
    set_global_data(u32::from(CF_UNICODETEXT.0), &utf16_bytes(value))
}

fn set_sentinel(sentinel: &str, deadline: Instant) -> Result<u32> {
    let _guard = open_clipboard(deadline)?;
    unsafe { EmptyClipboard() }.context("empty clipboard for copy sentinel")?;
    set_global_data(u32::from(CF_UNICODETEXT.0), &utf16_bytes(sentinel))?;
    Ok(unsafe { GetClipboardSequenceNumber() })
}

fn read_unicode_text(deadline: Instant) -> Result<String> {
    let _guard = open_clipboard(deadline)?;
    let handle = unsafe { GetClipboardData(u32::from(CF_UNICODETEXT.0)) }
        .context("read copied Unicode text")?;
    let global = HGLOBAL(handle.0 as *mut std::ffi::c_void);
    let size = unsafe { GlobalSize(global) };
    if size < 2 || size > (MAX_TEXT_UNITS + 1) * 2 {
        bail!("copied Unicode text exceeds size limit");
    }
    let pointer = unsafe { GlobalLock(global) };
    if pointer.is_null() {
        bail!("copied Unicode text cannot be locked");
    }
    let units = unsafe { std::slice::from_raw_parts(pointer.cast::<u16>(), size / 2) };
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    let value = String::from_utf16(&units[..end]).context("copied text is invalid UTF-16")?;
    unsafe {
        let _ = GlobalUnlock(global);
    }
    Ok(value)
}

fn restore_if_unchanged(
    snapshot: &ClipboardSnapshot,
    expected_sequence: u32,
    deadline: Instant,
) -> Result<bool> {
    if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
        return Ok(false);
    }
    let _guard = open_clipboard(deadline)?;
    if unsafe { GetClipboardSequenceNumber() } != expected_sequence {
        return Ok(false);
    }
    unsafe { EmptyClipboard() }.context("empty clipboard before restore")?;
    for item in &snapshot.items {
        match &item.data {
            SnapshotData::Global(bytes) => set_global_data(item.format, bytes)?,
            SnapshotData::Bitmap(bitmap) => {
                let copy = unsafe {
                    CopyImage(HANDLE(bitmap.0), IMAGE_BITMAP, 0, 0, LR_CREATEDIBSECTION)
                }?;
                if copy.is_invalid() {
                    bail!("clipboard bitmap restore copy failed");
                }
                if let Err(error) = unsafe { SetClipboardData(item.format, copy) } {
                    unsafe {
                        let _ = DeleteObject(HGDIOBJ(copy.0));
                    }
                    return Err(error).context("restore clipboard bitmap");
                }
            }
        }
    }
    Ok(true)
}

fn set_global_data(format: u32, bytes: &[u8]) -> Result<()> {
    let allocation = unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) }?;
    let pointer = unsafe { GlobalLock(allocation) };
    if pointer.is_null() {
        unsafe {
            let _ = GlobalFree(allocation);
        }
        bail!("allocate clipboard restore buffer");
    }
    unsafe {
        copy_nonoverlapping(bytes.as_ptr(), pointer.cast::<u8>(), bytes.len());
        let _ = GlobalUnlock(allocation);
    }
    if let Err(error) = unsafe { SetClipboardData(format, HANDLE(allocation.0 as isize)) } {
        unsafe {
            let _ = GlobalFree(allocation);
        }
        return Err(error).context("publish clipboard format");
    }
    Ok(())
}

fn utf16_bytes(value: &str) -> Vec<u8> {
    let units: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut bytes = Vec::with_capacity(units.len() * 2);
    for unit in units {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    bytes
}

fn open_clipboard(deadline: Instant) -> Result<OpenClipboardGuard> {
    loop {
        if unsafe { OpenClipboard(HWND(0)) }.is_ok() {
            return Ok(OpenClipboardGuard);
        }
        if Instant::now() >= deadline {
            bail!("clipboard is busy");
        }
        thread::sleep(Duration::from_millis(10));
    }
}

struct KeyReleaseGuard;
impl Drop for KeyReleaseGuard {
    fn drop(&mut self) {
        let inputs = [
            keyboard_input(COPY_KEY, true),
            keyboard_input(VK_CONTROL, true),
        ];
        unsafe {
            let _ = SendInput(&inputs, size_of::<INPUT>() as i32);
        }
    }
}

fn send_ctrl_c() -> Result<()> {
    let inputs = [
        keyboard_input(VK_CONTROL, false),
        keyboard_input(COPY_KEY, false),
        keyboard_input(COPY_KEY, true),
        keyboard_input(VK_CONTROL, true),
    ];
    let inserted = unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) };
    if inserted != inputs.len() as u32 {
        bail!("Ctrl+C input was blocked by the target application or UIPI");
    }
    Ok(())
}

fn keyboard_input(key: VIRTUAL_KEY, key_up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if key_up {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sentinel_payload_is_nul_terminated_utf16() {
        assert_eq!(utf16_bytes("A"), [65, 0, 0, 0]);
    }
}
