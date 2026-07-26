use crate::capture_fallback::CaptureWorkerBackend;
use crate::job::KillOnCloseJob;
use crate::protocol::{read_frame, Frame as ProtocolFrame, FrameWriter, MAX_BINARY_FRAME, VERSION};
use anyhow::{bail, Context, Result};
use image::codecs::png::{PngDecoder, PngEncoder};
use image::{ColorType, ImageDecoder, ImageEncoder, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::io::{BufReader, Cursor};
use std::ops::Deref;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;
use windows::core::ComInterface;
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, POINT, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, MonitorFromPoint, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HGDIOBJ, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    MONITOR_DEFAULTTONULL, SRCCOPY,
};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

const MAX_CAPTURE_PIXELS: usize = 100_000_000;
const MAX_SESSIONS: usize = 2;
const WGC_FRAME_TIMEOUT: Duration = Duration::from_millis(1_500);
const WGC_WORKER_LIMIT_MS: u64 = 2_500;
const GDI_WORKER_RESERVE_MS: u64 = 1_500;
const CAPTURE_WORKER_FRAME_ID: &str = "capture-worker";

#[derive(Debug, Clone, Copy, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy)]
pub enum CaptureBackend {
    Wgc,
    GdiFallback,
}

impl CaptureBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wgc => "wgc",
            Self::GdiFallback => "gdi-fallback",
        }
    }
}

pub struct CaptureResult {
    pub session_id: String,
    pub width: u32,
    pub height: u32,
    pub backend: CaptureBackend,
    pub physical_bounds: Rect,
    pub png: Vec<u8>,
}

struct Frame {
    width: u32,
    height: u32,
    physical_bounds: Rect,
    png: Vec<u8>,
}

#[derive(Default)]
pub struct CaptureStore {
    frames: HashMap<String, Frame>,
}

impl CaptureStore {
    pub fn start(&mut self, deadline_ms: u64, job: &KillOnCloseJob) -> Result<CaptureResult> {
        self.frames.clear();
        let deadline = Instant::now() + Duration::from_millis(deadline_ms);
        let target = capture_target_at_cursor()?;
        eprintln!(
            "native-helper: capture stage=target-fixed rect={},{},{},{}",
            target.left, target.top, target.right, target.bottom
        );

        // WGC deterministically crashes during COM/D3D teardown on the target
        // Windows 10 machine after a successful readback. Trying it first adds
        // almost a second before the known-good GDI path. Keep WGC available as
        // an isolated diagnostic worker, but use GDI directly for production
        // captures until that driver/runtime-specific crash can be eliminated.
        let budget = worker_budget(CaptureWorkerBackend::Gdi, deadline)?;
        let frame = run_worker_process(CaptureWorkerBackend::Gdi, target, budget, job)
            .context("GDI capture worker failed")?;
        eprintln!("native-helper: capture backend=gdi");
        let backend = CaptureBackend::GdiFallback;
        let png = frame.png.clone();
        let session_id = Uuid::new_v4().to_string();
        let result = CaptureResult {
            session_id: session_id.clone(),
            width: frame.width,
            height: frame.height,
            backend,
            physical_bounds: frame.physical_bounds,
            png,
        };
        if self.frames.len() >= MAX_SESSIONS {
            self.frames.clear();
        }
        self.frames.insert(session_id, frame);
        Ok(result)
    }

    pub fn crop(&self, session_id: &str, roi: CropRect) -> Result<Vec<u8>> {
        let frame = self
            .frames
            .get(session_id)
            .context("capture session does not exist")?;
        validate_crop(roi, frame.width, frame.height)?;
        let decoded = image::load_from_memory_with_format(&frame.png, ImageFormat::Png)
            .context("decode retained capture frame")?
            .into_rgba8();
        if decoded.width() != frame.width || decoded.height() != frame.height {
            bail!("retained capture dimensions changed while decoding");
        }
        let row_bytes = usize::try_from(roi.width)? * 4;
        let mut rgba = Vec::with_capacity(row_bytes * usize::try_from(roi.height)?);
        for row in roi.y..roi.y + roi.height {
            let start = (usize::try_from(row)? * usize::try_from(frame.width)?
                + usize::try_from(roi.x)?)
                * 4;
            rgba.extend_from_slice(&decoded.as_raw()[start..start + row_bytes]);
        }
        encode_png(&rgba, roi.width, roi.height)
    }

    pub fn cancel(&mut self, session_id: &str) {
        self.frames.remove(session_id);
    }

    pub fn clear(&mut self) {
        self.frames.clear();
    }
}

fn validate_crop(roi: CropRect, width: u32, height: u32) -> Result<()> {
    if roi.width == 0
        || roi.height == 0
        || roi.x >= width
        || roi.y >= height
        || roi
            .x
            .checked_add(roi.width)
            .is_none_or(|right| right > width)
        || roi
            .y
            .checked_add(roi.height)
            .is_none_or(|bottom| bottom > height)
    {
        bail!("capture crop is outside the retained frame");
    }
    Ok(())
}

pub struct CaptureWorkerOptions {
    pub backend: CaptureWorkerBackend,
    pub rect: RECT,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerEnvelope {
    v: u64,
    event: String,
    ok: bool,
    #[serde(default)]
    result: Option<WorkerMetadata>,
    #[serde(default)]
    error: Option<WorkerError>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerMetadata {
    backend: String,
    width: u32,
    height: u32,
    physical_bounds: Rect,
    binary: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkerError {
    code: String,
    message: String,
}

struct RawFrame {
    width: u32,
    height: u32,
    physical_bounds: Rect,
    rgba: Vec<u8>,
}

pub fn run_worker(options: CaptureWorkerOptions) -> Result<()> {
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let writer = FrameWriter::new(std::io::stdout());
    let captured = (|| -> Result<(RawFrame, Vec<u8>)> {
        dimensions_from_rect(options.rect)?;
        let frame = match options.backend {
            CaptureWorkerBackend::Wgc => {
                let monitor = monitor_for_target(options.rect)?;
                capture_monitor_wgc(monitor, options.rect)?
            }
            CaptureWorkerBackend::Gdi => capture_rect_gdi(options.rect)?,
        };
        let png = encode_png(&frame.rgba, frame.width, frame.height)?;
        if png.len() > MAX_BINARY_FRAME {
            bail!("capture worker PNG exceeds protocol size limit");
        }
        Ok((frame, png))
    })();

    let (frame, png) = match captured {
        Ok(value) => value,
        Err(error) => {
            let message = format!("{error:#}");
            let _ = writer.json(&json!({
                "v": VERSION,
                "event": "capture.worker",
                "ok": false,
                "error": {
                    "code": "capture_worker_failed",
                    "message": message.chars().take(500).collect::<String>()
                }
            }));
            return Err(error);
        }
    };

    writer.json(&json!({
        "v": VERSION,
        "event": "capture.worker",
        "ok": true,
        "result": {
            "backend": options.backend.as_arg(),
            "width": frame.width,
            "height": frame.height,
            "physicalBounds": frame.physical_bounds,
            "binary": true
        }
    }))?;
    writer.binary(CAPTURE_WORKER_FRAME_ID, &png)
}

fn capture_target_at_cursor() -> Result<RECT> {
    unsafe {
        let mut cursor = POINT::default();
        GetCursorPos(&mut cursor).context("read cursor position")?;
        let monitor = MonitorFromPoint(cursor, MONITOR_DEFAULTTONEAREST);
        if monitor.is_invalid() {
            bail!("no monitor is available for capture");
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            bail!("read monitor bounds failed");
        }
        dimensions_from_rect(info.rcMonitor)?;
        Ok(info.rcMonitor)
    }
}

fn monitor_for_target(rect: RECT) -> Result<HMONITOR> {
    let width = rect
        .right
        .checked_sub(rect.left)
        .context("monitor width overflow")?;
    let height = rect
        .bottom
        .checked_sub(rect.top)
        .context("monitor height overflow")?;
    let center = POINT {
        x: rect
            .left
            .checked_add(width / 2)
            .context("monitor center overflow")?,
        y: rect
            .top
            .checked_add(height / 2)
            .context("monitor center overflow")?,
    };
    unsafe {
        let monitor = MonitorFromPoint(center, MONITOR_DEFAULTTONULL);
        if monitor.is_invalid() {
            bail!("target monitor is no longer available");
        }
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            bail!("read target monitor bounds failed");
        }
        if info.rcMonitor.left != rect.left
            || info.rcMonitor.top != rect.top
            || info.rcMonitor.right != rect.right
            || info.rcMonitor.bottom != rect.bottom
        {
            bail!("target monitor physical bounds changed before capture");
        }
        Ok(monitor)
    }
}

fn worker_budget(backend: CaptureWorkerBackend, deadline: Instant) -> Result<Duration> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .context("capture deadline elapsed before worker start")?;
    let remaining_ms = remaining.as_millis().min(u128::from(u64::MAX)) as u64;
    let budget_ms = match backend {
        CaptureWorkerBackend::Wgc => {
            let gdi_reserve = (remaining_ms / 2).min(GDI_WORKER_RESERVE_MS);
            remaining_ms
                .saturating_sub(gdi_reserve)
                .min(WGC_WORKER_LIMIT_MS)
                .max(1)
        }
        CaptureWorkerBackend::Gdi => remaining_ms.max(1),
    };
    Ok(Duration::from_millis(budget_ms))
}

fn run_worker_process(
    backend: CaptureWorkerBackend,
    rect: RECT,
    budget: Duration,
    job: &KillOnCloseJob,
) -> Result<Frame> {
    let attempt_deadline = Instant::now() + budget;
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let child = Command::new(executable)
        .arg("--capture-worker")
        .arg("--capture-backend")
        .arg(backend.as_arg())
        .arg("--capture-left")
        .arg(rect.left.to_string())
        .arg("--capture-top")
        .arg(rect.top.to_string())
        .arg("--capture-right")
        .arg(rect.right.to_string())
        .arg("--capture-bottom")
        .arg(rect.bottom.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .with_context(|| format!("start {} capture worker", backend.as_arg()))?;
    let mut child = CaptureChild::new(child);
    child.assign(job)?;
    let stdout = child.take_stdout()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let reader_thread = thread::Builder::new()
        .name(format!("capture-{}-reader", backend.as_arg()))
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            let result = read_worker_output(&mut reader, backend, rect);
            let _ = sender.send(result);
        })
        .context("start capture worker protocol reader")?;

    let remaining = attempt_deadline
        .checked_duration_since(Instant::now())
        .unwrap_or(Duration::ZERO);
    let read_result = match receiver.recv_timeout(remaining) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            child.terminate();
            let _ = reader_thread.join();
            bail!(
                "{} capture worker timed out after {} ms",
                backend.as_arg(),
                budget.as_millis()
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            child.terminate();
            let _ = reader_thread.join();
            bail!(
                "{} capture worker protocol reader stopped",
                backend.as_arg()
            );
        }
    };

    let status = match child.wait_until(attempt_deadline) {
        Ok(status) => status,
        Err(error) => {
            child.terminate();
            let _ = reader_thread.join();
            return Err(error);
        }
    };
    if reader_thread.join().is_err() {
        bail!(
            "{} capture worker protocol reader panicked",
            backend.as_arg()
        );
    }
    if !status.success() {
        let protocol_detail = match &read_result {
            Ok(_) => "worker emitted a success frame".to_owned(),
            Err(error) => format!("protocol result: {error:#}"),
        };
        bail!(
            "{} capture worker {} ({protocol_detail})",
            backend.as_arg(),
            format_worker_exit(status)
        );
    }
    read_result.with_context(|| format!("{} capture worker protocol failed", backend.as_arg()))
}

fn read_worker_output(
    reader: &mut impl std::io::Read,
    backend: CaptureWorkerBackend,
    rect: RECT,
) -> Result<Frame> {
    let envelope = match read_frame(reader)? {
        Some(ProtocolFrame::Json(value)) => serde_json::from_value::<WorkerEnvelope>(value)
            .context("parse capture worker result")?,
        Some(ProtocolFrame::Binary { .. }) => {
            bail!("capture worker sent binary before result metadata")
        }
        None => bail!("capture worker reached EOF before result metadata"),
    };
    if envelope.v != VERSION || envelope.event != "capture.worker" {
        bail!("capture worker sent incompatible result metadata");
    }
    if !envelope.ok {
        if read_frame(reader)?.is_some() {
            bail!("capture worker sent frames after an error result");
        }
        let error = envelope
            .error
            .context("capture worker error details are missing")?;
        if envelope.result.is_some() || error.code != "capture_worker_failed" {
            bail!("capture worker sent invalid error metadata");
        }
        bail!("capture worker reported {}: {}", error.code, error.message);
    }
    if envelope.error.is_some() {
        bail!("capture worker success result included an error");
    }
    let metadata = envelope
        .result
        .context("capture worker success metadata is missing")?;
    if metadata.backend != backend.as_arg() || !metadata.binary {
        bail!("capture worker backend metadata is invalid");
    }
    let (width, height, _) = dimensions_from_rect(rect)?;
    let expected_bounds = Rect {
        x: rect.left,
        y: rect.top,
        width,
        height,
    };
    if metadata.width != width
        || metadata.height != height
        || metadata.physical_bounds != expected_bounds
    {
        bail!("capture worker frame does not match the fixed target bounds");
    }
    let png = match read_frame(reader)? {
        Some(ProtocolFrame::Binary { request_id, bytes })
            if request_id == CAPTURE_WORKER_FRAME_ID =>
        {
            bytes
        }
        Some(_) => bail!("capture worker binary frame is invalid"),
        None => bail!("capture worker reached EOF before its binary frame"),
    };
    if read_frame(reader)?.is_some() {
        bail!("capture worker sent extra protocol frames");
    }
    let decoder =
        PngDecoder::new(Cursor::new(png.as_slice())).context("decode capture worker PNG header")?;
    if decoder.dimensions() != (width, height) {
        bail!("capture worker PNG dimensions do not match metadata");
    }
    Ok(Frame {
        width,
        height,
        physical_bounds: expected_bounds,
        png,
    })
}

struct CaptureChild {
    child: Option<Child>,
}

impl CaptureChild {
    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn assign(&self, job: &KillOnCloseJob) -> Result<()> {
        let child = self
            .child
            .as_ref()
            .context("capture worker is unavailable")?;
        job.assign(child)
    }

    fn take_stdout(&mut self) -> Result<std::process::ChildStdout> {
        self.child
            .as_mut()
            .context("capture worker is unavailable")?
            .stdout
            .take()
            .context("capture worker stdout is unavailable")
    }

    fn wait_until(&mut self, deadline: Instant) -> Result<ExitStatus> {
        loop {
            let status = self
                .child
                .as_mut()
                .context("capture worker is unavailable")?
                .try_wait()
                .context("query capture worker status")?;
            if let Some(status) = status {
                self.child.take();
                return Ok(status);
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .context("capture worker did not exit before timeout")?;
            thread::sleep(remaining.min(Duration::from_millis(5)));
        }
    }

    fn terminate(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        if !matches!(child.try_wait(), Ok(Some(_))) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

impl Drop for CaptureChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn format_worker_exit(status: ExitStatus) -> String {
    match status.code() {
        Some(code) => {
            let raw = code as u32;
            format!("exited (code={raw} decimal, 0x{raw:08X})")
        }
        None => "exited without an exit code".to_owned(),
    }
}

struct WinRtApartment;

impl WinRtApartment {
    fn initialize() -> Result<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED).context("initialize WinRT apartment")? };
        Ok(Self)
    }
}

impl Drop for WinRtApartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

struct WgcDevice {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    winrt_device: IDirect3DDevice,
}

impl WgcDevice {
    fn create() -> Result<Self> {
        unsafe {
            let mut device = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
            .context("create WGC D3D11 device")?;
            let device = device.context("D3D11 returned no device")?;
            let context = device
                .GetImmediateContext()
                .context("get WGC D3D11 immediate context")?;
            let dxgi_device: IDXGIDevice = device.cast().context("query WGC DXGI device")?;
            let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi_device)
                .context("create WinRT D3D11 device")?;
            let winrt_device = inspectable
                .cast::<IDirect3DDevice>()
                .context("query WinRT D3D11 device")?;
            Ok(Self {
                device,
                context,
                winrt_device,
            })
        }
    }
}

impl Drop for WgcDevice {
    fn drop(&mut self) {
        let _ = self.winrt_device.Close();
    }
}

struct FramePoolGuard(Direct3D11CaptureFramePool);

impl Deref for FramePoolGuard {
    type Target = Direct3D11CaptureFramePool;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for FramePoolGuard {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

struct CaptureSessionGuard(GraphicsCaptureSession);

impl Deref for CaptureSessionGuard {
    type Target = GraphicsCaptureSession;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for CaptureSessionGuard {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

struct CaptureFrameGuard(Direct3D11CaptureFrame);

impl Deref for CaptureFrameGuard {
    type Target = Direct3D11CaptureFrame;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for CaptureFrameGuard {
    fn drop(&mut self) {
        let _ = self.0.Close();
    }
}

struct MappedTexture<'a> {
    context: &'a ID3D11DeviceContext,
    texture: &'a ID3D11Texture2D,
    data: D3D11_MAPPED_SUBRESOURCE,
}

impl<'a> MappedTexture<'a> {
    fn read(context: &'a ID3D11DeviceContext, texture: &'a ID3D11Texture2D) -> Result<Self> {
        let mut data = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context
                .Map(texture, 0, D3D11_MAP_READ, 0, Some(&mut data))
                .context("map WGC staging texture")?;
        }
        Ok(Self {
            context,
            texture,
            data,
        })
    }
}

impl Drop for MappedTexture<'_> {
    fn drop(&mut self) {
        unsafe { self.context.Unmap(self.texture, 0) };
    }
}

fn capture_monitor_wgc(monitor: HMONITOR, rect: RECT) -> Result<RawFrame> {
    eprintln!("native-helper: capture stage=wgc.begin");
    let _apartment = WinRtApartment::initialize()?;
    if !GraphicsCaptureSession::IsSupported().context("query WGC support")? {
        bail!("WGC is not supported by this Windows session");
    }

    let (expected_width, expected_height, _) = dimensions_from_rect(rect)?;
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .context("get WGC capture item factory")?;
    let item: GraphicsCaptureItem = unsafe {
        interop
            .CreateForMonitor(monitor)
            .context("create WGC item for target monitor")?
    };
    eprintln!("native-helper: capture stage=wgc.item-created");
    let item_size = item.Size().context("read WGC monitor item size")?;
    let item_width = u32::try_from(item_size.Width).context("invalid WGC item width")?;
    let item_height = u32::try_from(item_size.Height).context("invalid WGC item height")?;
    checked_pixel_count(item_width, item_height)?;
    if item_width != expected_width || item_height != expected_height {
        bail!(
            "WGC item size {item_width}x{item_height} does not match monitor physical bounds {expected_width}x{expected_height}"
        );
    }

    let device = WgcDevice::create()?;
    eprintln!("native-helper: capture stage=wgc.device-created");
    let pool = FramePoolGuard(
        Direct3D11CaptureFramePool::CreateFreeThreaded(
            &device.winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            item_size,
        )
        .context("create WGC free-threaded frame pool")?,
    );
    let session = CaptureSessionGuard(
        pool.CreateCaptureSession(&item)
            .context("create WGC capture session")?,
    );
    // BitBlt does not include the hardware cursor. The cursor toggle was added
    // after WGC monitor interop, so this is best-effort on Windows 10 1903.
    let _ = session.SetIsCursorCaptureEnabled(false);
    session.StartCapture().context("start WGC capture")?;
    eprintln!("native-helper: capture stage=wgc.session-started");

    let frame = CaptureFrameGuard(wait_for_wgc_frame(&pool)?);
    eprintln!("native-helper: capture stage=wgc.frame-received");
    let content_size = frame.ContentSize().context("read WGC frame content size")?;
    let width = u32::try_from(content_size.Width).context("invalid WGC frame width")?;
    let height = u32::try_from(content_size.Height).context("invalid WGC frame height")?;
    checked_pixel_count(width, height)?;
    if width != expected_width || height != expected_height {
        bail!(
            "WGC frame size {width}x{height} does not match monitor physical bounds {expected_width}x{expected_height}"
        );
    }
    let rgba = read_wgc_rgba(&device, &frame, width, height)?;
    eprintln!("native-helper: capture stage=wgc.readback-complete");

    Ok(RawFrame {
        width,
        height,
        physical_bounds: Rect {
            x: rect.left,
            y: rect.top,
            width,
            height,
        },
        rgba,
    })
}

fn wait_for_wgc_frame(pool: &Direct3D11CaptureFramePool) -> Result<Direct3D11CaptureFrame> {
    let deadline = Instant::now() + WGC_FRAME_TIMEOUT;
    loop {
        let error = match pool.TryGetNextFrame() {
            Ok(frame) => return Ok(frame),
            Err(error) => error,
        };
        if Instant::now() >= deadline {
            bail!("WGC produced no frame before timeout (last API error: {error})");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn read_wgc_rgba(
    device: &WgcDevice,
    frame: &Direct3D11CaptureFrame,
    width: u32,
    height: u32,
) -> Result<Vec<u8>> {
    let pixels = checked_pixel_count(width, height)?;
    let surface = frame.Surface().context("get WGC frame surface")?;
    let access: IDirect3DDxgiInterfaceAccess =
        surface.cast().context("query WGC surface DXGI access")?;
    let texture: ID3D11Texture2D =
        unsafe { access.GetInterface().context("get WGC D3D11 texture")? };
    let mut description = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut description) };
    if description.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
        bail!("WGC returned an unexpected pixel format");
    }
    if description.Width < width || description.Height < height {
        bail!("WGC surface is smaller than its content");
    }

    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    description.MiscFlags = 0;
    let mut staging = None;
    unsafe {
        device
            .device
            .CreateTexture2D(&description, None, Some(&mut staging))
            .context("create WGC staging texture")?;
    }
    let staging = staging.context("D3D11 returned no WGC staging texture")?;
    unsafe { device.context.CopyResource(&staging, &texture) };
    let mapped = MappedTexture::read(&device.context, &staging)?;

    let row_bytes = usize::try_from(width)?
        .checked_mul(4)
        .context("WGC row size overflow")?;
    let row_pitch = usize::try_from(mapped.data.RowPitch)?;
    if mapped.data.pData.is_null() || row_pitch < row_bytes {
        bail!("WGC returned an invalid mapped texture");
    }
    let mapped_bytes = row_pitch
        .checked_mul(usize::try_from(description.Height)?)
        .context("WGC mapped texture size overflow")?;
    if mapped_bytes > isize::MAX as usize {
        bail!("WGC mapped texture exceeds addressable size");
    }

    let mut rgba = vec![0_u8; pixels * 4];
    let source = mapped.data.pData.cast::<u8>();
    for row in 0..usize::try_from(height)? {
        let source_offset = row
            .checked_mul(row_pitch)
            .context("WGC source row offset overflow")?;
        let target_offset = row
            .checked_mul(row_bytes)
            .context("WGC target row offset overflow")?;
        let source_row =
            unsafe { std::slice::from_raw_parts(source.add(source_offset), row_bytes) };
        let target_row = &mut rgba[target_offset..target_offset + row_bytes];
        target_row.copy_from_slice(source_row);
        for pixel in target_row.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
    }
    Ok(rgba)
}

fn dimensions_from_rect(rect: RECT) -> Result<(u32, u32, usize)> {
    let width = u32::try_from(
        rect.right
            .checked_sub(rect.left)
            .context("monitor width overflow")?,
    )
    .context("invalid monitor width")?;
    let height = u32::try_from(
        rect.bottom
            .checked_sub(rect.top)
            .context("monitor height overflow")?,
    )
    .context("invalid monitor height")?;
    let pixels = checked_pixel_count(width, height)?;
    Ok((width, height, pixels))
}

fn checked_pixel_count(width: u32, height: u32) -> Result<usize> {
    let pixels = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .context("capture pixel count overflow")?;
    if width == 0 || height == 0 || pixels > MAX_CAPTURE_PIXELS {
        bail!("capture dimensions exceed the configured limit");
    }
    Ok(pixels)
}

fn capture_rect_gdi(rect: RECT) -> Result<RawFrame> {
    let (width, height, pixels) = dimensions_from_rect(rect)?;
    eprintln!("native-helper: capture stage=gdi.begin");

    unsafe {
        let screen_dc = GetDC(HWND(0));
        if screen_dc.is_invalid() {
            bail!("GetDC failed");
        }
        let memory_dc = CreateCompatibleDC(screen_dc);
        if memory_dc.is_invalid() {
            let _ = ReleaseDC(HWND(0), screen_dc);
            bail!("CreateCompatibleDC failed");
        }
        let bitmap = CreateCompatibleBitmap(screen_dc, width as i32, height as i32);
        if bitmap.is_invalid() {
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(HWND(0), screen_dc);
            bail!("CreateCompatibleBitmap failed");
        }
        eprintln!("native-helper: capture stage=gdi.resources-created");

        let previous = SelectObject(memory_dc, HGDIOBJ(bitmap.0));
        if previous.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(memory_dc);
            let _ = ReleaseDC(HWND(0), screen_dc);
            bail!("SelectObject failed while selecting capture bitmap");
        }

        let copied = BitBlt(
            memory_dc,
            0,
            0,
            width as i32,
            height as i32,
            screen_dc,
            rect.left,
            rect.top,
            SRCCOPY | CAPTUREBLT,
        )
        .is_ok();
        if copied {
            eprintln!("native-helper: capture stage=gdi.bitblt-complete");
        }

        // A DDB must not remain selected in memory_dc when GetDIBits reads it.
        // The source DC for that read is the compatible screen DC.
        let deselected = SelectObject(memory_dc, previous);
        if deselected.is_invalid() {
            // Destroying the memory DC first releases its selected bitmap before
            // DeleteObject attempts to free the bitmap handle.
            let _ = DeleteDC(memory_dc);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = ReleaseDC(HWND(0), screen_dc);
            bail!("SelectObject failed while deselecting capture bitmap");
        }
        eprintln!("native-helper: capture stage=gdi.bitmap-deselected");

        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width as i32,
            biHeight: -(height as i32),
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };
        let mut bgra = vec![0_u8; pixels * 4];
        let rows = if copied {
            GetDIBits(
                screen_dc,
                bitmap,
                0,
                height,
                Some(bgra.as_mut_ptr().cast()),
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        if rows == height as i32 {
            eprintln!("native-helper: capture stage=gdi.readback-complete");
        }

        let bitmap_released = DeleteObject(HGDIOBJ(bitmap.0)).as_bool();
        let memory_dc_released = DeleteDC(memory_dc).as_bool();
        let screen_dc_released = ReleaseDC(HWND(0), screen_dc) != 0;
        if !copied || rows != height as i32 {
            bail!("desktop capture failed or returned an incomplete frame");
        }
        if !bitmap_released || !memory_dc_released || !screen_dc_released {
            bail!("desktop capture resource cleanup failed");
        }

        for pixel in bgra.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        Ok(RawFrame {
            width,
            height,
            physical_bounds: Rect {
                x: rect.left,
                y: rect.top,
                width,
                height,
            },
            rgba: bgra,
        })
    }
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>> {
    let expected = usize::try_from(width)?
        .checked_mul(usize::try_from(height)?)
        .and_then(|value| value.checked_mul(4))
        .context("image size overflow")?;
    if rgba.len() != expected {
        bail!("image buffer length does not match dimensions");
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, ColorType::Rgba8.into())
        .context("encode capture preview as PNG")?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_validation_rejects_overflow_and_out_of_bounds() {
        assert!(validate_crop(
            CropRect {
                x: 0,
                y: 0,
                width: 10,
                height: 10
            },
            10,
            10
        )
        .is_ok());
        assert!(validate_crop(
            CropRect {
                x: 9,
                y: 0,
                width: 2,
                height: 1
            },
            10,
            10
        )
        .is_err());
        assert!(validate_crop(
            CropRect {
                x: u32::MAX,
                y: 0,
                width: 2,
                height: 1
            },
            10,
            10
        )
        .is_err());
    }
}
