use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

type Pending = HashMap<u64, oneshot::Sender<Value>>;
const PUBLIC_DASHSCOPE_BASE_URL: &str = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const KEYRING_SERVICE: &str = "ai.papers2innovations.desktop";
const KEYRING_USER: &str = "stronghold-vault-v1";

struct EngineInner {
    child: Mutex<Option<Child>>,
    writer: Mutex<Option<ChildStdin>>,
    startup: Mutex<()>,
    generation: AtomicU64,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
    ocr: Mutex<OcrConfig>,
    ocr_limiter: OcrLimiter,
    allowed_ocr_roots: Mutex<Vec<PathBuf>>,
}

#[derive(Clone, Default)]
struct OcrConfig {
    api_key: Option<String>,
    workspace_id: Option<String>,
    base_url: Option<String>,
    consent: bool,
    workspace_required: bool,
}

#[derive(Default)]
struct WatcherState(Mutex<Vec<RecommendedWatcher>>);

#[derive(Default)]
struct OcrLimiter {
    active: Mutex<usize>,
    available: Condvar,
}

struct OcrPermit<'a>(&'a OcrLimiter);

impl OcrLimiter {
    fn acquire(&self) -> Result<OcrPermit<'_>, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "OCR limiter lock poisoned")?;
        while *active >= 2 {
            active = self
                .available
                .wait(active)
                .map_err(|_| "OCR limiter lock poisoned")?;
        }
        *active += 1;
        Ok(OcrPermit(self))
    }
}

impl Drop for OcrPermit<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.active.lock() {
            *active = active.saturating_sub(1);
            self.0.available.notify_one();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcrRequest {
    image_path: String,
    model: String,
    page: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialInput {
    api_key: String,
    #[serde(default)]
    workspace_id: Option<String>,
    base_url: Option<String>,
    consent: bool,
}

#[derive(Clone)]
struct Engine(Arc<EngineInner>);

impl Engine {
    fn new() -> Self {
        Self(Arc::new(EngineInner {
            child: Mutex::new(None),
            writer: Mutex::new(None),
            startup: Mutex::new(()),
            generation: AtomicU64::new(0),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            ocr: Mutex::new(OcrConfig::default()),
            ocr_limiter: OcrLimiter::default(),
            allowed_ocr_roots: Mutex::new(Vec::new()),
        }))
    }

    fn allow_library_root(&self, root: &str) -> Result<(), String> {
        let library_root = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| format!("Cannot register library root: {error}"))?;
        let cache_root = library_root.join(".p2i/cache/ocr");
        let mut allowed = self
            .0
            .allowed_ocr_roots
            .lock()
            .map_err(|_| "OCR path lock poisoned")?;
        if !allowed.contains(&cache_root) {
            allowed.push(cache_root);
        }
        Ok(())
    }

    fn is_allowed_ocr_path(&self, path: &Path) -> Result<bool, String> {
        let allowed = self
            .0
            .allowed_ocr_roots
            .lock()
            .map_err(|_| "OCR path lock poisoned")?;
        Ok(allowed.iter().any(|root| path.starts_with(root)))
    }

    fn engine_command() -> (Command, PathBuf) {
        let repo_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let service_dir = repo_dir.join("services/paper-engine");
        if let Ok(binary) = std::env::var("P2I_ENGINE_BIN") {
            let mut command = Command::new(binary);
            command.arg("rpc");
            command.env("PYTHONIOENCODING", "utf-8");
            command.env("PYTHONUTF8", "1");
            return (command, std::env::temp_dir());
        }
        let executable_name = if cfg!(windows) {
            "p2i-paper-engine.exe"
        } else {
            "p2i-paper-engine"
        };
        if let Ok(current_exe) = std::env::current_exe() {
            if let Some(binary) = current_exe
                .parent()
                .map(|parent| parent.join(executable_name))
            {
                if binary.is_file() {
                    let mut command = Command::new(binary);
                    command.arg("rpc");
                    command.env("PYTHONIOENCODING", "utf-8");
                    command.env("PYTHONUTF8", "1");
                    return (command, std::env::temp_dir());
                }
            }
        }
        let virtualenv_python = if cfg!(windows) {
            repo_dir.join(".venv/Scripts/python.exe")
        } else {
            repo_dir.join(".venv/bin/python")
        };
        let mut command = if virtualenv_python.is_file() {
            Command::new(virtualenv_python)
        } else {
            Command::new("python")
        };
        command.args(["-X", "utf8", "-m", "p2i_engine", "rpc"]);
        command.env("PYTHONPATH", &service_dir);
        command.env("PYTHONIOENCODING", "utf-8");
        command.env("PYTHONUTF8", "1");
        (command, service_dir)
    }

    fn ensure_started(&self, app: AppHandle) -> Result<(), String> {
        let _startup = self
            .0
            .startup
            .lock()
            .map_err(|_| "engine startup lock poisoned")?;
        if self
            .0
            .writer
            .lock()
            .map_err(|_| "engine lock poisoned")?
            .is_some()
        {
            return Ok(());
        }
        let (mut command, working_dir) = Self::engine_command();
        std::fs::create_dir_all(&working_dir)
            .map_err(|error| format!("failed to prepare paper engine work directory: {error}"))?;
        let mut child = command
            .current_dir(working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_no_window()
            .spawn()
            .map_err(|error| format!("failed to start paper engine: {error}"))?;
        let stdin = child.stdin.take().ok_or("paper engine stdin unavailable")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("paper engine stdout unavailable")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("paper engine stderr unavailable")?;
        let generation = self.0.generation.fetch_add(1, Ordering::Relaxed) + 1;
        *self.0.writer.lock().map_err(|_| "engine lock poisoned")? = Some(stdin);
        *self.0.child.lock().map_err(|_| "engine lock poisoned")? = Some(child);

        let reader_engine = self.clone();
        let reader_app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message
                    .get("method")
                    .and_then(Value::as_str)
                    .is_some_and(|method| method.starts_with("host."))
                    && message.get("id").is_some()
                {
                    let host_engine = reader_engine.clone();
                    std::thread::spawn(move || host_engine.handle_host_request(message));
                    continue;
                }
                if message.get("method").is_some() {
                    let _ = reader_app.emit("engine-notification", &message);
                    continue;
                }
                let Some(id) = message.get("id").and_then(Value::as_u64) else {
                    continue;
                };
                if let Ok(mut pending) = reader_engine.0.pending.lock() {
                    if let Some(sender) = pending.remove(&id) {
                        let _ = sender.send(message);
                    }
                }
            }
            if reader_engine.0.generation.load(Ordering::Relaxed) != generation {
                return;
            }
            if let Ok(mut writer) = reader_engine.0.writer.lock() {
                *writer = None;
            }
            if let Ok(mut child) = reader_engine.0.child.lock() {
                *child = None;
            }
            if let Ok(mut pending) = reader_engine.0.pending.lock() {
                for (_, sender) in pending.drain() {
                    let _ = sender.send(json!({
                        "error": { "message": "paper engine exited before replying" }
                    }));
                }
            }
            let _ = reader_app.emit("engine-exited", json!({ "restartable": true }));
            for _ in 0..3 {
                std::thread::sleep(Duration::from_secs(1));
                if reader_engine.ensure_started(reader_app.clone()).is_ok() {
                    let _ = reader_app.emit("engine-restarted", json!({ "ok": true }));
                    break;
                }
            }
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = app.emit("engine-log", json!({ "level": "error", "message": line }));
            }
        });
        Ok(())
    }

    fn send_raw(&self, value: &Value) -> Result<(), String> {
        let encoded = serde_json::to_string(value).map_err(|error| error.to_string())?;
        self.0
            .writer
            .lock()
            .map_err(|_| "engine lock poisoned")?
            .as_mut()
            .ok_or("paper engine is not running")?
            .write_all(format!("{encoded}\n").as_bytes())
            .map_err(|error| format!("failed to write to paper engine: {error}"))
    }

    fn handle_host_request(&self, message: Value) {
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let response = if method == "host.ocr_page" {
            match serde_json::from_value::<OcrRequest>(
                message.get("params").cloned().unwrap_or_default(),
            ) {
                Ok(request) => match self.ocr_page(request) {
                    Ok(result) => json!({"jsonrpc":"2.0", "id":id, "result":result}),
                    Err(error) => {
                        json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32010,"message":error}})
                    }
                },
                Err(error) => {
                    json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32602,"message":error.to_string()}})
                }
            }
        } else {
            json!({"jsonrpc":"2.0", "id":id, "error":{"code":-32601,"message":"Unknown host method"}})
        };
        let _ = self.send_raw(&response);
    }

    fn ocr_page(&self, request: OcrRequest) -> Result<Value, String> {
        let config = self
            .0
            .ocr
            .lock()
            .map_err(|_| "OCR config lock poisoned")?
            .clone();
        if !config.consent {
            return Err("Remote OCR consent has not been granted".into());
        }
        if config.workspace_required {
            return Err("This Qwen account requires a business workspace ID".into());
        }
        let api_key = config
            .api_key
            .as_deref()
            .ok_or("Qwen API key is not configured")?;
        let image_path = PathBuf::from(&request.image_path)
            .canonicalize()
            .map_err(|error| format!("OCR image is unavailable: {error}"))?;
        if !self.is_allowed_ocr_path(&image_path)? {
            return Err("OCR image path is outside the approved cache".into());
        }
        let image = std::fs::read(&image_path)
            .map_err(|error| format!("Cannot read OCR image: {error}"))?;
        if image.len() > 20 * 1024 * 1024 {
            return Err("OCR image exceeds the 20 MB safety limit".into());
        }
        let base_url = ocr_base_url(&config);
        let body = json!({
            "model": request.model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type":"text","text":format!("Transcribe page {} as faithful Markdown. Preserve headings, formulas, lists, and tables. Do not summarize or add commentary.", request.page)},
                    {"type":"image_url","image_url":{"url":format!("data:image/jpeg;base64,{}", BASE64.encode(image))}}
                ]
            }],
            "temperature": 0,
            "stream": false
        });
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|error| error.to_string())?;
        let _permit = self.0.ocr_limiter.acquire()?;
        let mut last_error = String::new();
        for (attempt, delay) in [0_u64, 2, 4, 8].into_iter().enumerate() {
            if delay > 0 {
                std::thread::sleep(Duration::from_secs(delay));
            }
            let response = client
                .post(format!(
                    "{}/chat/completions",
                    base_url.trim_end_matches('/')
                ))
                .bearer_auth(api_key)
                .json(&body)
                .send();
            match response {
                Ok(response) if response.status().is_success() => {
                    let payload: Value = response.json().map_err(|error| error.to_string())?;
                    let markdown = payload
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .ok_or("Qwen response did not contain Markdown")?;
                    return Ok(json!({
                        "markdown": markdown,
                        "alignmentConfidence": 0.0,
                        "usage": {
                            "inputTokens": payload.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                            "outputTokens": payload.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0)
                        }
                    }));
                }
                Ok(response) => {
                    let status = response.status();
                    last_error = format!("Qwen returned HTTP {status}");
                    if status.as_u16() != 429 && !status.is_server_error() {
                        break;
                    }
                }
                Err(error) => last_error = format!("Qwen request failed: {error}"),
            }
            if attempt >= 3 {
                break;
            }
        }
        Err(last_error)
    }

    async fn call(&self, app: AppHandle, method: String, params: Value) -> Result<Value, String> {
        self.ensure_started(app)?;
        let id = self.0.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.0
            .pending
            .lock()
            .map_err(|_| "engine lock poisoned")?
            .insert(id, sender);
        let request = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let encoded = serde_json::to_string(&request).map_err(|error| error.to_string())?;
        let write_result = self
            .0
            .writer
            .lock()
            .map_err(|_| "engine lock poisoned")?
            .as_mut()
            .ok_or("paper engine is not running")?
            .write_all(format!("{encoded}\n").as_bytes());
        if let Err(error) = write_result {
            self.0
                .pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id));
            return Err(format!("failed to write to paper engine: {error}"));
        }
        let response = match tokio::time::timeout(Duration::from_secs(20), receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => return Err("paper engine stopped before replying".into()),
            Err(_) => {
                if let Ok(mut pending) = self.0.pending.lock() {
                    pending.remove(&id);
                }
                return Err("paper engine did not respond within 20 seconds".into());
            }
        };
        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("paper engine error")
                .to_owned());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }
}

#[cfg(target_os = "windows")]
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(target_os = "windows")]
impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x08000000)
    }
}

#[cfg(not(target_os = "windows"))]
trait NoWindow {
    fn creation_flags_no_window(&mut self) -> &mut Self;
}

#[cfg(not(target_os = "windows"))]
impl NoWindow for Command {
    fn creation_flags_no_window(&mut self) -> &mut Self {
        self
    }
}

#[tauri::command]
async fn rpc_call(
    app: AppHandle,
    engine: State<'_, Engine>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    if let Some(root) = params.get("root").and_then(Value::as_str) {
        engine.allow_library_root(root)?;
    }
    engine.call(app, method, params).await
}

#[tauri::command]
fn credential_set(engine: State<'_, Engine>, input: CredentialInput) -> Result<(), String> {
    let mut config = engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")?;
    *config = OcrConfig {
        api_key: Some(input.api_key),
        workspace_id: input.workspace_id.filter(|value| !value.trim().is_empty()),
        base_url: input.base_url.filter(|value| !value.trim().is_empty()),
        consent: input.consent,
        workspace_required: false,
    };
    Ok(())
}

#[tauri::command]
fn credential_delete(engine: State<'_, Engine>) -> Result<(), String> {
    *engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")? = OcrConfig::default();
    Ok(())
}

#[tauri::command]
fn ocr_consent_set(engine: State<'_, Engine>, consent: bool) -> Result<(), String> {
    engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")?
        .consent = consent;
    Ok(())
}

#[tauri::command]
fn qwen_test_connection(engine: State<'_, Engine>) -> Result<Value, String> {
    let config = engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")?
        .clone();
    let api_key = config
        .api_key
        .as_deref()
        .ok_or("Qwen API key is not configured")?;
    let base_url = ocr_base_url(&config);
    let response = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?
        .get(format!("{}/models", base_url.trim_end_matches('/')))
        .bearer_auth(api_key)
        .send()
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().unwrap_or_default().to_lowercase();
    let requires_workspace = !status.is_success()
        && config.workspace_id.is_none()
        && (body.contains("workspace") || body.contains("business space"));
    engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")?
        .workspace_required = requires_workspace;
    Ok(json!({
        "ok": status.is_success(),
        "status": status.as_u16(),
        "requiresWorkspace": requires_workspace
    }))
}

#[tauri::command]
fn ocr_status(engine: State<'_, Engine>) -> Result<Value, String> {
    let config = engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")?;
    Ok(json!({
        "configured": config.api_key.is_some(),
        "consent": config.consent,
        "workspaceConfigured": config.workspace_id.is_some(),
        "workspaceRequired": config.workspace_required,
        "model": "qwen3.5-ocr",
        "baseUrl": ocr_base_url(&config)
    }))
}

fn ocr_base_url(config: &OcrConfig) -> String {
    if let Some(base_url) = config
        .base_url
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return base_url.trim_end_matches('/').to_owned();
    }
    if let Some(workspace) = config
        .workspace_id
        .as_ref()
        .filter(|value| !value.trim().is_empty())
    {
        return format!("https://{workspace}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
    }
    PUBLIC_DASHSCOPE_BASE_URL.to_owned()
}

#[tauri::command]
fn stronghold_password() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("Cannot access the system credential store: {error}"))?;
    match entry.get_password() {
        Ok(password) => Ok(password),
        Err(keyring::Error::NoEntry) => {
            let mut secret = [0_u8; 32];
            getrandom::fill(&mut secret)
                .map_err(|error| format!("Cannot generate a Stronghold key: {error}"))?;
            let password = BASE64.encode(secret);
            entry
                .set_password(&password)
                .map_err(|error| format!("Cannot save the Stronghold key: {error}"))?;
            Ok(password)
        }
        Err(error) => Err(format!("Cannot unlock the Stronghold key: {error}")),
    }
}

#[tauri::command]
fn watch_library(
    app: AppHandle,
    engine: State<'_, Engine>,
    watchers: State<'_, WatcherState>,
    root: String,
) -> Result<(), String> {
    engine.allow_library_root(&root)?;
    let papers_dir = PathBuf::from(&root)
        .join("Papers")
        .canonicalize()
        .map_err(|error| format!("Cannot watch Papers/: {error}"))?;
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let _ = sender.send(event);
    })
    .map_err(|error| error.to_string())?;
    watcher
        .watch(&papers_dir, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;
    watchers
        .0
        .lock()
        .map_err(|_| "watcher lock poisoned")?
        .push(watcher);
    let engine = engine.inner().clone();
    std::thread::spawn(move || {
        while let Ok(first) = receiver.recv() {
            let mut raw = vec![first];
            while let Ok(event) = receiver.recv_timeout(Duration::from_secs(2)) {
                raw.push(event);
            }
            let mut events = Vec::new();
            for event in raw.into_iter().flatten() {
                for path in event.paths {
                    if path
                        .extension()
                        .and_then(|value| value.to_str())
                        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
                    {
                        events.push(json!({"eventType":format!("{:?}", event.kind), "path":path.to_string_lossy()}));
                    }
                }
            }
            if events.is_empty() {
                continue;
            }
            let call_engine = engine.clone();
            let call_app = app.clone();
            let call_root = root.clone();
            tauri::async_runtime::spawn(async move {
                let _ = call_engine
                    .call(
                        call_app,
                        "library.file_events".into(),
                        json!({"root":call_root,"events":events}),
                    )
                    .await;
            });
        }
    });
    Ok(())
}

#[tauri::command]
fn choose_library() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Choose Papers2Innovations library")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn uninstall_app(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let executable = std::env::current_exe()
            .map_err(|error| format!("Cannot locate the application: {error}"))?;
        let uninstaller = executable
            .parent()
            .ok_or("Cannot locate the installation directory")?
            .join("uninstall.exe");
        if !uninstaller.is_file() {
            return Err("The uninstaller is unavailable. Reinstall the app to repair it.".into());
        }
        Command::new(&uninstaller)
            .spawn()
            .map_err(|error| format!("Cannot start the uninstaller: {error}"))?;
        app.exit(0);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Use your operating system's application manager to uninstall this app.".into())
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password| {
                use argon2::{hash_raw, Config, Variant, Version};
                let config = Config {
                    lanes: 4,
                    mem_cost: 10_000,
                    time_cost: 10,
                    variant: Variant::Argon2id,
                    version: Version::Version13,
                    ..Default::default()
                };
                hash_raw(password.as_ref(), b"papers2innovations-v1", &config)
                    .expect("failed to derive Stronghold key")
            })
            .build(),
        )
        .setup(|app| {
            let engine = Engine::new();
            engine
                .ensure_started(app.handle().clone())
                .map_err(std::io::Error::other)?;
            app.manage(engine);
            app.manage(WatcherState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            rpc_call,
            choose_library,
            credential_set,
            credential_delete,
            ocr_consent_set,
            qwen_test_connection,
            ocr_status,
            stronghold_password,
            watch_library,
            uninstall_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running Papers2Innovations");
}

#[cfg(test)]
mod tests {
    use super::{Engine, OcrLimiter};
    use std::fs;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    #[test]
    fn ocr_limiter_allows_only_two_concurrent_requests() {
        let limiter = Arc::new(OcrLimiter::default());
        let active = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let limiter = limiter.clone();
                let active = active.clone();
                let maximum = maximum.clone();
                std::thread::spawn(move || {
                    let _permit = limiter.acquire().expect("permit");
                    let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                    maximum.fetch_max(current, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(30));
                    active.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for thread in threads {
            thread.join().expect("thread");
        }
        assert_eq!(maximum.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn ocr_paths_are_limited_to_registered_library_caches() {
        let test_root = std::env::temp_dir().join(format!("p2i-ocr-path-{}", std::process::id()));
        let cache = test_root.join(".p2i/cache/ocr/hash");
        fs::create_dir_all(&cache).expect("cache directory");
        let image = cache.join("page.jpg");
        fs::write(&image, b"image").expect("image");
        let outside = test_root.join("outside.jpg");
        fs::write(&outside, b"outside").expect("outside");
        let engine = Engine::new();
        engine
            .allow_library_root(test_root.to_str().expect("root string"))
            .expect("register root");
        assert!(engine
            .is_allowed_ocr_path(&image.canonicalize().expect("canonical image"))
            .expect("allowed check"));
        assert!(!engine
            .is_allowed_ocr_path(&outside.canonicalize().expect("canonical outside"))
            .expect("outside check"));
        fs::remove_dir_all(&test_root).expect("cleanup");
    }
}
