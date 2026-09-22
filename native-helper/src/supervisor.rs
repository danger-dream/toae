use crate::job::KillOnCloseJob;
use crate::protocol::{read_frame, Frame, FrameWriter, VERSION};
use crate::selection;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::BufReader;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

const DLL_NAME: &str = "AutoHotkey_H.dll";
const HELPER_VERSION: &str = env!("CARGO_PKG_VERSION");
const ACTIONS: [&str; 4] = [
    "show_translator",
    "screenshot_translate",
    "selection_translate",
    "screenshot_recognizer",
];

pub struct SupervisorOptions {
    pub protocol: u64,
    pub session_token: String,
    pub script_path: PathBuf,
    pub expected_dll_sha256: String,
    pub foreground_pid: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    v: u64,
    id: String,
    #[serde(rename = "type")]
    request_type: String,
    deadline_ms: u64,
    #[serde(default)]
    payload: Map<String, Value>,
}

pub fn run(options: SupervisorOptions) -> Result<()> {
    validate_options(&options)?;
    let _ = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
    let executable = fs::canonicalize(std::env::current_exe()?)?;
    let resource_directory = executable
        .parent()
        .context("helper executable has no parent")?;
    let dll_path = fs::canonicalize(resource_directory.join(DLL_NAME))
        .context("resolve AutoHotkey_H resource")?;
    if dll_path.parent() != Some(resource_directory) {
        bail!("AutoHotkey_H resource resolves outside the helper directory");
    }
    crate::ahk::verify_pe_x64(&dll_path)?;
    let dll_hash = format!("{:x}", Sha256::digest(fs::read(&dll_path)?));
    if dll_hash != options.expected_dll_sha256.to_ascii_lowercase() {
        bail!("AutoHotkey_H resource hash mismatch");
    }

    let writer = Arc::new(FrameWriter::new(std::io::stdout()));
    writer.json(&json!({
        "v": VERSION,
        "event": "hello",
        "result": {
            "protocol": VERSION,
            "helperVersion": HELPER_VERSION,
            "arch": "x86_64",
            "capabilities": ["selection.uia", "selection.clipboard", "capture.native-overlay", "capture.editor.in-place-translation", "capture.gdi", "image.translate.render", "ahk.worker"],
            "dllSha256": dll_hash,
            "dllVersion": "legacy-x64-version-unverified"
        }
    }))?;

    let job = Arc::new(KillOnCloseJob::create()?);
    let mut overlay = OverlayManager::default();
    overlay.ensure(&job)?;
    let manager = Arc::new(Mutex::new(AhkManager::new(
        options.session_token.clone(),
        options.script_path.clone(),
        options.expected_dll_sha256.clone(),
        options.foreground_pid,
        Arc::clone(&writer),
        Arc::clone(&job),
    )));
    let stopping = Arc::new(AtomicBool::new(false));
    start_watchdog(Arc::clone(&manager), Arc::clone(&stopping));
    let selection_requests: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let clipboard_lock = Arc::new(Mutex::new(()));
    let stdin = std::io::stdin();
    let mut reader = BufReader::new(stdin.lock());

    while let Some(frame) = read_frame(&mut reader)? {
        let value = match frame {
            Frame::Json(value) => value,
            Frame::Binary { request_id, bytes } => {
                bail!(
                    "supervisor rejects unsolicited binary frame (id length {}, {} bytes)",
                    request_id.len(),
                    bytes.len()
                );
            }
        };
        let request: Request = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(error) => {
                eprintln!("native-helper: rejected malformed request: {error}");
                continue;
            }
        };
        if let Err(error) = validate_request(&request) {
            send_error(&writer, &request.id, "invalid_request", &error.to_string())?;
            continue;
        }
        if request.request_type == "shutdown" {
            stopping.store(true, Ordering::SeqCst);
            cancel_selection_requests(&selection_requests);
            wait_for_selection_requests(&selection_requests, Duration::from_millis(1_800));
            overlay.stop();
            manager
                .lock()
                .map_err(|_| anyhow::anyhow!("AHK manager lock poisoned"))?
                .stop()?;
            send_ok(&writer, &request.id, json!({}))?;
            break;
        }
        if request.request_type == "cancel" {
            if let Ok(request_id) = bounded_payload_string(&request.payload, "requestId", 128) {
                if let Ok(requests) = selection_requests.lock() {
                    if let Some(cancelled) = requests.get(request_id) {
                        cancelled.store(true, Ordering::SeqCst);
                    }
                }
            }
            send_ok(&writer, &request.id, json!({}))?;
            continue;
        }
        if request.request_type == "capture.editor.continue" {
            let input = if request.payload.get("binary").and_then(Value::as_bool) == Some(true) {
                match read_frame(&mut reader)? {
                    Some(Frame::Binary { request_id, bytes }) if request_id == request.id => {
                        Some(bytes)
                    }
                    Some(_) => bail!("translated overlay binary frame is invalid"),
                    None => bail!("helper input ended before translated overlay bytes"),
                }
            } else {
                None
            };
            let session_id = bounded_payload_string(&request.payload, "sessionId", 128)?;
            let translation_error = request
                .payload
                .get("translationError")
                .and_then(Value::as_str)
                .map(|value| value.chars().take(500).collect::<String>());
            let result = overlay.continue_capture(
                &request.id,
                session_id,
                translation_error.as_deref(),
                input.as_deref(),
                request.deadline_ms,
                &job,
            );
            match result {
                Ok(capture) => {
                    send_ok(&writer, &request.id, capture.metadata)?;
                    if let Some(bytes) = capture.bytes {
                        writer.binary(&request.id, &bytes)?;
                    }
                }
                Err(error) => {
                    send_error(&writer, &request.id, error_code(&error), &error.to_string())?;
                }
            }
            continue;
        }
        if request.request_type == "image.translate.render" {
            let input = match read_frame(&mut reader)? {
                Some(Frame::Binary { request_id, bytes }) if request_id == request.id => bytes,
                Some(_) => bail!("image translation render binary frame is invalid"),
                None => bail!("helper input ended before image translation bytes"),
            };
            let result = (|| -> Result<crate::compositor::RenderOutput> {
                if request.payload.get("binary").and_then(Value::as_bool) != Some(true) {
                    bail!("image translation render request is missing binary marker");
                }
                let spec: crate::compositor::RenderSpec =
                    serde_json::from_value(Value::Object(request.payload.clone()))
                        .context("parse image translation render specification")?;
                crate::compositor::render(&input, spec)
            })();
            match result {
                Ok(output) => {
                    send_ok(
                        &writer,
                        &request.id,
                        json!({
                            "binary": true,
                            "mime": "image/png",
                            "renderedRegions": output.rendered_regions,
                            "skippedRegions": output.skipped_regions
                        }),
                    )?;
                    writer.binary(&request.id, &output.bytes)?;
                }
                Err(error) => {
                    send_error(
                        &writer,
                        &request.id,
                        "image_render_failed",
                        &error.to_string(),
                    )?;
                }
            }
            continue;
        }
        if request.request_type == "selection.get" {
            spawn_selection_request(
                request.id.clone(),
                request.deadline_ms,
                options.session_token.clone(),
                Arc::clone(&writer),
                Arc::clone(&selection_requests),
                Arc::clone(&clipboard_lock),
            )?;
            continue;
        }
        if let Err(error) = dispatch(&request, &writer, &manager, &mut overlay, &job) {
            send_error(&writer, &request.id, error_code(&error), &error.to_string())?;
        }
    }

    stopping.store(true, Ordering::SeqCst);
    cancel_selection_requests(&selection_requests);
    wait_for_selection_requests(&selection_requests, Duration::from_millis(1_800));
    overlay.stop();
    let _ = manager.lock().map(|mut value| value.stop());
    drop(job);
    Ok(())
}

type SelectionRequests = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

fn spawn_selection_request(
    request_id: String,
    deadline_ms: u64,
    session_token: String,
    writer: Arc<FrameWriter<std::io::Stdout>>,
    requests: SelectionRequests,
    clipboard_lock: Arc<Mutex<()>>,
) -> Result<()> {
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut active = requests
            .lock()
            .map_err(|_| anyhow::anyhow!("selection request lock poisoned"))?;
        if active.contains_key(&request_id) {
            bail!("duplicate selection request id");
        }
        active.insert(request_id.clone(), Arc::clone(&cancelled));
    }

    let worker_id = request_id.clone();
    let cleanup_id = request_id;
    let cleanup_requests = Arc::clone(&requests);
    let spawn_result = thread::Builder::new()
        .name("selection-request".to_owned())
        .spawn(move || {
            let result = selection::get_selected_text(
                deadline_ms,
                &session_token,
                &cancelled,
                &clipboard_lock,
            );
            if cancelled.load(Ordering::SeqCst) {
                let _ = send_error(
                    &writer,
                    &worker_id,
                    "selection_cancelled",
                    "selection request cancelled",
                );
            } else {
                match result {
                    Ok(selected) => {
                        let _ = send_ok(
                            &writer,
                            &worker_id,
                            json!({
                                "text": selected.text,
                                "method": selected.method,
                                "clipboardRestored": selected.clipboard_restored
                            }),
                        );
                    }
                    Err(error) => {
                        let _ =
                            send_error(&writer, &worker_id, error_code(&error), &error.to_string());
                    }
                }
            }
            if let Ok(mut active) = cleanup_requests.lock() {
                active.remove(&worker_id);
            }
        });

    if let Err(error) = spawn_result {
        if let Ok(mut active) = requests.lock() {
            active.remove(&cleanup_id);
        }
        return Err(error).context("start selection request worker");
    }
    Ok(())
}

fn cancel_selection_requests(requests: &SelectionRequests) {
    if let Ok(active) = requests.lock() {
        for cancelled in active.values() {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
}

fn wait_for_selection_requests(requests: &SelectionRequests, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match requests.lock() {
            Ok(active) if active.is_empty() => return,
            Err(_) => return,
            _ => thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn dispatch(
    request: &Request,
    writer: &Arc<FrameWriter<std::io::Stdout>>,
    manager: &Arc<Mutex<AhkManager>>,
    overlay: &mut OverlayManager,
    job: &KillOnCloseJob,
) -> Result<()> {
    match request.request_type.as_str() {
        "capture.start" => {
            let action = request
                .payload
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if action != "screenshot_translate" && action != "screenshot_recognizer" {
                bail!("capture action is invalid");
            }
            let editor = request
                .payload
                .get("editor")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if editor && action != "screenshot_translate" {
                bail!("capture editor is only available for screenshot translation");
            }
            let capture = overlay.capture(&request.id, action, editor, request.deadline_ms, job)?;
            send_ok(writer, &request.id, capture.metadata)?;
            if let Some(bytes) = capture.bytes {
                writer.binary(&request.id, &bytes)?;
            }
            Ok(())
        }
        "ahk.start" => {
            let status = manager
                .lock()
                .map_err(|_| anyhow::anyhow!("AHK manager lock poisoned"))?
                .start()?;
            send_ok(writer, &request.id, status)
        }
        "ahk.stop" => {
            let status = manager
                .lock()
                .map_err(|_| anyhow::anyhow!("AHK manager lock poisoned"))?
                .stop()?;
            send_ok(writer, &request.id, status)
        }
        "ahk.reload" => {
            let status = manager
                .lock()
                .map_err(|_| anyhow::anyhow!("AHK manager lock poisoned"))?
                .reload()?;
            send_ok(writer, &request.id, status)
        }
        "ahk.status" => {
            let status = manager
                .lock()
                .map_err(|_| anyhow::anyhow!("AHK manager lock poisoned"))?
                .status();
            send_ok(writer, &request.id, status)
        }
        _ => bail!("unsupported native helper request type"),
    }
}

struct OverlayCapture {
    metadata: Value,
    bytes: Option<Vec<u8>>,
}

#[derive(Default)]
struct OverlayManager {
    process: Option<OverlayProcess>,
}

impl OverlayManager {
    fn ensure(&mut self, job: &KillOnCloseJob) -> Result<()> {
        if self
            .process
            .as_mut()
            .is_some_and(|process| process.running())
        {
            return Ok(());
        }
        self.stop();
        self.process = Some(OverlayProcess::spawn(job)?);
        Ok(())
    }

    fn capture(
        &mut self,
        request_id: &str,
        action: &str,
        editor: bool,
        deadline_ms: u64,
        job: &KillOnCloseJob,
    ) -> Result<OverlayCapture> {
        self.ensure(job)?;
        let result = self
            .process
            .as_mut()
            .context("native capture overlay is unavailable")?
            .capture(request_id, action, editor, deadline_ms);
        if result.is_err() {
            self.stop();
        }
        result
    }

    fn continue_capture(
        &mut self,
        request_id: &str,
        session_id: &str,
        translation_error: Option<&str>,
        translated_png: Option<&[u8]>,
        deadline_ms: u64,
        job: &KillOnCloseJob,
    ) -> Result<OverlayCapture> {
        self.ensure(job)?;
        let result = self
            .process
            .as_mut()
            .context("native capture overlay is unavailable")?
            .continue_capture(
                request_id,
                session_id,
                translation_error,
                translated_png,
                deadline_ms,
            );
        if result.is_err() {
            self.stop();
        }
        result
    }

    fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            process.terminate();
        }
    }
}

struct OverlayProcess {
    child: Option<Child>,
    writer: FrameWriter<ChildStdin>,
    reader: BufReader<ChildStdout>,
}

impl OverlayProcess {
    fn spawn(job: &KillOnCloseJob) -> Result<Self> {
        let executable = fs::canonicalize(std::env::current_exe()?)?;
        let mut child = Command::new(executable)
            .arg("--capture-overlay")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .creation_flags(CREATE_NO_WINDOW.0)
            .spawn()
            .context("start persistent native capture overlay")?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error).context("assign native capture overlay to job");
        }
        let stdin = child
            .stdin
            .take()
            .context("native overlay stdin is unavailable")?;
        let stdout = child
            .stdout
            .take()
            .context("native overlay stdout is unavailable")?;
        let mut reader = BufReader::new(stdout);
        match read_frame(&mut reader)? {
            Some(Frame::Json(value))
                if value.get("v").and_then(Value::as_u64) == Some(VERSION)
                    && value.get("event").and_then(Value::as_str) == Some("overlay.ready") => {}
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                bail!("native capture overlay did not become ready");
            }
        }
        eprintln!("native-helper: persistent native capture overlay ready");
        Ok(Self {
            child: Some(child),
            writer: FrameWriter::new(stdin),
            reader,
        })
    }

    fn running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        matches!(child.try_wait(), Ok(None))
    }

    fn capture(
        &mut self,
        request_id: &str,
        action: &str,
        editor: bool,
        deadline_ms: u64,
    ) -> Result<OverlayCapture> {
        self.writer.json(&json!({
            "v": VERSION,
            "id": request_id,
            "type": "capture.start",
            "deadlineMs": deadline_ms,
            "payload": { "action": action, "editor": editor }
        }))?;
        self.read_capture_response(request_id)
    }

    fn continue_capture(
        &mut self,
        request_id: &str,
        session_id: &str,
        translation_error: Option<&str>,
        translated_png: Option<&[u8]>,
        deadline_ms: u64,
    ) -> Result<OverlayCapture> {
        self.writer.json(&json!({
            "v": VERSION,
            "id": request_id,
            "type": "capture.editor.continue",
            "deadlineMs": deadline_ms,
            "payload": {
                "sessionId": session_id,
                "translationError": translation_error,
                "binary": translated_png.is_some()
            }
        }))?;
        if let Some(bytes) = translated_png {
            self.writer.binary(request_id, bytes)?;
        }
        self.read_capture_response(request_id)
    }

    fn read_capture_response(&mut self, request_id: &str) -> Result<OverlayCapture> {
        let response = match read_frame(&mut self.reader)? {
            Some(Frame::Json(value)) => value,
            Some(Frame::Binary { .. }) => bail!("native overlay sent binary before metadata"),
            None => bail!("native overlay exited before capture completed"),
        };
        if response.get("v").and_then(Value::as_u64) != Some(VERSION)
            || response.get("id").and_then(Value::as_str) != Some(request_id)
        {
            bail!("native overlay sent incompatible capture metadata");
        }
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            let message = response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("native overlay capture failed");
            bail!("{message}");
        }
        let metadata = response
            .get("result")
            .cloned()
            .context("native overlay capture metadata is missing")?;
        let expects_binary = metadata
            .get("binary")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let bytes = if expects_binary {
            match read_frame(&mut self.reader)? {
                Some(Frame::Binary {
                    request_id: id,
                    bytes,
                }) if id == request_id => Some(bytes),
                Some(_) => bail!("native overlay sent an invalid capture binary frame"),
                None => bail!("native overlay exited before sending capture bytes"),
            }
        } else {
            None
        };
        Ok(OverlayCapture { metadata, bytes })
    }

    fn terminate(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for OverlayProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

struct Worker {
    child: Child,
}

struct AhkManager {
    session_token: String,
    script_path: PathBuf,
    expected_dll_sha256: String,
    foreground_pid: u32,
    writer: Arc<FrameWriter<std::io::Stdout>>,
    job: Arc<KillOnCloseJob>,
    worker: Option<Worker>,
    desired_running: bool,
    restart_failures: u8,
    next_restart: Instant,
    last_error: Option<String>,
}

impl AhkManager {
    fn new(
        session_token: String,
        script_path: PathBuf,
        expected_dll_sha256: String,
        foreground_pid: u32,
        writer: Arc<FrameWriter<std::io::Stdout>>,
        job: Arc<KillOnCloseJob>,
    ) -> Self {
        Self {
            session_token,
            script_path,
            expected_dll_sha256,
            foreground_pid,
            writer,
            job,
            worker: None,
            desired_running: false,
            restart_failures: 0,
            next_restart: Instant::now(),
            last_error: None,
        }
    }

    fn start(&mut self) -> Result<Value> {
        self.desired_running = true;
        if self.worker_running() {
            return Ok(self.status());
        }
        self.worker = None;
        match self.spawn_candidate() {
            Ok(worker) => {
                self.worker = Some(worker);
                self.restart_failures = 0;
                self.last_error = None;
                Ok(self.status())
            }
            Err(error) => {
                self.desired_running = false;
                self.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    fn stop(&mut self) -> Result<Value> {
        self.desired_running = false;
        self.restart_failures = 0;
        if let Some(mut worker) = self.worker.take() {
            let _ = worker.child.kill();
            let _ = worker.child.wait();
        }
        self.last_error = None;
        Ok(self.status())
    }

    fn reload(&mut self) -> Result<Value> {
        if !self.desired_running {
            return Ok(self.status());
        }
        let candidate = self
            .spawn_candidate()
            .context("new AutoHotkey script failed readiness check")?;
        if let Some(mut previous) = self.worker.replace(candidate) {
            let _ = previous.child.kill();
            let _ = previous.child.wait();
        }
        self.restart_failures = 0;
        self.last_error = None;
        Ok(self.status())
    }

    fn status(&mut self) -> Value {
        let running = self.worker_running();
        let state = if running {
            "running"
        } else if self.desired_running && self.restart_failures >= 3 {
            "error"
        } else if self.desired_running {
            "starting"
        } else {
            "stopped"
        };
        let mut status = json!({
            "enabled": self.desired_running,
            "running": running,
            "state": state
        });
        if let Some(message) = &self.last_error {
            status["message"] = Value::String(message.chars().take(500).collect());
        }
        status
    }

    fn tick(&mut self) {
        if self.worker.is_some() && !self.worker_running() {
            self.worker = None;
            if self.desired_running {
                self.next_restart =
                    Instant::now() + Duration::from_millis(250_u64 << self.restart_failures.min(3));
            }
        }
        if !self.desired_running
            || self.worker.is_some()
            || self.restart_failures >= 3
            || Instant::now() < self.next_restart
        {
            return;
        }
        match self.spawn_candidate() {
            Ok(worker) => {
                self.worker = Some(worker);
                self.restart_failures = 0;
                self.last_error = None;
                let _ = self.writer.json(&json!({ "v": VERSION, "event": "ahk.log", "line": "AutoHotkey worker restarted" }));
            }
            Err(error) => {
                self.restart_failures = self.restart_failures.saturating_add(1);
                self.next_restart =
                    Instant::now() + Duration::from_secs(1_u64 << self.restart_failures.min(3));
                self.last_error = Some(error.to_string());
                let _ = self.writer.json(&json!({ "v": VERSION, "event": "ahk.log", "line": "AutoHotkey worker restart failed" }));
            }
        }
    }

    fn worker_running(&mut self) -> bool {
        let Some(worker) = self.worker.as_mut() else {
            return false;
        };
        matches!(worker.child.try_wait(), Ok(None))
    }

    fn spawn_candidate(&self) -> Result<Worker> {
        let executable = fs::canonicalize(std::env::current_exe()?)?;
        let mut child = Command::new(executable)
            .arg("--hook")
            .arg("--session-token")
            .arg(&self.session_token)
            .arg("--script")
            .arg(&self.script_path)
            .arg("--dll-sha256")
            .arg(&self.expected_dll_sha256)
            .arg("--foreground-pid")
            .arg(self.foreground_pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW.0)
            .spawn()
            .context("start AutoHotkey hook worker")?;
        if let Err(error) = self.job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stdout = child
            .stdout
            .take()
            .context("AutoHotkey worker stdout is unavailable")?;
        let writer = Arc::clone(&self.writer);
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut ready_sent = false;
            loop {
                match read_frame(&mut reader) {
                    Ok(Some(Frame::Json(value))) => {
                        let event = value.get("event").and_then(Value::as_str);
                        if event == Some("hook.ready")
                            && value.get("running").and_then(Value::as_bool) == Some(true)
                        {
                            if !ready_sent {
                                let _ = ready_sender.send(true);
                                ready_sent = true;
                            }
                        } else if event == Some("action") {
                            if let Some(action) = value.get("action").and_then(Value::as_str) {
                                if ACTIONS.contains(&action) {
                                    let _ = writer.json(&json!({ "v": VERSION, "event": "action", "action": action }));
                                }
                            }
                        }
                    }
                    Ok(Some(_)) => {}
                    Ok(None) | Err(_) => {
                        if !ready_sent {
                            let _ = ready_sender.send(false);
                        }
                        break;
                    }
                }
            }
        });
        match ready_receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(true) => Ok(Worker { child }),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                bail!("AutoHotkey hook worker did not become ready")
            }
        }
    }
}

fn start_watchdog(manager: Arc<Mutex<AhkManager>>, stopping: Arc<AtomicBool>) {
    thread::spawn(move || {
        while !stopping.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(250));
            if let Ok(mut manager) = manager.lock() {
                manager.tick();
            }
        }
    });
}

fn validate_options(options: &SupervisorOptions) -> Result<()> {
    if options.protocol != VERSION {
        bail!("unsupported protocol version");
    }
    if options.session_token.len() != 64
        || !options
            .session_token
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("invalid helper session token");
    }
    if options.expected_dll_sha256.len() != 64
        || !options
            .expected_dll_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        bail!("invalid DLL hash argument");
    }
    if !options.script_path.is_absolute() {
        bail!("script path must be absolute");
    }
    if options.foreground_pid == 0 {
        bail!("foreground process id must be non-zero");
    }
    Ok(())
}

fn validate_request(request: &Request) -> Result<()> {
    if request.v != VERSION {
        bail!("request protocol version is invalid");
    }
    if !(8..=128).contains(&request.id.len())
        || !request
            .id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("request id is invalid");
    }
    if !(100..=180_000).contains(&request.deadline_ms) {
        bail!("request deadline is invalid");
    }
    if request.request_type.len() > 64 {
        bail!("request type is invalid");
    }
    Ok(())
}

fn bounded_payload_string<'a>(
    payload: &'a Map<String, Value>,
    key: &str,
    max: usize,
) -> Result<&'a str> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .with_context(|| format!("payload field {key} is missing"))?;
    if value.is_empty() || value.len() > max {
        bail!("payload field {key} is invalid");
    }
    Ok(value)
}

fn send_ok(writer: &Arc<FrameWriter<std::io::Stdout>>, id: &str, result: Value) -> Result<()> {
    writer.json(&json!({ "v": VERSION, "id": id, "ok": true, "result": result }))
}

fn send_error(
    writer: &Arc<FrameWriter<std::io::Stdout>>,
    id: &str,
    code: &str,
    message: &str,
) -> Result<()> {
    writer.json(&json!({
        "v": VERSION,
        "id": id,
        "ok": false,
        "error": {
            "code": code,
            "message": message.chars().take(500).collect::<String>()
        }
    }))
}

fn error_code(error: &anyhow::Error) -> &'static str {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("clipboard") || message.contains("uipi") || message.contains("ctrl+c") {
        "selection_copy_blocked"
    } else if message.contains("capture") || message.contains("monitor") {
        "capture_failed"
    } else if message.contains("autohotkey") || message.contains("dll") {
        "ahk_failed"
    } else {
        "native_request_failed"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_validation_is_allowlisted_by_shape() {
        let valid = Request {
            v: 1,
            id: "12345678".into(),
            request_type: "selection.get".into(),
            deadline_ms: 1500,
            payload: Map::new(),
        };
        assert!(validate_request(&valid).is_ok());
        let invalid = Request {
            id: "../bad".into(),
            ..valid
        };
        assert!(validate_request(&invalid).is_err());
    }
}
