use crate::overlay_editor::{EditorAction, EditorIntent, EditorState, GdiPlusSession, PixelSource};
use crate::protocol::{read_frame, Frame, FrameWriter, VERSION};
use anyhow::{bail, Context, Result};
use image::codecs::png::PngEncoder;
use image::{ColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::ffi::{c_void, OsString};
use std::io::BufReader;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use windows::core::{w, Error as WinError, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    COLORREF, HANDLE, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDIBSection, CreateFontW,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, FillRect, GdiAlphaBlend, GetDC,
    GetMonitorInfoW, GetStockObject, GetTextExtentPoint32W, InvalidateRect, MonitorFromPoint,
    PatBlt, RedrawWindow, ReleaseDC, RoundRect, SelectObject, SetBkMode, SetDCBrushColor,
    SetTextColor, UpdateWindow, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLACKNESS, BLENDFUNCTION,
    CAPTUREBLT, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DC_BRUSH, DEFAULT_CHARSET, DEFAULT_PITCH,
    DIB_RGB_COLORS, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER, FF_DONTCARE, HBITMAP,
    HBRUSH, HDC, HFONT, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST, NULL_PEN,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, RDW_INVALIDATE, RDW_UPDATENOW, SRCCOPY, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Controls::Dialogs::{
    CommDlgExtendedError, GetSaveFileNameW, OFN_NOCHANGEDIR, OFN_OVERWRITEPROMPT,
    OFN_PATHMUSTEXIST, OPENFILENAMEW,
};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, ReleaseCapture, SetCapture, SetFocus, UnregisterHotKey, MOD_NOREPEAT, VK_A,
    VK_BACK, VK_ESCAPE, VK_H, VK_K, VK_RETURN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, KillTimer, LoadCursorW, PostMessageW, PostQuitMessage, RegisterClassW,
    SetCursor, SetForegroundWindow, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    TranslateMessage, CREATESTRUCTW, CS_DBLCLKS, CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, HMENU,
    HWND_TOPMOST, IDC_ARROW, IDC_CROSS, IDC_HAND, IDC_SIZEALL, IDC_SIZENESW, IDC_SIZENS,
    IDC_SIZENWSE, IDC_SIZEWE, MSG, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SW_HIDE, SW_SHOW, WM_APP,
    WM_CHAR, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND, WM_HOTKEY, WM_KEYDOWN, WM_LBUTTONDBLCLK,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCCREATE, WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR,
    WM_TIMER, WNDCLASSW, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP,
};

const OVERLAY_START: u32 = WM_APP + 1;
const OVERLAY_SHUTDOWN: u32 = WM_APP + 2;
const OVERLAY_CONTINUE: u32 = WM_APP + 3;
const MAX_CAPTURE_PIXELS: usize = 100_000_000;
const MIN_SELECTION_SIZE: i32 = 15;
const HANDLE_SIZE: i32 = 8;
const MAG_GRID: i32 = 15;
const MAG_CELL: i32 = 10;
const MAG_COLOR_HEIGHT: i32 = 32;
const MAG_GAP: i32 = 16;
const PANEL_RADIUS: i32 = 8;
const MASK_ALPHA: u8 = 136;
const HOTKEY_ESCAPE: i32 = 0x544F_0001;
const HOTKEY_A: i32 = 0x544F_0002;
const HOTKEY_H: i32 = 0x544F_0003;
const HOTKEY_K: i32 = 0x544F_0004;
const DEADLINE_TIMER: usize = 0x544F_1001;
const ANIMATION_TIMER: usize = 0x544F_1002;

#[derive(Debug, Clone, Copy, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl PixelRect {
    pub(crate) fn right(self) -> i32 {
        self.x.saturating_add(self.width)
    }

    pub(crate) fn bottom(self) -> i32 {
        self.y.saturating_add(self.height)
    }

    pub(crate) fn contains(self, point: POINT) -> bool {
        point.x >= self.x && point.y >= self.y && point.x < self.right() && point.y < self.bottom()
    }

    fn is_full(self, width: i32, height: i32) -> bool {
        self.x == 0 && self.y == 0 && self.width == width && self.height == height
    }

    pub(crate) fn normalized(self, width: i32, height: i32) -> Self {
        let x0 = self.x.min(self.right()).clamp(0, width);
        let y0 = self.y.min(self.bottom()).clamp(0, height);
        let x1 = self.x.max(self.right()).clamp(0, width);
        let y1 = self.y.max(self.bottom()).clamp(0, height);
        Self {
            x: x0,
            y: y0,
            width: (x1 - x0).max(0),
            height: (y1 - y0).max(0),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCommand {
    v: u64,
    id: String,
    #[serde(rename = "type")]
    command_type: String,
    deadline_ms: u64,
    #[serde(default)]
    payload: Map<String, Value>,
}

struct OverlayCommand {
    id: String,
    action: String,
    deadline_ms: u64,
    editor: bool,
}

struct OverlayContinueCommand {
    id: String,
    session_id: String,
    deadline_ms: u64,
    translated_png: Option<Vec<u8>>,
    translation_error: Option<String>,
}

struct ActiveSession {
    response_id: String,
    session_id: String,
    action: String,
    started_at: Instant,
    deadline: Instant,
    response_open: bool,
    cancelled_while_waiting: bool,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Hit {
    Select,
    Move,
    North,
    South,
    West,
    East,
    NorthWest,
    NorthEast,
    SouthWest,
    SouthEast,
}

#[derive(Clone, Copy)]
struct Drag {
    hit: Hit,
    origin: POINT,
    original: PixelRect,
}

struct Cursors {
    arrow: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    hand: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    cross: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    all: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    ns: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    we: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    nwse: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
    nesw: windows::Win32::UI::WindowsAndMessaging::HCURSOR,
}

impl Cursors {
    fn load() -> Result<Self> {
        unsafe {
            Ok(Self {
                arrow: LoadCursorW(None, IDC_ARROW)?,
                hand: LoadCursorW(None, IDC_HAND)?,
                cross: LoadCursorW(None, IDC_CROSS)?,
                all: LoadCursorW(None, IDC_SIZEALL)?,
                ns: LoadCursorW(None, IDC_SIZENS)?,
                we: LoadCursorW(None, IDC_SIZEWE)?,
                nwse: LoadCursorW(None, IDC_SIZENWSE)?,
                nesw: LoadCursorW(None, IDC_SIZENESW)?,
            })
        }
    }

    fn for_hit(&self, hit: Hit, full: bool) -> windows::Win32::UI::WindowsAndMessaging::HCURSOR {
        if full {
            return self.all;
        }
        match hit {
            Hit::Move => self.all,
            Hit::North | Hit::South => self.ns,
            Hit::West | Hit::East => self.we,
            Hit::NorthWest | Hit::SouthEast => self.nwse,
            Hit::NorthEast | Hit::SouthWest => self.nesw,
            Hit::Select => self.cross,
        }
    }
}

struct TranslationOverlay {
    rect: PixelRect,
    bgra: Vec<u8>,
}

struct Surface {
    bounds: RECT,
    width: i32,
    height: i32,
    capture_dc: HDC,
    capture_bitmap: HBITMAP,
    capture_previous: HGDIOBJ,
    capture_bits: *mut u8,
    back_dc: HDC,
    back_bitmap: HBITMAP,
    back_previous: HGDIOBJ,
    back_bits: *mut u8,
    back_previous_font: HGDIOBJ,
    back_previous_pen: HGDIOBJ,
    shade_dc: HDC,
    shade_bitmap: HBITMAP,
    shade_previous: HGDIOBJ,
    font: HFONT,
    panel_brush: HBRUSH,
    shadow_brush: HBRUSH,
    translation: Option<TranslationOverlay>,
}

impl Surface {
    fn create(bounds: RECT) -> Result<Self> {
        let width = bounds
            .right
            .checked_sub(bounds.left)
            .context("overlay monitor width overflow")?;
        let height = bounds
            .bottom
            .checked_sub(bounds.top)
            .context("overlay monitor height overflow")?;
        checked_pixel_count(width, height)?;

        unsafe {
            let screen_dc = GetDC(HWND(0));
            if screen_dc.is_invalid() {
                bail!("overlay GetDC failed");
            }

            let created = (|| -> Result<Self> {
                let capture_dc = CreateCompatibleDC(screen_dc);
                let back_dc = CreateCompatibleDC(screen_dc);
                let shade_dc = CreateCompatibleDC(screen_dc);
                if capture_dc.is_invalid() || back_dc.is_invalid() || shade_dc.is_invalid() {
                    if !capture_dc.is_invalid() {
                        let _ = DeleteDC(capture_dc);
                    }
                    if !back_dc.is_invalid() {
                        let _ = DeleteDC(back_dc);
                    }
                    if !shade_dc.is_invalid() {
                        let _ = DeleteDC(shade_dc);
                    }
                    bail!("overlay CreateCompatibleDC failed");
                }

                let mut info = BITMAPINFO::default();
                info.bmiHeader = BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width,
                    biHeight: -height,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                };
                let mut capture_bits: *mut c_void = null_mut();
                let capture_bitmap = match CreateDIBSection(
                    screen_dc,
                    &info,
                    DIB_RGB_COLORS,
                    &mut capture_bits,
                    HANDLE(0),
                    0,
                ) {
                    Ok(bitmap) => bitmap,
                    Err(error) => {
                        let _ = DeleteDC(capture_dc);
                        let _ = DeleteDC(back_dc);
                        let _ = DeleteDC(shade_dc);
                        return Err(error).context("create overlay capture DIB");
                    }
                };
                if capture_bits.is_null() {
                    let _ = DeleteObject(HGDIOBJ(capture_bitmap.0));
                    let _ = DeleteDC(capture_dc);
                    let _ = DeleteDC(back_dc);
                    let _ = DeleteDC(shade_dc);
                    bail!("overlay capture DIB returned no pixel buffer");
                }

                let mut back_bits: *mut c_void = null_mut();
                let back_bitmap = match CreateDIBSection(
                    screen_dc,
                    &info,
                    DIB_RGB_COLORS,
                    &mut back_bits,
                    HANDLE(0),
                    0,
                ) {
                    Ok(bitmap) => bitmap,
                    Err(error) => {
                        let _ = DeleteObject(HGDIOBJ(capture_bitmap.0));
                        let _ = DeleteDC(capture_dc);
                        let _ = DeleteDC(back_dc);
                        let _ = DeleteDC(shade_dc);
                        return Err(error).context("create overlay back-buffer DIB");
                    }
                };
                let shade_bitmap = CreateCompatibleBitmap(screen_dc, 1, 1);
                if back_bits.is_null() || shade_bitmap.is_invalid() {
                    let _ = DeleteObject(HGDIOBJ(capture_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(back_bitmap.0));
                    if !shade_bitmap.is_invalid() {
                        let _ = DeleteObject(HGDIOBJ(shade_bitmap.0));
                    }
                    let _ = DeleteDC(capture_dc);
                    let _ = DeleteDC(back_dc);
                    let _ = DeleteDC(shade_dc);
                    bail!("create overlay render bitmap failed");
                }

                let capture_previous = SelectObject(capture_dc, HGDIOBJ(capture_bitmap.0));
                let back_previous = SelectObject(back_dc, HGDIOBJ(back_bitmap.0));
                let shade_previous = SelectObject(shade_dc, HGDIOBJ(shade_bitmap.0));
                if capture_previous.0 == 0
                    || capture_previous.0 == -1
                    || back_previous.0 == 0
                    || back_previous.0 == -1
                    || shade_previous.0 == 0
                    || shade_previous.0 == -1
                {
                    let _ = SelectObject(capture_dc, capture_previous);
                    let _ = SelectObject(back_dc, back_previous);
                    let _ = SelectObject(shade_dc, shade_previous);
                    let _ = DeleteObject(HGDIOBJ(capture_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(back_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(shade_bitmap.0));
                    let _ = DeleteDC(capture_dc);
                    let _ = DeleteDC(back_dc);
                    let _ = DeleteDC(shade_dc);
                    bail!("select overlay render bitmap failed");
                }
                let _ = PatBlt(shade_dc, 0, 0, 1, 1, BLACKNESS);

                let font = CreateFontW(
                    -16,
                    0,
                    0,
                    0,
                    400,
                    0,
                    0,
                    0,
                    DEFAULT_CHARSET.0 as u32,
                    OUT_DEFAULT_PRECIS.0 as u32,
                    CLIP_DEFAULT_PRECIS.0 as u32,
                    CLEARTYPE_QUALITY.0 as u32,
                    (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
                    w!("Segoe UI"),
                );
                if font.is_invalid() {
                    let _ = SelectObject(capture_dc, capture_previous);
                    let _ = SelectObject(back_dc, back_previous);
                    let _ = SelectObject(shade_dc, shade_previous);
                    let _ = DeleteObject(HGDIOBJ(capture_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(back_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(shade_bitmap.0));
                    let _ = DeleteDC(capture_dc);
                    let _ = DeleteDC(back_dc);
                    let _ = DeleteDC(shade_dc);
                    bail!("create overlay font failed");
                }
                let back_previous_font = SelectObject(back_dc, HGDIOBJ(font.0));
                let null_pen = GetStockObject(NULL_PEN);
                let back_previous_pen = SelectObject(back_dc, null_pen);
                let panel_brush = CreateSolidBrush(color(235, 235, 235));
                let shadow_brush = CreateSolidBrush(color(35, 35, 35));
                if panel_brush.is_invalid() || shadow_brush.is_invalid() {
                    let _ = SelectObject(back_dc, back_previous_pen);
                    let _ = SelectObject(back_dc, back_previous_font);
                    let _ = DeleteObject(HGDIOBJ(font.0));
                    if !panel_brush.is_invalid() {
                        let _ = DeleteObject(HGDIOBJ(panel_brush.0));
                    }
                    if !shadow_brush.is_invalid() {
                        let _ = DeleteObject(HGDIOBJ(shadow_brush.0));
                    }
                    let _ = SelectObject(capture_dc, capture_previous);
                    let _ = SelectObject(back_dc, back_previous);
                    let _ = SelectObject(shade_dc, shade_previous);
                    let _ = DeleteObject(HGDIOBJ(capture_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(back_bitmap.0));
                    let _ = DeleteObject(HGDIOBJ(shade_bitmap.0));
                    let _ = DeleteDC(capture_dc);
                    let _ = DeleteDC(back_dc);
                    let _ = DeleteDC(shade_dc);
                    bail!("create overlay brushes failed");
                }

                Ok(Self {
                    bounds,
                    width,
                    height,
                    capture_dc,
                    capture_bitmap,
                    capture_previous,
                    capture_bits: capture_bits.cast(),
                    back_dc,
                    back_bitmap,
                    back_previous,
                    back_bits: back_bits.cast(),
                    back_previous_font,
                    back_previous_pen,
                    shade_dc,
                    shade_bitmap,
                    shade_previous,
                    font,
                    panel_brush,
                    shadow_brush,
                    translation: None,
                })
            })();
            let _ = ReleaseDC(HWND(0), screen_dc);
            created
        }
    }

    fn same_size(&self, bounds: RECT) -> bool {
        bounds.right - bounds.left == self.width && bounds.bottom - bounds.top == self.height
    }

    fn capture(&mut self, bounds: RECT) -> Result<()> {
        if !self.same_size(bounds) {
            bail!("overlay surface size changed unexpectedly");
        }
        self.bounds = bounds;
        unsafe {
            let screen_dc = GetDC(HWND(0));
            if screen_dc.is_invalid() {
                bail!("overlay GetDC failed");
            }
            let copied = BitBlt(
                self.capture_dc,
                0,
                0,
                self.width,
                self.height,
                screen_dc,
                bounds.left,
                bounds.top,
                SRCCOPY | CAPTUREBLT,
            )
            .is_ok();
            let _ = ReleaseDC(HWND(0), screen_dc);
            if !copied {
                bail!("overlay BitBlt failed");
            }
        }
        Ok(())
    }

    fn pixel(&self, x: i32, y: i32) -> [u8; 3] {
        if x < 0 || y < 0 || x >= self.width || y >= self.height {
            return [0, 0, 0];
        }
        let offset = ((y as usize * self.width as usize) + x as usize) * 4;
        unsafe {
            let source = std::slice::from_raw_parts(
                self.capture_bits,
                self.width as usize * self.height as usize * 4,
            );
            [source[offset + 2], source[offset + 1], source[offset]]
        }
    }

    fn crop_png(&self, rect: PixelRect) -> Result<Vec<u8>> {
        self.crop_buffer_png(self.capture_bits, rect)
    }

    fn crop_back_png(&self, rect: PixelRect) -> Result<Vec<u8>> {
        self.crop_buffer_png(self.back_bits, rect)
    }

    fn reset_back_buffer(&self) -> Result<()> {
        unsafe {
            BitBlt(
                self.back_dc,
                0,
                0,
                self.width,
                self.height,
                self.capture_dc,
                0,
                0,
                SRCCOPY,
            )
            .context("copy native overlay edit buffer")?;
        }
        Ok(())
    }

    fn set_translation_png(&mut self, png: &[u8], rect: PixelRect) -> Result<()> {
        let rect = rect.normalized(self.width, self.height);
        if rect.width < 1 || rect.height < 1 {
            bail!("translated overlay selection is empty");
        }
        let rgba = image::load_from_memory(png)
            .context("decode translated overlay PNG")?
            .to_rgba8();
        if rgba.width() != rect.width as u32 || rgba.height() != rect.height as u32 {
            bail!("translated overlay dimensions do not match the selection");
        }
        let source = rgba.into_raw();
        let mut bgra = vec![0_u8; source.len()];
        for (source_pixel, target_pixel) in source.chunks_exact(4).zip(bgra.chunks_exact_mut(4)) {
            target_pixel[0] = source_pixel[2];
            target_pixel[1] = source_pixel[1];
            target_pixel[2] = source_pixel[0];
            target_pixel[3] = source_pixel[3];
        }
        self.translation = Some(TranslationOverlay { rect, bgra });
        Ok(())
    }

    fn clear_translation(&mut self) {
        self.translation = None;
    }

    fn apply_translation(&self) {
        let Some(translation) = &self.translation else {
            return;
        };
        if self.back_bits.is_null() {
            return;
        }
        let target = unsafe {
            std::slice::from_raw_parts_mut(
                self.back_bits,
                self.width as usize * self.height as usize * 4,
            )
        };
        let row_bytes = translation.rect.width as usize * 4;
        for row in 0..translation.rect.height as usize {
            let source_start = row * row_bytes;
            let target_start = ((translation.rect.y as usize + row) * self.width as usize
                + translation.rect.x as usize)
                * 4;
            target[target_start..target_start + row_bytes]
                .copy_from_slice(&translation.bgra[source_start..source_start + row_bytes]);
        }
    }

    fn pixel_source(&self) -> PixelSource {
        PixelSource {
            bits: self.capture_bits,
            width: self.width,
            height: self.height,
        }
    }

    fn crop_buffer_png(&self, bits: *const u8, rect: PixelRect) -> Result<Vec<u8>> {
        let rect = rect.normalized(self.width, self.height);
        if rect.width < 1 || rect.height < 1 {
            bail!("overlay selection is empty");
        }
        if bits.is_null() {
            bail!("overlay pixel buffer is unavailable");
        }
        let pixels = checked_pixel_count(rect.width, rect.height)?;
        let source = unsafe {
            std::slice::from_raw_parts(bits, self.width as usize * self.height as usize * 4)
        };
        let mut rgba = vec![0_u8; pixels * 4];
        for row in 0..rect.height as usize {
            let source_row =
                (rect.y as usize + row) * self.width as usize * 4 + rect.x as usize * 4;
            let target_row = row * rect.width as usize * 4;
            for column in 0..rect.width as usize {
                let source_offset = source_row + column * 4;
                let target_offset = target_row + column * 4;
                rgba[target_offset] = source[source_offset + 2];
                rgba[target_offset + 1] = source[source_offset + 1];
                rgba[target_offset + 2] = source[source_offset];
                rgba[target_offset + 3] = 255;
            }
        }
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(
                &rgba,
                rect.width as u32,
                rect.height as u32,
                ColorType::Rgba8.into(),
            )
            .context("encode native overlay selection")?;
        Ok(png)
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            let _ = SelectObject(self.back_dc, self.back_previous_pen);
            let _ = SelectObject(self.back_dc, self.back_previous_font);
            let _ = SelectObject(self.capture_dc, self.capture_previous);
            let _ = SelectObject(self.back_dc, self.back_previous);
            let _ = SelectObject(self.shade_dc, self.shade_previous);
            let _ = DeleteObject(HGDIOBJ(self.panel_brush.0));
            let _ = DeleteObject(HGDIOBJ(self.shadow_brush.0));
            let _ = DeleteObject(HGDIOBJ(self.font.0));
            let _ = DeleteObject(HGDIOBJ(self.capture_bitmap.0));
            let _ = DeleteObject(HGDIOBJ(self.back_bitmap.0));
            let _ = DeleteObject(HGDIOBJ(self.shade_bitmap.0));
            let _ = DeleteDC(self.capture_dc);
            let _ = DeleteDC(self.back_dc);
            let _ = DeleteDC(self.shade_dc);
        }
    }
}

struct OverlayState {
    hwnd: HWND,
    writer: Arc<FrameWriter<std::io::Stdout>>,
    surface: Option<Surface>,
    active: Option<ActiveSession>,
    selection: PixelRect,
    selection_ready: bool,
    mouse: POINT,
    drag: Option<Drag>,
    editing_size: bool,
    size_replace_on_type: bool,
    size_text: String,
    size_panel: RECT,
    color_hex: String,
    editor: EditorState,
    cursors: Cursors,
}

impl OverlayState {
    fn new(writer: Arc<FrameWriter<std::io::Stdout>>) -> Result<Self> {
        Ok(Self {
            hwnd: HWND(0),
            writer,
            surface: None,
            active: None,
            selection: PixelRect::default(),
            selection_ready: false,
            mouse: POINT::default(),
            drag: None,
            editing_size: false,
            size_replace_on_type: false,
            size_text: String::new(),
            size_panel: RECT::default(),
            color_hex: "#000000".to_owned(),
            editor: EditorState::default(),
            cursors: Cursors::load()?,
        })
    }

    fn start(&mut self, command: OverlayCommand) {
        if self.active.is_some() {
            self.abandon_active();
        }
        let started_at = Instant::now();
        let result = self.prepare_capture(&command);
        if let Err(error) = result {
            let _ = self.send_error(&command.id, "capture_overlay_failed", &format!("{error:#}"));
            eprintln!("native-helper: overlay start failed: {error:#}");
            return;
        }
        let deadline_ms = command.deadline_ms.clamp(1_000, 180_000);
        self.active = Some(ActiveSession {
            response_id: command.id.clone(),
            session_id: command.id,
            action: command.action,
            started_at,
            deadline: started_at + Duration::from_millis(deadline_ms),
            response_open: true,
            cancelled_while_waiting: false,
        });
        if let Err(error) = self.register_hotkeys() {
            self.fail_active(&format!(
                "register native overlay hotkeys failed: {error:#}"
            ));
            return;
        }
        if unsafe { SetTimer(self.hwnd, DEADLINE_TIMER, 1_000, None) } == 0
            || unsafe { SetTimer(self.hwnd, ANIMATION_TIMER, 50, None) } == 0
        {
            self.fail_active("start native overlay timers failed");
            return;
        }
        if let Err(error) = self.render() {
            self.fail_active(&format!("render native capture overlay failed: {error:#}"));
            return;
        }
        unsafe {
            let surface = self.surface.as_ref().expect("surface exists after capture");
            if SetWindowPos(
                self.hwnd,
                HWND_TOPMOST,
                surface.bounds.left,
                surface.bounds.top,
                surface.width,
                surface.height,
                SWP_NOACTIVATE | SWP_NOOWNERZORDER,
            )
            .is_err()
            {
                self.fail_active("position native capture overlay failed");
                return;
            }
            let _ = RedrawWindow(
                self.hwnd,
                None,
                windows::Win32::Graphics::Gdi::HRGN(0),
                RDW_INVALIDATE | RDW_UPDATENOW,
            );
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            let _ = SetForegroundWindow(self.hwnd);
            let _ = SetFocus(self.hwnd);
            let _ = RedrawWindow(
                self.hwnd,
                None,
                windows::Win32::Graphics::Gdi::HRGN(0),
                RDW_INVALIDATE | RDW_UPDATENOW,
            );
        }
        eprintln!(
            "native-helper: overlay stage=visible elapsedMs={}",
            started_at.elapsed().as_millis()
        );
    }

    fn prepare_capture(&mut self, command: &OverlayCommand) -> Result<()> {
        if command.action != "screenshot_translate" && command.action != "screenshot_recognizer" {
            bail!("overlay capture action is invalid");
        }
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
            let _ = ReleaseCapture();
        }
        let bounds = monitor_at_cursor()?;
        if self
            .surface
            .as_ref()
            .is_none_or(|surface| !surface.same_size(bounds))
        {
            self.surface = Some(Surface::create(bounds)?);
        }
        let capture_started = Instant::now();
        self.surface
            .as_mut()
            .expect("surface created")
            .capture(bounds)?;
        eprintln!(
            "native-helper: overlay stage=captured elapsedMs={}",
            capture_started.elapsed().as_millis()
        );
        let surface = self.surface.as_ref().expect("surface created");
        let mut cursor = POINT::default();
        unsafe { GetCursorPos(&mut cursor).context("read cursor for native overlay")? };
        self.mouse = POINT {
            x: (cursor.x - bounds.left).clamp(0, surface.width.saturating_sub(1)),
            y: (cursor.y - bounds.top).clamp(0, surface.height.saturating_sub(1)),
        };
        self.selection = PixelRect {
            x: 0,
            y: 0,
            width: surface.width,
            height: surface.height,
        };
        self.selection_ready = false;
        self.drag = None;
        self.editing_size = false;
        self.size_replace_on_type = false;
        self.size_text = dimensions_text(self.selection);
        self.color_hex = "#000000".to_owned();
        self.editor.reset(command.editor);
        self.surface
            .as_mut()
            .expect("surface created")
            .clear_translation();
        Ok(())
    }

    fn abandon_active(&mut self) {
        self.active = None;
        self.cleanup_interaction();
        self.editor.clear_translation();
        if let Some(surface) = self.surface.as_mut() {
            surface.clear_translation();
        }
    }

    fn cleanup_interaction(&mut self) {
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_HIDE);
            let _ = ReleaseCapture();
            let _ = KillTimer(self.hwnd, DEADLINE_TIMER);
            let _ = KillTimer(self.hwnd, ANIMATION_TIMER);
        }
        self.unregister_hotkeys();
        self.drag = None;
        self.editing_size = false;
        self.size_replace_on_type = false;
    }

    fn cancel(&mut self) {
        let Some(response_open) = self.active.as_ref().map(|session| session.response_open) else {
            self.cleanup_interaction();
            return;
        };
        if !response_open {
            if let Some(session) = self.active.as_mut() {
                session.cancelled_while_waiting = true;
            }
            self.cleanup_interaction();
            return;
        }
        let session = self.active.take().expect("active overlay session");
        self.cleanup_interaction();
        let _ = self.writer.json(&json!({
            "v": VERSION,
            "id": session.response_id,
            "ok": true,
            "result": {
                "cancelled": true,
                "binary": false,
                "action": session.action,
                "editorSessionId": session.session_id,
                "elapsedMs": session.started_at.elapsed().as_millis()
            }
        }));
        eprintln!(
            "native-helper: overlay stage=cancelled elapsedMs={}",
            session.started_at.elapsed().as_millis()
        );
    }

    fn continue_editor(&mut self, command: OverlayContinueCommand) {
        let Some(session) = self.active.as_mut() else {
            let _ = self.send_error(
                &command.id,
                "capture_editor_session_missing",
                "native screenshot editor session no longer exists",
            );
            return;
        };
        if session.session_id != command.session_id || session.response_open {
            let _ = self.send_error(
                &command.id,
                "capture_editor_session_mismatch",
                "native screenshot editor continuation does not match the active session",
            );
            return;
        }
        session.response_id = command.id;
        session.response_open = true;
        session.deadline =
            Instant::now() + Duration::from_millis(command.deadline_ms.clamp(1_000, 180_000));
        if session.cancelled_while_waiting {
            self.cancel();
            return;
        }
        let result = if let Some(png) = command.translated_png {
            self.surface
                .as_mut()
                .context("overlay surface is unavailable")
                .and_then(|surface| surface.set_translation_png(&png, self.selection))
                .map(|_| self.editor.translation_finished())
        } else {
            if let Some(surface) = self.surface.as_mut() {
                surface.clear_translation();
            }
            self.editor.translation_failed();
            if let Some(message) = command.translation_error {
                eprintln!(
                    "native-helper: overlay image translation failed: {}",
                    message.chars().take(500).collect::<String>()
                );
            }
            Ok(())
        };
        if let Err(error) = result {
            if let Some(surface) = self.surface.as_mut() {
                surface.clear_translation();
            }
            self.editor.translation_failed();
            eprintln!("native-helper: apply translated overlay failed: {error:#}");
        }
        unsafe {
            let _ = ShowWindow(self.hwnd, SW_SHOW);
            let _ = SetForegroundWindow(self.hwnd);
            let _ = SetFocus(self.hwnd);
        }
        let _ = self.render();
    }

    fn request_translation(&mut self) {
        let Some(session) = self.active.as_ref() else {
            return;
        };
        if !session.response_open || !self.editor.translation_loading() || !self.selection_ready {
            return;
        }
        let response_id = session.response_id.clone();
        let session_id = session.session_id.clone();
        let action = session.action.clone();
        let started_at = session.started_at;
        let selection = self.selection;
        let encoded_at = Instant::now();
        let result = self
            .surface
            .as_ref()
            .context("overlay surface is unavailable")
            .and_then(|surface| Ok((surface.bounds, surface.crop_png(selection)?)));
        match result {
            Ok((bounds, png)) => {
                let metadata = self.writer.json(&json!({
                    "v": VERSION,
                    "id": response_id,
                    "ok": true,
                    "result": {
                        "cancelled": false,
                        "binary": true,
                        "action": action,
                        "intent": "translate",
                        "editorSessionId": session_id,
                        "mime": "image/png",
                        "width": selection.width,
                        "height": selection.height,
                        "roiPhysical": selection,
                        "physicalBounds": {
                            "x": bounds.left,
                            "y": bounds.top,
                            "width": bounds.right - bounds.left,
                            "height": bounds.bottom - bounds.top
                        },
                        "encodeElapsedMs": encoded_at.elapsed().as_millis(),
                        "elapsedMs": started_at.elapsed().as_millis()
                    }
                }));
                let binary = metadata.and_then(|_| self.writer.binary(&response_id, &png));
                if binary.is_ok() {
                    if let Some(session) = self.active.as_mut() {
                        session.response_open = false;
                    }
                    eprintln!(
                        "native-helper: overlay stage=translation-requested roi={}x{} encodeMs={}",
                        selection.width,
                        selection.height,
                        encoded_at.elapsed().as_millis()
                    );
                } else {
                    self.fail_active("send translated overlay request failed");
                }
            }
            Err(error) => {
                self.editor.translation_failed();
                let _ = self.send_error(
                    &response_id,
                    "capture_overlay_encode_failed",
                    &format!("{error:#}"),
                );
                self.abandon_active();
            }
        }
    }

    fn confirm(&mut self) {
        self.finish(None);
    }

    fn finish_editor(&mut self, intent: EditorIntent) {
        if intent == EditorIntent::Save {
            self.save_editor();
        } else {
            self.finish(Some(intent));
        }
    }

    fn compose_png(&mut self) -> Result<(RECT, Vec<u8>)> {
        let selection = self.selection;
        let surface = self
            .surface
            .as_ref()
            .context("overlay surface is unavailable")?;
        if self.editor.enabled() {
            surface.reset_back_buffer()?;
            surface.apply_translation();
            unsafe {
                self.editor
                    .draw_annotations(surface.back_dc, surface.pixel_source());
            }
            Ok((surface.bounds, surface.crop_back_png(selection)?))
        } else {
            Ok((surface.bounds, surface.crop_png(selection)?))
        }
    }

    fn save_editor(&mut self) {
        if self
            .active
            .as_ref()
            .is_none_or(|session| !session.response_open)
        {
            return;
        }
        self.editor.prepare_output();
        let png = match self.compose_png() {
            Ok((_, png)) => png,
            Err(error) => {
                self.fail_active(&format!("prepare screenshot for saving failed: {error:#}"));
                return;
            }
        };
        // The overlay owns a global Escape hotkey while active. Release those
        // hotkeys while the owned save dialog runs so Esc is handled by the
        // dialog instead of being diverted back to the hidden owner window.
        self.unregister_hotkeys();
        let saved = match save_png_with_native_dialog(self.hwnd, &png) {
            Ok(saved) => saved,
            Err(error) => {
                eprintln!("native-helper: save screenshot failed: {error:#}");
                if let Err(register_error) = self.register_hotkeys() {
                    self.fail_active(&format!(
                        "restore overlay hotkeys after save failure failed: {register_error:#}"
                    ));
                    return;
                }
                let _ = self.render();
                return;
            }
        };
        if !saved {
            if let Err(error) = self.register_hotkeys() {
                self.fail_active(&format!(
                    "restore overlay hotkeys after save cancellation failed: {error:#}"
                ));
                return;
            }
            unsafe {
                let _ = SetForegroundWindow(self.hwnd);
                let _ = SetFocus(self.hwnd);
            }
            let _ = self.render();
            return;
        }
        let session = self.active.take().expect("active overlay session");
        self.cleanup_interaction();
        let _ = self.writer.json(&json!({
            "v": VERSION,
            "id": session.response_id,
            "ok": true,
            "result": {
                "cancelled": false,
                "binary": false,
                "action": session.action,
                "intent": "saved",
                "editorSessionId": session.session_id,
                "annotations": self.editor.annotation_count(),
                "elapsedMs": session.started_at.elapsed().as_millis()
            }
        }));
    }

    fn finish(&mut self, intent: Option<EditorIntent>) {
        if self
            .active
            .as_ref()
            .is_none_or(|session| !session.response_open)
        {
            return;
        }
        self.editor.prepare_output();
        let selection = self.selection;
        let annotation_count = self.editor.annotation_count();
        let output_intent = intent.map(EditorIntent::as_str).unwrap_or("confirm");
        let encoded_at = Instant::now();
        let result = self.compose_png();
        let session = self.active.take().expect("active overlay session");
        self.cleanup_interaction();
        match result {
            Ok((bounds, png)) => {
                let _ = self.writer.json(&json!({
                    "v": VERSION,
                    "id": session.response_id,
                    "ok": true,
                    "result": {
                        "cancelled": false,
                        "binary": true,
                        "action": session.action,
                        "intent": output_intent,
                        "editorSessionId": session.session_id,
                        "annotations": annotation_count,
                        "mime": "image/png",
                        "width": selection.width,
                        "height": selection.height,
                        "roiPhysical": selection,
                        "physicalBounds": {
                            "x": bounds.left,
                            "y": bounds.top,
                            "width": bounds.right - bounds.left,
                            "height": bounds.bottom - bounds.top
                        },
                        "encodeElapsedMs": encoded_at.elapsed().as_millis(),
                        "elapsedMs": session.started_at.elapsed().as_millis()
                    }
                }));
                let _ = self.writer.binary(&session.response_id, &png);
                eprintln!(
                    "native-helper: overlay stage=confirmed intent={} roi={}x{} annotations={} translated={} encodeMs={} totalMs={}",
                    output_intent,
                    selection.width,
                    selection.height,
                    annotation_count,
                    self.editor.translation_applied(),
                    encoded_at.elapsed().as_millis(),
                    session.started_at.elapsed().as_millis()
                );
            }
            Err(error) => {
                let _ = self.send_error(
                    &session.response_id,
                    "capture_overlay_encode_failed",
                    &format!("{error:#}"),
                );
            }
        }
    }

    fn fail_active(&mut self, message: &str) {
        if let Some(session) = self.active.take() {
            self.cleanup_interaction();
            if session.response_open {
                let _ = self.send_error(&session.response_id, "capture_overlay_failed", message);
            }
        }
    }

    fn send_error(&self, id: &str, code: &str, message: &str) -> Result<()> {
        self.writer.json(&json!({
            "v": VERSION,
            "id": id,
            "ok": false,
            "error": {
                "code": code,
                "message": message.chars().take(500).collect::<String>()
            }
        }))
    }

    fn render(&mut self) -> Result<()> {
        let Some(surface) = self.surface.as_ref() else {
            return Ok(());
        };
        surface.reset_back_buffer()?;
        surface.apply_translation();
        unsafe {
            self.editor
                .draw_annotations(surface.back_dc, surface.pixel_source());
            draw_mask(surface, self.selection);
            if self.editor.enabled() && (self.selection_ready || self.drag.is_some()) {
                draw_selection_frame(surface, self.selection, self.selection_ready);
            }
            if !self.editor.enabled() || self.selection_ready || self.drag.is_some() {
                let dimensions = dimensions_text(self.selection);
                let size_value = if self.editing_size {
                    self.size_text.as_str()
                } else {
                    dimensions.as_str()
                };
                self.size_panel =
                    draw_size_panel(surface, self.selection, size_value, self.editing_size);
            } else {
                self.size_panel = RECT::default();
            }
            if self.editor.show_magnifier(self.mouse) {
                self.color_hex = draw_magnifier(surface, self.selection, self.mouse);
            }
            self.editor.draw_chrome(
                surface.back_dc,
                self.selection,
                surface.width,
                surface.height,
            );
            let _ = InvalidateRect(self.hwnd, None, false);
            let _ = UpdateWindow(self.hwnd);
        }
        Ok(())
    }

    fn paint(&self) {
        let Some(surface) = self.surface.as_ref() else {
            return;
        };
        unsafe {
            let mut paint = PAINTSTRUCT::default();
            let dc = BeginPaint(self.hwnd, &mut paint);
            if !dc.is_invalid() {
                let _ = BitBlt(
                    dc,
                    0,
                    0,
                    surface.width,
                    surface.height,
                    surface.back_dc,
                    0,
                    0,
                    SRCCOPY,
                );
            }
            let _ = EndPaint(self.hwnd, &paint);
        }
    }

    fn mouse_move(&mut self, point: POINT) {
        if self.active.is_none() {
            return;
        }
        let Some(surface) = self.surface.as_ref() else {
            return;
        };
        self.mouse = POINT {
            x: point.x.clamp(0, surface.width.saturating_sub(1)),
            y: point.y.clamp(0, surface.height.saturating_sub(1)),
        };
        self.editor.update_hover(self.mouse);
        if self.editor.pointer_move(self.mouse, self.selection) {
            self.set_cursor();
            let _ = self.render();
            return;
        }
        if let Some(drag) = self.drag {
            self.selection = drag_rect(drag, self.mouse, surface.width, surface.height);
            self.size_text = dimensions_text(self.selection);
        }
        self.set_cursor();
        let _ = self.render();
    }

    fn left_down(&mut self, point: POINT) {
        if self.active.is_none() {
            return;
        }
        self.mouse_move(point);
        if point_in_rect(point, self.size_panel) {
            self.editing_size = true;
            self.size_replace_on_type = true;
            self.size_text = dimensions_text(self.selection);
            let _ = self.render();
            return;
        }
        if self.editing_size {
            self.apply_size_text();
        }
        let hit = self.hit_test(point);
        let resize_handle = matches!(
            hit,
            Hit::North
                | Hit::South
                | Hit::West
                | Hit::East
                | Hit::NorthWest
                | Hit::NorthEast
                | Hit::SouthWest
                | Hit::SouthEast
        );
        if !resize_handle {
            match self.editor.pointer_down(
                point,
                self.selection,
                self.surface.as_ref().map_or(0, |surface| surface.width),
                self.surface.as_ref().map_or(0, |surface| surface.height),
            ) {
                EditorAction::NotHandled => {}
                EditorAction::Handled => {
                    if self.editor.is_drawing() {
                        unsafe {
                            let _ = SetCapture(self.hwnd);
                        }
                    }
                    let _ = self.render();
                    return;
                }
                EditorAction::RequestTranslation => {
                    let _ = self.render();
                    self.request_translation();
                    return;
                }
                EditorAction::CancelTranslation => {
                    if let Some(surface) = self.surface.as_mut() {
                        surface.clear_translation();
                    }
                    let _ = self.render();
                    return;
                }
                EditorAction::Finish(intent) => {
                    self.finish_editor(intent);
                    return;
                }
                EditorAction::Cancel => {
                    self.cancel();
                    return;
                }
            }
        }
        if self.editor.translation_applied() {
            self.editor.clear_translation();
            if let Some(surface) = self.surface.as_mut() {
                surface.clear_translation();
            }
        }
        self.selection_ready = false;
        self.editor.set_chrome_visible(false);
        self.drag = Some(Drag {
            hit,
            origin: point,
            original: self.selection,
        });
        unsafe {
            let _ = SetCapture(self.hwnd);
        }
    }

    fn left_up(&mut self, point: POINT) {
        if self.active.is_none() {
            return;
        }
        if self.editor.pointer_up(point, self.selection) {
            unsafe {
                let _ = ReleaseCapture();
            }
            let _ = self.render();
            return;
        }
        if self.drag.is_some() {
            self.mouse_move(point);
            self.drag = None;
            unsafe {
                let _ = ReleaseCapture();
            }
            if self.selection.width <= MIN_SELECTION_SIZE
                || self.selection.height <= MIN_SELECTION_SIZE
            {
                self.reset_full(false);
            } else {
                self.selection_ready = true;
                self.editor.set_chrome_visible(true);
                self.size_text = dimensions_text(self.selection);
                let _ = self.render();
            }
        }
    }

    fn right_up(&mut self) {
        let Some(surface) = self.surface.as_ref() else {
            return;
        };
        if !self.selection_ready || self.selection.is_full(surface.width, surface.height) {
            self.cancel();
        } else {
            self.reset_full(false);
        }
    }

    fn reset_full(&mut self, ready: bool) {
        let Some(surface) = self.surface.as_ref() else {
            return;
        };
        self.selection = PixelRect {
            x: 0,
            y: 0,
            width: surface.width,
            height: surface.height,
        };
        self.selection_ready = ready;
        self.editor.set_chrome_visible(ready);
        self.editor.clear_translation();
        if let Some(surface) = self.surface.as_mut() {
            surface.clear_translation();
        }
        self.drag = None;
        self.editing_size = false;
        self.size_replace_on_type = false;
        self.size_text = dimensions_text(self.selection);
        let _ = self.render();
    }

    fn hit_test(&self, point: POINT) -> Hit {
        let Some(surface) = self.surface.as_ref() else {
            return Hit::Select;
        };
        let rect = self.selection;
        if rect.is_full(surface.width, surface.height) {
            return Hit::Select;
        }
        let near_left = (point.x - rect.x).abs() <= HANDLE_SIZE;
        let near_right = (point.x - rect.right()).abs() <= HANDLE_SIZE;
        let near_top = (point.y - rect.y).abs() <= HANDLE_SIZE;
        let near_bottom = (point.y - rect.bottom()).abs() <= HANDLE_SIZE;
        let within_x = point.x >= rect.x - HANDLE_SIZE && point.x <= rect.right() + HANDLE_SIZE;
        let within_y = point.y >= rect.y - HANDLE_SIZE && point.y <= rect.bottom() + HANDLE_SIZE;
        match (
            near_left,
            near_right,
            near_top,
            near_bottom,
            within_x,
            within_y,
        ) {
            (true, _, true, _, _, _) => Hit::NorthWest,
            (_, true, true, _, _, _) => Hit::NorthEast,
            (true, _, _, true, _, _) => Hit::SouthWest,
            (_, true, _, true, _, _) => Hit::SouthEast,
            (true, _, _, _, _, true) => Hit::West,
            (_, true, _, _, _, true) => Hit::East,
            (_, _, true, _, true, _) => Hit::North,
            (_, _, _, true, true, _) => Hit::South,
            _ if rect.contains(point) => Hit::Move,
            _ => Hit::Select,
        }
    }

    fn set_cursor(&self) {
        let Some(surface) = self.surface.as_ref() else {
            return;
        };
        let cursor = if self.editor.is_over_chrome(self.mouse) {
            self.cursors.hand
        } else if self.editor.wants_cross_cursor(self.mouse, self.selection) {
            self.cursors.cross
        } else if point_in_rect(self.mouse, self.size_panel) {
            self.cursors.arrow
        } else {
            let hit = self.hit_test(self.mouse);
            self.cursors
                .for_hit(hit, self.selection.is_full(surface.width, surface.height))
        };
        unsafe {
            let _ = SetCursor(cursor);
        }
    }

    fn register_hotkeys(&self) -> Result<()> {
        let hotkeys = [
            (HOTKEY_ESCAPE, VK_ESCAPE.0 as u32),
            (HOTKEY_A, VK_A.0 as u32),
            (HOTKEY_H, VK_H.0 as u32),
            (HOTKEY_K, VK_K.0 as u32),
        ];
        for (id, key) in hotkeys {
            if let Err(error) = unsafe { RegisterHotKey(self.hwnd, id, MOD_NOREPEAT, key) } {
                self.unregister_hotkeys();
                return Err(error.into());
            }
        }
        Ok(())
    }

    fn unregister_hotkeys(&self) {
        for id in [HOTKEY_ESCAPE, HOTKEY_A, HOTKEY_H, HOTKEY_K] {
            let _ = unsafe { UnregisterHotKey(self.hwnd, id) };
        }
    }

    fn key_down(&mut self, key: u32) {
        if self.active.is_none() {
            return;
        }
        if self.editor.key_down(key) {
            let _ = self.render();
            return;
        }
        match key {
            value if value == VK_ESCAPE.0 as u32 => self.cancel(),
            _ if self.editor.translation_loading() => {}
            value if value == VK_A.0 as u32 => self.reset_full(true),
            value if value == VK_H.0 as u32 || value == VK_K.0 as u32 => {
                if let Err(error) = crate::clipboard::write_text(&self.color_hex) {
                    eprintln!("native-helper: overlay color copy failed: {error:#}");
                }
                self.cancel();
            }
            value if value == VK_RETURN.0 as u32 && self.editing_size => self.apply_size_text(),
            value if value == VK_BACK.0 as u32 && self.editing_size => {
                if self.size_replace_on_type {
                    self.size_text.clear();
                    self.size_replace_on_type = false;
                } else {
                    self.size_text.pop();
                }
                let _ = self.render();
            }
            _ => {}
        }
    }

    fn character(&mut self, value: char) {
        if !self.editing_size {
            return;
        }
        if value.is_ascii_digit() || matches!(value, 'x' | 'X' | '×' | ',' | ' ') {
            if self.size_text.chars().count() < 32 {
                if self.size_replace_on_type {
                    self.size_text.clear();
                    self.size_replace_on_type = false;
                }
                self.size_text.push(value);
                let _ = self.render();
            }
        }
    }

    fn apply_size_text(&mut self) {
        let Some(surface) = self.surface.as_ref() else {
            return;
        };
        if let Some((width, height)) = parse_dimensions(&self.size_text) {
            self.selection.width = width.clamp(1, surface.width - self.selection.x);
            self.selection.height = height.clamp(1, surface.height - self.selection.y);
        }
        self.editing_size = false;
        self.size_replace_on_type = false;
        self.selection_ready = true;
        self.editor.set_chrome_visible(true);
        self.size_text = dimensions_text(self.selection);
        let _ = self.render();
    }

    fn tick_deadline(&mut self) {
        if self
            .active
            .as_ref()
            .is_some_and(|session| Instant::now() >= session.deadline)
        {
            self.cancel();
        }
    }

    fn tick_animation(&mut self) {
        if self.editor.advance_spinner() {
            let _ = self.render();
        }
    }
}

fn save_png_with_native_dialog(hwnd: HWND, png: &[u8]) -> Result<bool> {
    let mut file_name = vec![0_u16; 32_768];
    let default_name: Vec<u16> = "TOAE-screenshot.png".encode_utf16().collect();
    file_name[..default_name.len()].copy_from_slice(&default_name);
    let filter: Vec<u16> = "PNG 图片 (*.png)\0*.png\0所有文件 (*.*)\0*.*\0\0"
        .encode_utf16()
        .collect();
    let title: Vec<u16> = "保存截图\0".encode_utf16().collect();
    let extension: Vec<u16> = "png\0".encode_utf16().collect();
    let mut options = OPENFILENAMEW {
        lStructSize: std::mem::size_of::<OPENFILENAMEW>() as u32,
        hwndOwner: hwnd,
        lpstrFilter: PCWSTR(filter.as_ptr()),
        nFilterIndex: 1,
        lpstrFile: PWSTR(file_name.as_mut_ptr()),
        nMaxFile: file_name.len() as u32,
        lpstrTitle: PCWSTR(title.as_ptr()),
        Flags: OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
        lpstrDefExt: PCWSTR(extension.as_ptr()),
        ..Default::default()
    };
    unsafe {
        let _ = SetForegroundWindow(hwnd);
        let _ = SetFocus(hwnd);
    }
    if !unsafe { GetSaveFileNameW(&mut options) }.as_bool() {
        let error = unsafe { CommDlgExtendedError() };
        if error.0 == 0 {
            return Ok(false);
        }
        bail!("native save dialog failed with code {}", error.0);
    }
    let length = file_name
        .iter()
        .position(|value| *value == 0)
        .context("native save dialog returned an unterminated path")?;
    let path = PathBuf::from(OsString::from_wide(&file_name[..length]));
    std::fs::write(&path, png).context("write screenshot PNG")?;
    Ok(true)
}

pub fn run() -> Result<()> {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let _gdiplus = GdiPlusSession::start()?;
    let writer = Arc::new(FrameWriter::new(std::io::stdout()));
    let mut state = Box::new(OverlayState::new(Arc::clone(&writer))?);
    let state_ptr: *mut OverlayState = &mut *state;
    let instance = unsafe { GetModuleHandleW(None).context("get overlay module handle")? };
    let class_name = w!("TOAE.NativeCaptureOverlay");
    let class = WNDCLASSW {
        style: CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS,
        lpfnWndProc: Some(window_proc),
        hInstance: HINSTANCE(instance.0),
        hCursor: state.cursors.cross,
        hbrBackground: HBRUSH(0),
        lpszClassName: class_name,
        ..Default::default()
    };
    if unsafe { RegisterClassW(&class) } == 0 {
        return Err(WinError::from_win32()).context("register native capture overlay window");
    }
    let hwnd = unsafe {
        CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            class_name,
            w!("TOAE Screenshot"),
            WS_POPUP,
            0,
            0,
            1,
            1,
            HWND(0),
            HMENU(0),
            HINSTANCE(instance.0),
            Some(state_ptr.cast()),
        )
    };
    if hwnd.0 == 0 {
        return Err(WinError::from_win32()).context("create native capture overlay window");
    }
    state.hwnd = hwnd;

    writer.json(&json!({
        "v": VERSION,
        "event": "overlay.ready",
        "result": {
            "backend": "gdi-dib",
            "persistent": true,
            "nativeWindow": true
        }
    }))?;
    start_command_reader(hwnd, Arc::clone(&writer));

    let mut message = MSG::default();
    loop {
        let value = unsafe { GetMessageW(&mut message, HWND(0), 0, 0) }.0;
        if value == -1 {
            return Err(WinError::from_win32()).context("read native overlay window message");
        }
        if value == 0 {
            break;
        }
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        state.tick_deadline();
    }
    drop(state);
    Ok(())
}

fn start_command_reader(hwnd: HWND, writer: Arc<FrameWriter<std::io::Stdout>>) {
    let raw_hwnd = hwnd.0;
    thread::Builder::new()
        .name("capture-overlay-commands".to_owned())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                let frame = match read_frame(&mut reader) {
                    Ok(Some(frame)) => frame,
                    Ok(None) => break,
                    Err(error) => {
                        eprintln!("native-helper: overlay command protocol failed: {error:#}");
                        break;
                    }
                };
                let Frame::Json(value) = frame else {
                    continue;
                };
                let command: WireCommand = match serde_json::from_value(value) {
                    Ok(command) => command,
                    Err(error) => {
                        eprintln!("native-helper: overlay rejected malformed command: {error}");
                        continue;
                    }
                };
                if command.v != VERSION || !(8..=128).contains(&command.id.len()) {
                    continue;
                }
                if command.command_type == "shutdown" {
                    let _ = unsafe {
                        PostMessageW(HWND(raw_hwnd), OVERLAY_SHUTDOWN, WPARAM(0), LPARAM(0))
                    };
                    return;
                }
                if command.command_type == "capture.editor.continue" {
                    let translated_png = if command
                        .payload
                        .get("binary")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        match read_frame(&mut reader) {
                            Ok(Some(Frame::Binary { request_id, bytes }))
                                if request_id == command.id => Some(bytes),
                            _ => {
                                let _ = writer.json(&json!({
                                    "v": VERSION,
                                    "id": command.id,
                                    "ok": false,
                                    "error": { "code": "invalid_overlay_binary", "message": "translated overlay binary frame is invalid" }
                                }));
                                continue;
                            }
                        }
                    } else {
                        None
                    };
                    let session_id = command
                        .payload
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .chars()
                        .take(128)
                        .collect::<String>();
                    let translation_error = command
                        .payload
                        .get("translationError")
                        .and_then(Value::as_str)
                        .map(|value| value.chars().take(500).collect::<String>());
                    let boxed = Box::new(OverlayContinueCommand {
                        id: command.id,
                        session_id,
                        deadline_ms: command.deadline_ms,
                        translated_png,
                        translation_error,
                    });
                    let pointer = Box::into_raw(boxed);
                    if unsafe {
                        PostMessageW(
                            HWND(raw_hwnd),
                            OVERLAY_CONTINUE,
                            WPARAM(0),
                            LPARAM(pointer as isize),
                        )
                    }
                    .is_err()
                    {
                        unsafe {
                            drop(Box::from_raw(pointer));
                        }
                        break;
                    }
                    continue;
                }
                if command.command_type == "capture.start" {
                    let action = command
                        .payload
                        .get("action")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    let editor = command
                        .payload
                        .get("editor")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let boxed = Box::new(OverlayCommand {
                        id: command.id,
                        action,
                        deadline_ms: command.deadline_ms,
                        editor,
                    });
                    let pointer = Box::into_raw(boxed);
                    if unsafe {
                        PostMessageW(
                            HWND(raw_hwnd),
                            OVERLAY_START,
                            WPARAM(0),
                            LPARAM(pointer as isize),
                        )
                    }
                    .is_err()
                    {
                        unsafe {
                            drop(Box::from_raw(pointer));
                        }
                        break;
                    }
                    continue;
                }
                let _ = writer.json(&json!({
                    "v": VERSION,
                    "id": command.id,
                    "ok": false,
                    "error": { "code": "invalid_overlay_command", "message": "unsupported overlay command" }
                }));
            }
            let _ = unsafe {
                PostMessageW(HWND(raw_hwnd), OVERLAY_SHUTDOWN, WPARAM(0), LPARAM(0))
            };
        })
        .expect("start native overlay command reader");
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(lparam.0 as *const CREATESTRUCTW);
        let state = create.lpCreateParams as *mut OverlayState;
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
        if !state.is_null() {
            (*state).hwnd = hwnd;
        }
    }
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut OverlayState;
    if state_ptr.is_null() {
        return DefWindowProcW(hwnd, message, wparam, lparam);
    }
    let state = &mut *state_ptr;
    match message {
        OVERLAY_START => {
            let command = Box::from_raw(lparam.0 as *mut OverlayCommand);
            state.start(*command);
            LRESULT(0)
        }
        OVERLAY_CONTINUE => {
            let command = Box::from_raw(lparam.0 as *mut OverlayContinueCommand);
            state.continue_editor(*command);
            LRESULT(0)
        }
        OVERLAY_SHUTDOWN => {
            if state.active.is_some() {
                state.cancel();
            }
            let _ = DestroyWindow(hwnd);
            LRESULT(0)
        }
        WM_PAINT => {
            state.paint();
            LRESULT(0)
        }
        WM_ERASEBKGND => LRESULT(1),
        WM_MOUSEMOVE => {
            state.mouse_move(point_from_lparam(lparam));
            LRESULT(0)
        }
        WM_LBUTTONDOWN => {
            state.left_down(point_from_lparam(lparam));
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            state.left_up(point_from_lparam(lparam));
            LRESULT(0)
        }
        WM_LBUTTONDBLCLK => {
            let point = point_from_lparam(lparam);
            let inside = state.selection.contains(point)
                || state
                    .surface
                    .as_ref()
                    .is_some_and(|surface| state.selection.is_full(surface.width, surface.height));
            if inside && !state.editor.translation_loading() {
                if state.editor.enabled() {
                    if state.selection_ready {
                        state.finish_editor(EditorIntent::Copy);
                    }
                } else {
                    state.confirm();
                }
            }
            LRESULT(0)
        }
        WM_RBUTTONUP => {
            state.right_up();
            LRESULT(0)
        }
        WM_HOTKEY => {
            match wparam.0 as i32 {
                HOTKEY_ESCAPE => state.key_down(VK_ESCAPE.0 as u32),
                HOTKEY_A => state.key_down(VK_A.0 as u32),
                HOTKEY_H => state.key_down(VK_H.0 as u32),
                HOTKEY_K => state.key_down(VK_K.0 as u32),
                _ => {}
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == DEADLINE_TIMER {
                state.tick_deadline();
            } else if wparam.0 == ANIMATION_TIMER {
                state.tick_animation();
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            state.key_down(wparam.0 as u32);
            LRESULT(0)
        }
        WM_CHAR => {
            if let Some(character) = char::from_u32(wparam.0 as u32) {
                state.character(character);
            }
            LRESULT(0)
        }
        WM_SETCURSOR => {
            state.set_cursor();
            LRESULT(1)
        }
        WM_CLOSE => {
            state.cancel();
            LRESULT(0)
        }
        WM_DESTROY => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

fn monitor_at_cursor() -> Result<RECT> {
    unsafe {
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).context("read cursor position for overlay")?;
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            bail!("no monitor is available for native overlay");
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            bail!("read native overlay monitor bounds failed");
        }
        checked_pixel_count(
            info.rcMonitor.right - info.rcMonitor.left,
            info.rcMonitor.bottom - info.rcMonitor.top,
        )?;
        Ok(info.rcMonitor)
    }
}

fn checked_pixel_count(width: i32, height: i32) -> Result<usize> {
    if width < 1 || height < 1 {
        bail!("capture dimensions are empty");
    }
    let pixels = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .context("capture pixel count overflow")?;
    if pixels > MAX_CAPTURE_PIXELS {
        bail!("capture dimensions exceed the configured limit");
    }
    Ok(pixels)
}

unsafe fn draw_mask(surface: &Surface, selection: PixelRect) {
    let rects = [
        PixelRect {
            x: 0,
            y: 0,
            width: surface.width,
            height: selection.y.max(0),
        },
        PixelRect {
            x: 0,
            y: selection.y,
            width: selection.x.max(0),
            height: selection.height,
        },
        PixelRect {
            x: selection.right(),
            y: selection.y,
            width: (surface.width - selection.right()).max(0),
            height: selection.height,
        },
        PixelRect {
            x: 0,
            y: selection.bottom(),
            width: surface.width,
            height: (surface.height - selection.bottom()).max(0),
        },
    ];
    let blend = BLENDFUNCTION {
        BlendOp: 0,
        BlendFlags: 0,
        SourceConstantAlpha: MASK_ALPHA,
        AlphaFormat: 0,
    };
    for rect in rects {
        if rect.width > 0 && rect.height > 0 {
            let _ = GdiAlphaBlend(
                surface.back_dc,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                surface.shade_dc,
                0,
                0,
                1,
                1,
                blend,
            );
        }
    }
}

unsafe fn draw_selection_frame(surface: &Surface, selection: PixelRect, handles: bool) {
    let brush = HBRUSH(GetStockObject(DC_BRUSH).0);
    frame_rect(
        surface.back_dc,
        RECT {
            left: selection.x,
            top: selection.y,
            right: selection.right(),
            bottom: selection.bottom(),
        },
        color(29, 125, 250),
        2,
        brush,
    );
    if !handles {
        return;
    }
    let center_x = selection.x + selection.width / 2;
    let center_y = selection.y + selection.height / 2;
    let points = [
        POINT {
            x: selection.x,
            y: selection.y,
        },
        POINT {
            x: center_x,
            y: selection.y,
        },
        POINT {
            x: selection.right(),
            y: selection.y,
        },
        POINT {
            x: selection.x,
            y: center_y,
        },
        POINT {
            x: selection.right(),
            y: center_y,
        },
        POINT {
            x: selection.x,
            y: selection.bottom(),
        },
        POINT {
            x: center_x,
            y: selection.bottom(),
        },
        POINT {
            x: selection.right(),
            y: selection.bottom(),
        },
    ];
    for point in points {
        let left = (point.x - 4).clamp(0, surface.width.saturating_sub(8));
        let top = (point.y - 4).clamp(0, surface.height.saturating_sub(8));
        let handle = RECT {
            left,
            top,
            right: left + 8,
            bottom: top + 8,
        };
        let _ = SetDCBrushColor(surface.back_dc, color(255, 255, 255));
        let _ = FillRect(surface.back_dc, &handle, brush);
        frame_rect(surface.back_dc, handle, color(29, 125, 250), 2, brush);
    }
}

unsafe fn draw_size_panel(
    surface: &Surface,
    selection: PixelRect,
    value: &str,
    editing: bool,
) -> RECT {
    let mut text: Vec<u16> = value.encode_utf16().collect();
    if text.is_empty() {
        text.push(' ' as u16);
    }
    let mut text_size = SIZE::default();
    let _ = GetTextExtentPoint32W(surface.back_dc, &text, &mut text_size);
    let width = (text_size.cx + 20).max(78);
    let height = 34;
    let mut x = selection.x + (selection.width - width) / 2;
    if width >= selection.width {
        x = selection.x.min(surface.width - width);
    }
    x = x.clamp(0, (surface.width - width).max(0));
    let y = if selection.y >= height + 10 {
        selection.y - height - 10
    } else {
        (selection.y + 10).min((surface.height - height).max(0))
    };
    let panel = RECT {
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
    };
    draw_round_panel(surface, panel);
    let _ = SetBkMode(surface.back_dc, TRANSPARENT);
    let _ = SetTextColor(surface.back_dc, color(0, 0, 0));
    let mut text_rect = RECT {
        left: panel.left + 8,
        top: panel.top,
        right: panel.right - 8,
        bottom: panel.bottom,
    };
    let _ = DrawTextW(
        surface.back_dc,
        &mut text,
        &mut text_rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
    );
    if editing {
        let caret = RECT {
            left: panel.right - 8,
            top: panel.top + 8,
            right: panel.right - 7,
            bottom: panel.bottom - 8,
        };
        let brush = HBRUSH(GetStockObject(DC_BRUSH).0);
        let _ = SetDCBrushColor(surface.back_dc, color(20, 20, 20));
        let _ = FillRect(surface.back_dc, &caret, brush);
    }
    panel
}

unsafe fn draw_round_panel(surface: &Surface, rect: RECT) {
    let old_brush = SelectObject(surface.back_dc, HGDIOBJ(surface.shadow_brush.0));
    let _ = RoundRect(
        surface.back_dc,
        rect.left + 2,
        rect.top + 2,
        rect.right + 3,
        rect.bottom + 3,
        PANEL_RADIUS * 2,
        PANEL_RADIUS * 2,
    );
    let _ = SelectObject(surface.back_dc, HGDIOBJ(surface.panel_brush.0));
    let _ = RoundRect(
        surface.back_dc,
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        PANEL_RADIUS * 2,
        PANEL_RADIUS * 2,
    );
    let _ = SelectObject(surface.back_dc, old_brush);
}

unsafe fn draw_magnifier(surface: &Surface, selection: PixelRect, mouse: POINT) -> String {
    let width = MAG_GRID * MAG_CELL;
    let height = width + MAG_COLOR_HEIGHT;
    let x = if mouse.x + MAG_GAP + width <= surface.width {
        mouse.x + MAG_GAP
    } else {
        (mouse.x - MAG_GAP - width).max(0)
    };
    let y = if mouse.y + MAG_GAP + height <= surface.height {
        mouse.y + MAG_GAP
    } else {
        (mouse.y - MAG_GAP - height).max(0)
    };
    let panel = RECT {
        left: x,
        top: y,
        right: x + width,
        bottom: y + height,
    };
    draw_round_panel(surface, panel);
    let dc_brush = HBRUSH(GetStockObject(DC_BRUSH).0);
    let half = MAG_GRID / 2;
    let center = surface.pixel(mouse.x, mouse.y);
    for row in 0..MAG_GRID {
        for column in 0..MAG_GRID {
            let px = mouse.x + column - half;
            let py = mouse.y + row - half;
            let mut pixel = surface.pixel(px, py);
            if (row != half || column != half) && !selection.contains(POINT { x: px, y: py }) {
                pixel = [
                    ((u16::from(pixel[0]) + 255) / 2) as u8,
                    ((u16::from(pixel[1]) + 255) / 2) as u8,
                    ((u16::from(pixel[2]) + 255) / 2) as u8,
                ];
            }
            let _ = SetDCBrushColor(surface.back_dc, color(pixel[0], pixel[1], pixel[2]));
            let cell = RECT {
                left: x + column * MAG_CELL,
                top: y + row * MAG_CELL,
                right: x + (column + 1) * MAG_CELL,
                bottom: y + (row + 1) * MAG_CELL,
            };
            let _ = FillRect(surface.back_dc, &cell, dc_brush);
        }
    }
    let center_rect = RECT {
        left: x + half * MAG_CELL,
        top: y + half * MAG_CELL,
        right: x + (half + 1) * MAG_CELL,
        bottom: y + (half + 1) * MAG_CELL,
    };
    frame_rect(
        surface.back_dc,
        center_rect,
        color(255, 255, 255),
        2,
        dc_brush,
    );
    frame_rect(surface.back_dc, center_rect, color(0, 0, 0), 1, dc_brush);

    let label = RECT {
        left: x,
        top: y + width,
        right: x + width,
        bottom: y + height,
    };
    let _ = SetDCBrushColor(surface.back_dc, color(center[0], center[1], center[2]));
    let _ = FillRect(surface.back_dc, &label, dc_brush);
    let value = format!("#{:02X}{:02X}{:02X}", center[0], center[1], center[2]);
    let mut text: Vec<u16> = value.encode_utf16().collect();
    let _ = SetBkMode(surface.back_dc, TRANSPARENT);
    let text_color = if is_light(center) {
        color(0, 0, 0)
    } else {
        color(255, 255, 255)
    };
    let _ = SetTextColor(surface.back_dc, text_color);
    let mut text_rect = label;
    let _ = DrawTextW(
        surface.back_dc,
        &mut text,
        &mut text_rect,
        DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
    );
    value
}

unsafe fn frame_rect(dc: HDC, rect: RECT, value: COLORREF, thickness: i32, brush: HBRUSH) {
    let _ = SetDCBrushColor(dc, value);
    let parts = [
        RECT {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.top + thickness,
        },
        RECT {
            left: rect.left,
            top: rect.bottom - thickness,
            right: rect.right,
            bottom: rect.bottom,
        },
        RECT {
            left: rect.left,
            top: rect.top,
            right: rect.left + thickness,
            bottom: rect.bottom,
        },
        RECT {
            left: rect.right - thickness,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        },
    ];
    for part in parts {
        let _ = FillRect(dc, &part, brush);
    }
}

fn drag_rect(drag: Drag, current: POINT, width: i32, height: i32) -> PixelRect {
    let dx = current.x - drag.origin.x;
    let dy = current.y - drag.origin.y;
    let original = drag.original;
    match drag.hit {
        Hit::Select => PixelRect {
            x: drag.origin.x,
            y: drag.origin.y,
            width: current.x - drag.origin.x + if current.x >= drag.origin.x { 1 } else { -1 },
            height: current.y - drag.origin.y + if current.y >= drag.origin.y { 1 } else { -1 },
        }
        .normalized(width, height),
        Hit::Move => {
            let x = (original.x + dx).clamp(0, (width - original.width).max(0));
            let y = (original.y + dy).clamp(0, (height - original.height).max(0));
            PixelRect { x, y, ..original }
        }
        hit => {
            let mut left = original.x;
            let mut top = original.y;
            let mut right = original.right();
            let mut bottom = original.bottom();
            if matches!(hit, Hit::West | Hit::NorthWest | Hit::SouthWest) {
                left += dx;
            }
            if matches!(hit, Hit::East | Hit::NorthEast | Hit::SouthEast) {
                right += dx;
            }
            if matches!(hit, Hit::North | Hit::NorthWest | Hit::NorthEast) {
                top += dy;
            }
            if matches!(hit, Hit::South | Hit::SouthWest | Hit::SouthEast) {
                bottom += dy;
            }
            PixelRect {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
            }
            .normalized(width, height)
        }
    }
}

fn dimensions_text(rect: PixelRect) -> String {
    format!("{} × {}", rect.width, rect.height)
}

fn parse_dimensions(value: &str) -> Option<(i32, i32)> {
    let normalized = value.replace(['×', 'X', 'x', ','], " ");
    let values: Vec<i32> = normalized
        .split_whitespace()
        .map(str::parse)
        .collect::<std::result::Result<_, _>>()
        .ok()?;
    if values.len() == 2 && values[0] > 0 && values[1] > 0 {
        Some((values[0], values[1]))
    } else {
        None
    }
}

fn point_in_rect(point: POINT, rect: RECT) -> bool {
    point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom
}

fn point_from_lparam(value: LPARAM) -> POINT {
    POINT {
        x: (value.0 as u16 as i16) as i32,
        y: ((value.0 >> 16) as u16 as i16) as i32,
    }
}

fn color(red: u8, green: u8, blue: u8) -> COLORREF {
    COLORREF(u32::from(red) | (u32::from(green) << 8) | (u32::from(blue) << 16))
}

fn is_light(pixel: [u8; 3]) -> bool {
    u32::from(pixel[0]) * 299 + u32::from(pixel[1]) * 587 + u32::from(pixel[2]) * 114 > 186_000
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_original_dimension_formats() {
        assert_eq!(parse_dimensions("640 × 480"), Some((640, 480)));
        assert_eq!(parse_dimensions("640,480"), Some((640, 480)));
        assert_eq!(parse_dimensions("640x480"), Some((640, 480)));
        assert_eq!(parse_dimensions("0 × 480"), None);
        assert_eq!(parse_dimensions("bad"), None);
    }

    #[test]
    fn selection_drag_is_normalized_and_clipped() {
        let result = drag_rect(
            Drag {
                hit: Hit::Select,
                origin: POINT { x: 100, y: 100 },
                original: PixelRect::default(),
            },
            POINT { x: 10, y: 20 },
            200,
            200,
        );
        assert_eq!(
            result,
            PixelRect {
                x: 9,
                y: 19,
                width: 91,
                height: 81
            }
        );
    }

    #[test]
    fn moving_a_selection_preserves_its_size() {
        let result = drag_rect(
            Drag {
                hit: Hit::Move,
                origin: POINT { x: 50, y: 50 },
                original: PixelRect {
                    x: 20,
                    y: 20,
                    width: 80,
                    height: 60,
                },
            },
            POINT { x: -100, y: -100 },
            200,
            200,
        );
        assert_eq!(
            result,
            PixelRect {
                x: 0,
                y: 0,
                width: 80,
                height: 60
            }
        );
    }
}
