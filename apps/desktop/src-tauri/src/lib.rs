use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures_util::StreamExt;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
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
    model_credentials: Mutex<HashMap<String, String>>,
    model_cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[derive(Clone, Default)]
struct OcrConfig {
    api_key: Option<String>,
    workspace_id: Option<String>,
    base_url: Option<String>,
    consent: bool,
    workspace_required: bool,
    model: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OcrProviderInput {
    provider: ProviderConfigInput,
    model: ModelConfigInput,
    consent: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfigInput {
    id: String,
    name: String,
    format: String,
    base_url: String,
    credential_id: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigInput {
    id: String,
    provider_id: String,
    model: String,
    display_name: String,
    max_context_tokens: u64,
    max_output_tokens: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelMessageInput {
    role: String,
    content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    tool_calls: Vec<ModelToolCallInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ModelToolCallInput {
    id: String,
    name: String,
    arguments: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelToolDefinitionInput {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelStreamInput {
    request_id: String,
    provider: ProviderConfigInput,
    model: ModelConfigInput,
    messages: Vec<ModelMessageInput>,
    #[serde(default)]
    tools: Vec<ModelToolDefinitionInput>,
    #[serde(default)]
    temperature: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ProviderTestInput {
    provider: ProviderConfigInput,
    model: ModelConfigInput,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelStreamEvent {
    request_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ModelToolCallInput>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Value>,
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
            model_credentials: Mutex::new(HashMap::new()),
            model_cancellations: Mutex::new(HashMap::new()),
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
            "model": config.model.as_deref().unwrap_or(&request.model),
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
        model: None,
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

fn validate_credential_id(credential_id: &str) -> Result<(), String> {
    if credential_id.is_empty()
        || credential_id.len() > 128
        || !credential_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_:.".contains(character))
    {
        return Err("Invalid provider credential ID".into());
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn provider_credential_set(
    engine: State<'_, Engine>,
    credential_id: String,
    api_key: String,
) -> Result<(), String> {
    validate_credential_id(&credential_id)?;
    if api_key.trim().is_empty() {
        return Err("Provider API key is empty".into());
    }
    engine
        .0
        .model_credentials
        .lock()
        .map_err(|_| "Provider credential lock poisoned")?
        .insert(credential_id, api_key);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn provider_credential_delete(
    engine: State<'_, Engine>,
    credential_id: String,
) -> Result<(), String> {
    validate_credential_id(&credential_id)?;
    engine
        .0
        .model_credentials
        .lock()
        .map_err(|_| "Provider credential lock poisoned")?
        .remove(&credential_id);
    Ok(())
}

#[tauri::command]
fn ocr_provider_configure(
    engine: State<'_, Engine>,
    input: OcrProviderInput,
) -> Result<(), String> {
    validate_credential_id(&input.provider.credential_id)?;
    if input.provider.format != "openai" {
        return Err("Full-page OCR requires an OpenAI-compatible model".into());
    }
    let api_key = engine
        .0
        .model_credentials
        .lock()
        .map_err(|_| "Provider credential lock poisoned")?
        .get(&input.provider.credential_id)
        .cloned()
        .ok_or("Provider credential is not configured")?;
    *engine
        .0
        .ocr
        .lock()
        .map_err(|_| "OCR config lock poisoned")? = OcrConfig {
        api_key: Some(api_key),
        workspace_id: None,
        base_url: Some(input.provider.base_url.trim_end_matches('/').to_owned()),
        consent: input.consent,
        workspace_required: false,
        model: Some(input.model.model),
    };
    Ok(())
}

#[tauri::command]
async fn provider_test_connection(
    engine: State<'_, Engine>,
    input: ProviderTestInput,
) -> Result<Value, String> {
    let api_key = engine
        .0
        .model_credentials
        .lock()
        .map_err(|_| "Provider credential lock poisoned")?
        .get(&input.provider.credential_id)
        .cloned()
        .ok_or("Provider credential is not configured")?;
    let request = ModelStreamInput {
        request_id: "connection-test".into(),
        provider: input.provider,
        model: input.model,
        messages: vec![ModelMessageInput {
            role: "user".into(),
            content: "Reply with OK.".into(),
            tool_call_id: None,
            tool_calls: Vec::new(),
        }],
        tools: Vec::new(),
        temperature: Some(0.0),
    };
    let response = send_model_request(&request, &api_key, false, 1).await?;
    Ok(json!({"ok": true, "status": response.status().as_u16()}))
}

#[tauri::command]
fn model_stream_start(
    app: AppHandle,
    engine: State<'_, Engine>,
    input: ModelStreamInput,
) -> Result<(), String> {
    if input.request_id.trim().is_empty() || input.messages.is_empty() {
        return Err("Model stream request ID and messages are required".into());
    }
    validate_credential_id(&input.provider.credential_id)?;
    let api_key = engine
        .0
        .model_credentials
        .lock()
        .map_err(|_| "Provider credential lock poisoned")?
        .get(&input.provider.credential_id)
        .cloned()
        .ok_or("Provider credential is not configured")?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut requests = engine
            .0
            .model_cancellations
            .lock()
            .map_err(|_| "Model cancellation lock poisoned")?;
        if requests.contains_key(&input.request_id) {
            return Err("A model request with this ID is already running".into());
        }
        requests.insert(input.request_id.clone(), cancelled.clone());
    }
    let stream_engine = engine.inner().clone();
    tauri::async_runtime::spawn(run_model_stream(
        app,
        stream_engine,
        input,
        api_key,
        cancelled,
    ));
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn model_stream_cancel(engine: State<'_, Engine>, request_id: String) -> Result<(), String> {
    if let Some(cancelled) = engine
        .0
        .model_cancellations
        .lock()
        .map_err(|_| "Model cancellation lock poisoned")?
        .get(&request_id)
    {
        cancelled.store(true, Ordering::Relaxed);
    }
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
        "model": config.model.as_deref().unwrap_or("qwen3.5-ocr"),
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

fn model_endpoint(provider: &ProviderConfigInput) -> Result<String, String> {
    let base = provider.base_url.trim().trim_end_matches('/');
    if !(base.starts_with("https://")
        || base.starts_with("http://127.0.0.1:")
        || base.starts_with("http://localhost:"))
    {
        return Err(
            "Provider Base URL must use HTTPS (localhost HTTP is allowed for testing)".into(),
        );
    }
    match provider.format.as_str() {
        "openai" => Ok(format!("{base}/chat/completions")),
        "anthropic" => Ok(format!("{base}/messages")),
        _ => Err("Provider format must be openai or anthropic".into()),
    }
}

fn model_headers(provider: &ProviderConfigInput, api_key: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if provider.format == "openai" {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {api_key}"))
                .map_err(|_| "Provider API key contains invalid header characters")?,
        );
    } else {
        headers.insert(
            HeaderName::from_static("x-api-key"),
            HeaderValue::from_str(api_key)
                .map_err(|_| "Provider API key contains invalid header characters")?,
        );
        headers.insert(
            HeaderName::from_static("anthropic-version"),
            HeaderValue::from_static("2023-06-01"),
        );
    }
    for (name, value) in &provider.headers {
        let normalized = name.trim().to_ascii_lowercase();
        if matches!(
            normalized.as_str(),
            "authorization"
                | "proxy-authorization"
                | "x-api-key"
                | "api-key"
                | "x-goog-api-key"
                | "cookie"
                | "set-cookie"
        ) || normalized.ends_with("-api-key")
        {
            return Err(format!(
                "Sensitive provider header {name} must be stored as a Stronghold credential"
            ));
        }
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| format!("Invalid provider header name: {name}"))?;
        let value =
            HeaderValue::from_str(value).map_err(|_| "Invalid provider header value".to_owned())?;
        headers.insert(name, value);
    }
    Ok(headers)
}

fn model_request_body(input: &ModelStreamInput, stream: bool, max_tokens: u64) -> Value {
    if input.provider.format == "anthropic" {
        let system = input
            .messages
            .iter()
            .filter(|message| message.role == "system")
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let mut messages: Vec<Value> = Vec::new();
        for message in input
            .messages
            .iter()
            .filter(|message| message.role != "system")
        {
            if message.role == "tool" {
                let block = json!({"type":"tool_result", "tool_use_id":message.tool_call_id, "content":message.content});
                let append_to_user = messages
                    .last()
                    .and_then(|value| value.get("role"))
                    .and_then(Value::as_str)
                    == Some("user")
                    && messages
                        .last()
                        .and_then(|value| value.get("content"))
                        .is_some_and(Value::is_array);
                if append_to_user {
                    if let Some(content) = messages
                        .last_mut()
                        .and_then(|value| value.get_mut("content"))
                        .and_then(Value::as_array_mut)
                    {
                        content.push(block);
                    }
                } else {
                    messages.push(json!({"role":"user", "content":[block]}));
                }
            } else if message.role == "assistant" && !message.tool_calls.is_empty() {
                let mut content = Vec::new();
                if !message.content.is_empty() {
                    content.push(json!({"type":"text", "text":message.content}));
                }
                content.extend(message.tool_calls.iter().map(|call| json!({"type":"tool_use", "id":call.id, "name":call.name, "input":call.arguments})));
                messages.push(json!({"role":"assistant", "content":content}));
            } else {
                messages.push(json!({"role": message.role, "content": message.content}));
            }
        }
        let tools = input.tools.iter().map(|tool| json!({"name":tool.name, "description":tool.description, "input_schema":tool.input_schema})).collect::<Vec<_>>();
        let mut body = json!({
            "model": input.model.model,
            "system": system,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": input.temperature.unwrap_or(0.2),
            "stream": stream,
            "tools": tools
        });
        if tools.is_empty() {
            body.as_object_mut().expect("model body").remove("tools");
        }
        body
    } else {
        let messages = input.messages.iter().map(|message| {
            if message.role == "tool" {
                json!({"role":"tool", "tool_call_id":message.tool_call_id, "content":message.content})
            } else if message.role == "assistant" && !message.tool_calls.is_empty() {
                json!({"role":"assistant", "content":if message.content.is_empty() { Value::Null } else { Value::String(message.content.clone()) }, "tool_calls":message.tool_calls.iter().map(|call| json!({"id":call.id, "type":"function", "function":{"name":call.name, "arguments":call.arguments.to_string()}})).collect::<Vec<_>>()})
            } else {
                json!({"role":message.role, "content":message.content})
            }
        }).collect::<Vec<_>>();
        let tools = input.tools.iter().map(|tool| json!({"type":"function", "function":{"name":tool.name, "description":tool.description, "parameters":tool.input_schema}})).collect::<Vec<_>>();
        let mut body = json!({
            "model": input.model.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": input.temperature.unwrap_or(0.2),
            "stream": stream,
            "stream_options": if stream { json!({"include_usage": true}) } else { Value::Null },
            "tools": tools
        });
        if tools.is_empty() {
            body.as_object_mut().expect("model body").remove("tools");
        }
        body
    }
}

async fn send_model_request(
    input: &ModelStreamInput,
    api_key: &str,
    stream: bool,
    max_tokens: u64,
) -> Result<reqwest::Response, String> {
    if input.provider.id.trim().is_empty()
        || input.provider.name.trim().is_empty()
        || input.model.id.trim().is_empty()
        || input.model.display_name.trim().is_empty()
        || input.model.max_context_tokens == 0
    {
        return Err("Provider and model metadata are incomplete".into());
    }
    if input.model.provider_id != input.provider.id {
        return Err("Model does not belong to the selected provider".into());
    }
    let timeout = input.provider.timeout_seconds.clamp(1, 300);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .post(model_endpoint(&input.provider)?)
        .headers(model_headers(&input.provider, api_key)?)
        .json(&model_request_body(input, stream, max_tokens))
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = body.chars().take(500).collect::<String>();
        return Err(format!(
            "Provider returned HTTP {}: {detail}",
            status.as_u16()
        ));
    }
    Ok(response)
}

fn stream_delta(format: &str, value: &Value) -> Option<String> {
    if format == "anthropic" {
        value
            .pointer("/delta/text")
            .and_then(Value::as_str)
            .map(str::to_owned)
    } else {
        value
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

fn stream_usage(format: &str, value: &Value) -> Option<Value> {
    let (input, output) = if format == "anthropic" {
        (
            value.pointer("/usage/input_tokens").and_then(Value::as_u64),
            value
                .pointer("/usage/output_tokens")
                .and_then(Value::as_u64),
        )
    } else {
        (
            value
                .pointer("/usage/prompt_tokens")
                .and_then(Value::as_u64),
            value
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64),
        )
    };
    (input.is_some() || output.is_some())
        .then(|| json!({"inputTokens": input.unwrap_or(0), "outputTokens": output.unwrap_or(0)}))
}

fn emit_model_event(
    app: &AppHandle,
    request_id: &str,
    kind: &str,
    text: Option<String>,
    tool_calls: Option<Vec<ModelToolCallInput>>,
    error: Option<String>,
    usage: Option<Value>,
) {
    let _ = app.emit(
        "model-stream",
        ModelStreamEvent {
            request_id: request_id.to_owned(),
            kind: kind.to_owned(),
            text,
            tool_calls,
            error,
            usage,
        },
    );
}

#[derive(Default)]
struct ToolCallAccumulator {
    id: String,
    name: String,
    arguments: String,
}

fn accumulate_tool_calls(format: &str, value: &Value, calls: &mut Vec<ToolCallAccumulator>) {
    if format == "anthropic" {
        let index = value.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        if value.get("type").and_then(Value::as_str) == Some("content_block_start")
            && value.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use")
        {
            calls.resize_with(index + 1, ToolCallAccumulator::default);
            calls[index].id = value
                .pointer("/content_block/id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            calls[index].name = value
                .pointer("/content_block/name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
        }
        if let Some(partial) = value.pointer("/delta/partial_json").and_then(Value::as_str) {
            calls.resize_with(index + 1, ToolCallAccumulator::default);
            calls[index].arguments.push_str(partial);
        }
    } else if let Some(deltas) = value
        .pointer("/choices/0/delta/tool_calls")
        .and_then(Value::as_array)
    {
        for delta in deltas {
            let index = delta.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            calls.resize_with(index + 1, ToolCallAccumulator::default);
            if let Some(id) = delta.get("id").and_then(Value::as_str) {
                calls[index].id = id.to_owned();
            }
            if let Some(name) = delta.pointer("/function/name").and_then(Value::as_str) {
                calls[index].name.push_str(name);
            }
            if let Some(arguments) = delta.pointer("/function/arguments").and_then(Value::as_str) {
                calls[index].arguments.push_str(arguments);
            }
        }
    }
}

async fn consume_model_stream<F>(
    response: reqwest::Response,
    format: &str,
    cancelled: &AtomicBool,
    mut on_delta: F,
) -> Result<(&'static str, Option<Value>, Vec<ModelToolCallInput>), String>
where
    F: FnMut(String),
{
    let mut bytes = response.bytes_stream();
    let mut pending = String::new();
    let mut usage = None;
    let mut tool_calls = Vec::new();
    while let Some(chunk) = bytes.next().await {
        if cancelled.load(Ordering::Relaxed) {
            return Ok(("cancelled", usage, Vec::new()));
        }
        let chunk = chunk.map_err(|error| format!("Provider stream failed: {error}"))?;
        pending.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(newline) = pending.find('\n') {
            let line = pending[..newline].trim().trim_end_matches('\r').to_owned();
            pending.drain(..=newline);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                continue;
            };
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let value: Value = serde_json::from_str(data)
                .map_err(|error| format!("Invalid provider stream event: {error}"))?;
            if let Some(delta) = stream_delta(format, &value) {
                on_delta(delta);
            }
            if let Some(event_usage) = stream_usage(format, &value) {
                usage = Some(event_usage);
            }
            accumulate_tool_calls(format, &value, &mut tool_calls);
        }
    }
    let tool_calls = tool_calls
        .into_iter()
        .filter(|call| !call.name.is_empty())
        .map(|call| {
            let arguments = if call.arguments.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&call.arguments)
                    .map_err(|error| format!("Invalid tool arguments for {}: {error}", call.name))?
            };
            if call.id.is_empty() {
                return Err(format!(
                    "Provider tool call {} did not include an ID",
                    call.name
                ));
            }
            Ok(ModelToolCallInput {
                id: call.id,
                name: call.name,
                arguments,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let kind = if tool_calls.is_empty() {
        "done"
    } else {
        "tool_calls"
    };
    Ok((kind, usage, tool_calls))
}

async fn run_model_stream(
    app: AppHandle,
    engine: Engine,
    input: ModelStreamInput,
    api_key: String,
    cancelled: Arc<AtomicBool>,
) {
    emit_model_event(&app, &input.request_id, "started", None, None, None, None);
    let outcome = async {
        let response = send_model_request(
            &input,
            &api_key,
            true,
            input.model.max_output_tokens.clamp(1, 65_536),
        )
        .await?;
        consume_model_stream(response, &input.provider.format, &cancelled, |delta| {
            emit_model_event(
                &app,
                &input.request_id,
                "delta",
                Some(delta),
                None,
                None,
                None,
            )
        })
        .await
    }
    .await;
    match outcome {
        Ok((kind, usage, tool_calls)) => emit_model_event(
            &app,
            &input.request_id,
            kind,
            None,
            (!tool_calls.is_empty()).then_some(tool_calls),
            None,
            usage,
        ),
        Err(error) => emit_model_event(
            &app,
            &input.request_id,
            "error",
            None,
            None,
            Some(error),
            None,
        ),
    }
    if let Ok(mut requests) = engine.0.model_cancellations.lock() {
        requests.remove(&input.request_id);
    }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfImportResult {
    selected: usize,
    copied: usize,
    deduplicated: usize,
    destination: String,
}

fn sha256_file(path: &Path) -> Result<Vec<u8>, String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("Cannot read {}: {error}", path.display()))?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(digest.finalize().to_vec())
}

#[tauri::command]
fn import_pdfs(engine: State<'_, Engine>, root: String) -> Result<PdfImportResult, String> {
    engine.allow_library_root(&root)?;
    let selected = rfd::FileDialog::new()
        .set_title("添加 PDF 到 Papers2Innovations")
        .add_filter("PDF 论文", &["pdf"])
        .pick_files()
        .unwrap_or_default();
    let destination = PathBuf::from(&root).join("Papers").join("Manual");
    fs::create_dir_all(&destination)
        .map_err(|error| format!("Cannot create {}: {error}", destination.display()))?;
    let mut copied = 0;
    let mut deduplicated = 0;
    for (index, source) in selected.iter().enumerate() {
        if !source
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("pdf"))
        {
            continue;
        }
        let file_name = source.file_name().ok_or("Selected PDF has no file name")?;
        let mut target = destination.join(file_name);
        let source_hash = sha256_file(source)?;
        if target.is_file() && sha256_file(&target)? == source_hash {
            deduplicated += 1;
            continue;
        }
        if target.exists() {
            let stem = source
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("paper");
            let mut suffix = 2;
            loop {
                let candidate = destination.join(format!("{stem} ({suffix}).pdf"));
                if !candidate.exists() {
                    target = candidate;
                    break;
                }
                if candidate.is_file() && sha256_file(&candidate)? == source_hash {
                    deduplicated += 1;
                    target = candidate;
                    break;
                }
                suffix += 1;
            }
            if target.is_file() && sha256_file(&target)? == source_hash {
                continue;
            }
        }
        let temporary = destination.join(format!(".p2i-import-{}-{index}.tmp", std::process::id()));
        fs::copy(source, &temporary)
            .map_err(|error| format!("Cannot copy {}: {error}", source.display()))?;
        if sha256_file(&temporary)? != source_hash {
            let _ = fs::remove_file(&temporary);
            return Err(format!("PDF verification failed: {}", source.display()));
        }
        fs::rename(&temporary, &target)
            .map_err(|error| format!("Cannot finish importing {}: {error}", source.display()))?;
        copied += 1;
    }
    Ok(PdfImportResult {
        selected: selected.len(),
        copied,
        deduplicated,
        destination: destination.to_string_lossy().into_owned(),
    })
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
            import_pdfs,
            credential_set,
            credential_delete,
            provider_credential_set,
            provider_credential_delete,
            ocr_provider_configure,
            provider_test_connection,
            model_stream_start,
            model_stream_cancel,
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
    use super::{
        consume_model_stream, model_endpoint, model_headers, send_model_request, stream_delta,
        validate_credential_id, Engine, ModelConfigInput, ModelMessageInput, ModelStreamInput,
        OcrLimiter, ProviderConfigInput,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;

    fn model_request(base_url: String, format: &str) -> ModelStreamInput {
        ModelStreamInput {
            request_id: "test-request".into(),
            provider: ProviderConfigInput {
                id: "provider".into(),
                name: "Provider".into(),
                format: format.into(),
                base_url,
                credential_id: "provider".into(),
                headers: HashMap::new(),
                timeout_seconds: 5,
            },
            model: ModelConfigInput {
                id: "model".into(),
                provider_id: "provider".into(),
                model: "model".into(),
                display_name: "Model".into(),
                max_context_tokens: 4096,
                max_output_tokens: 64,
            },
            messages: vec![ModelMessageInput {
                role: "user".into(),
                content: "test".into(),
                tool_call_id: None,
                tool_calls: Vec::new(),
            }],
            tools: Vec::new(),
            temperature: Some(0.0),
        }
    }

    fn mock_http_server(status: &str, content_type: &str, body: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock listener");
        let address = listener.local_addr().expect("mock address");
        let status = status.to_owned();
        let content_type = content_type.to_owned();
        let body = body.to_owned();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().expect("mock connection");
            let mut request = [0_u8; 16_384];
            let _ = socket.read(&mut request).expect("mock request");
            write!(
                socket,
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("mock response");
        });
        format!("http://{address}/v1")
    }

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
    fn provider_credential_ids_support_dotted_model_names() {
        assert!(validate_credential_id("provider-qwen3.6-plus").is_ok());
        assert!(validate_credential_id("provider:qwen_ocr-2026").is_ok());
        assert!(validate_credential_id("provider/qwen").is_err());
    }

    #[test]
    fn model_endpoint_requires_https_except_local_test_servers() {
        let provider = |base_url: &str, format: &str| ProviderConfigInput {
            id: "provider".into(),
            name: "Provider".into(),
            format: format.into(),
            base_url: base_url.into(),
            credential_id: "provider".into(),
            headers: HashMap::new(),
            timeout_seconds: 30,
        };
        assert_eq!(
            model_endpoint(&provider("https://gateway.example/v1", "openai")).unwrap(),
            "https://gateway.example/v1/chat/completions"
        );
        assert_eq!(
            model_endpoint(&provider("http://127.0.0.1:8080/v1", "anthropic")).unwrap(),
            "http://127.0.0.1:8080/v1/messages"
        );
        assert!(model_endpoint(&provider("http://remote.example/v1", "openai")).is_err());
    }

    #[test]
    fn model_stream_normalizes_openai_and_anthropic_deltas() {
        assert_eq!(
            stream_delta(
                "openai",
                &json!({"choices":[{"delta":{"content":"hello"}}]})
            ),
            Some("hello".into())
        );
        assert_eq!(
            stream_delta(
                "anthropic",
                &json!({"delta":{"type":"text_delta","text":"world"}})
            ),
            Some("world".into())
        );
    }

    #[test]
    fn provider_headers_reject_secrets_but_allow_non_secret_routing_metadata() {
        let mut headers = HashMap::from([
            ("Authorization".into(), "Bearer persisted-secret".into()),
            ("OpenAI-Organization".into(), "org-test".into()),
        ]);
        let provider = ProviderConfigInput {
            id: "provider".into(),
            name: "Provider".into(),
            format: "openai".into(),
            base_url: "https://gateway.example/v1".into(),
            credential_id: "provider".into(),
            headers: headers.clone(),
            timeout_seconds: 30,
        };
        assert!(model_headers(&provider, "stronghold-secret").is_err());

        headers.remove("Authorization");
        let safe_provider = ProviderConfigInput {
            headers,
            ..provider
        };
        let result = model_headers(&safe_provider, "stronghold-secret").expect("safe headers");
        assert_eq!(result.get("OpenAI-Organization").unwrap(), "org-test");
    }

    #[test]
    fn local_mock_streams_normalize_openai_anthropic_and_cancellation() {
        tauri::async_runtime::block_on(async {
            let openai_body = concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n",
                "data: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n",
                "data: [DONE]\n\n"
            );
            let openai_url = mock_http_server("200 OK", "text/event-stream", openai_body);
            let openai = model_request(openai_url, "openai");
            let response = send_model_request(&openai, "secret", true, 64)
                .await
                .expect("OpenAI mock request");
            let mut deltas = Vec::new();
            let (kind, usage, tool_calls) =
                consume_model_stream(response, "openai", &AtomicBool::new(false), |delta| {
                    deltas.push(delta)
                })
                .await
                .expect("OpenAI mock stream");
            assert_eq!(kind, "done");
            assert_eq!(deltas, ["hello"]);
            assert_eq!(usage.unwrap()["inputTokens"], 3);
            assert!(tool_calls.is_empty());

            let anthropic_body = concat!(
                "data: {\"delta\":{\"type\":\"text_delta\",\"text\":\"world\"}}\n\n",
                "data: {\"usage\":{\"input_tokens\":4,\"output_tokens\":1}}\n\n"
            );
            let anthropic_url = mock_http_server("200 OK", "text/event-stream", anthropic_body);
            let anthropic = model_request(anthropic_url, "anthropic");
            let response = send_model_request(&anthropic, "secret", true, 64)
                .await
                .expect("Anthropic mock request");
            let cancelled = AtomicBool::new(true);
            let (kind, usage, tool_calls) =
                consume_model_stream(response, "anthropic", &cancelled, |_| {
                    panic!("cancelled stream emitted a delta")
                })
                .await
                .expect("cancelled mock stream");
            assert_eq!(kind, "cancelled");
            assert!(usage.is_none());
            assert!(tool_calls.is_empty());
        });
    }

    #[test]
    fn local_mock_normalizes_openai_and_anthropic_tool_calls() {
        tauri::async_runtime::block_on(async {
            let openai_body = concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call-1\",\"function\":{\"name\":\"find_evidence\",\"arguments\":\"{\\\"query\\\":\"}}]}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"budget\\\"}\"}}]}}]}\n\n",
                "data: [DONE]\n\n"
            );
            let openai_url = mock_http_server("200 OK", "text/event-stream", openai_body);
            let openai = model_request(openai_url, "openai");
            let response = send_model_request(&openai, "secret", true, 64)
                .await
                .unwrap();
            let (kind, _, calls) =
                consume_model_stream(response, "openai", &AtomicBool::new(false), |_| {})
                    .await
                    .unwrap();
            assert_eq!(kind, "tool_calls");
            assert_eq!(calls[0].name, "find_evidence");
            assert_eq!(calls[0].arguments["query"], "budget");

            let anthropic_body = concat!(
                "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"tool-1\",\"name\":\"read_paper\",\"input\":{}}}\n\n",
                "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"paperId\\\":\\\"paper-1\\\"}\"}}\n\n"
            );
            let anthropic_url = mock_http_server("200 OK", "text/event-stream", anthropic_body);
            let anthropic = model_request(anthropic_url, "anthropic");
            let response = send_model_request(&anthropic, "secret", true, 64)
                .await
                .unwrap();
            let (kind, _, calls) =
                consume_model_stream(response, "anthropic", &AtomicBool::new(false), |_| {})
                    .await
                    .unwrap();
            assert_eq!(kind, "tool_calls");
            assert_eq!(calls[0].name, "read_paper");
            assert_eq!(calls[0].arguments["paperId"], "paper-1");
        });
    }

    #[test]
    fn local_mock_maps_provider_http_errors_without_exposing_the_key() {
        tauri::async_runtime::block_on(async {
            let url = mock_http_server(
                "429 Too Many Requests",
                "application/json",
                r#"{"error":"rate limited"}"#,
            );
            let request = model_request(url, "openai");
            let error = send_model_request(&request, "do-not-leak", true, 64)
                .await
                .expect_err("429 must fail");
            assert!(error.contains("HTTP 429"));
            assert!(error.contains("rate limited"));
            assert!(!error.contains("do-not-leak"));
        });
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
