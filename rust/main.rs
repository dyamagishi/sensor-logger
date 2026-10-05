mod ble;
mod cloud;
mod hue;
mod registry;
mod store;
#[cfg(test)]
mod tests;

use anyhow::{Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use store::{Sensor, Store};
use tokio::sync::Mutex;

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn log_error(message: &str) {
    log_message("ERROR", message);
}
fn log_message(level: &str, message: &str) {
    use std::io::Write;
    if let Some(path) = std::env::var_os("SENSOR_LOG_FILE").map(PathBuf::from) {
        if std::fs::metadata(&path).is_ok_and(|m| m.len() >= 524288) {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{} {level} {message}", now());
        }
    } else {
        eprintln!("{} {level} {message}", now());
    }
}
pub type Shared = Arc<Mutex<Service>>;
#[derive(Deserialize)]
#[serde(default)]
struct Config {
    sensors: Vec<Sensor>,
    host: String,
    port: u16,
    adapter: String,
    receiver: String,
    retention_hours: i64,
    upload_seconds: i64,
    registry_file: Option<PathBuf>,
    hue: Option<hue::Config>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            sensors: vec![],
            host: "0.0.0.0".into(),
            port: 8080,
            adapter: "hci0".into(),
            receiver: "hci".into(),
            retention_hours: 24,
            upload_seconds: 3600,
            registry_file: None,
            hue: None,
        }
    }
}
pub struct Service {
    hue: hue::Hue,
    store: Store,
    scanner: ble::Scanner,
    registry: Vec<Sensor>,
    registry_path: Option<PathBuf>,
    started: i64,
    cloud: String,
    ingest: String,
    read: String,
    http: reqwest::Client,
    cloud_state: String,
    cloud_error: Option<String>,
    last_sent: Option<i64>,
    next_send_at: i64,
    send_interval: i64,
    upload_requests: u64,
    cache: HashMap<(String, i64), cloud::Cache>,
    history_retry: HashMap<(String, i64), (i64, String)>,
}
impl Service {
    fn new(mut config: Config) -> Result<Self> {
        let registry_path = std::env::var_os("SENSOR_REGISTRY_FILE")
            .map(PathBuf::from)
            .or(config.registry_file);
        let registry = registry::load(registry_path.as_deref())?;
        for s in &mut config.sensors {
            s.address = s.address.to_uppercase();
        }
        for row in &registry {
            if !config.sensors.iter().any(|s| s.address == row.address) {
                config.sensors.push(row.clone());
            }
        }
        ensure!(
            config.sensors.len() <= 32
                && config.retention_hours > 0
                && config.retention_hours <= 24,
            "invalid sensor count/retention"
        );
        let mut ids = std::collections::HashSet::new();
        let mut addresses = std::collections::HashSet::new();
        for s in &config.sensors {
            ensure!(
                ids.insert(&s.id) && addresses.insert(&s.address),
                "duplicate sensors"
            );
        }
        let started = now();
        let send_interval = config.upload_seconds.max(1);
        let cloud = std::env::var("SENSOR_CLOUD_URL")
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string();
        Ok(Self {
            hue: hue::Hue::new(config.hue)?,
            store: Store::new(config.sensors, config.retention_hours * 3600),
            scanner: ble::Scanner::disabled(),
            registry,
            registry_path,
            started,
            cloud_state: if cloud.is_empty() {
                "unconfigured"
            } else {
                "buffering"
            }
            .into(),
            cloud,
            ingest: std::env::var("INGEST_TOKEN").unwrap_or_default(),
            read: std::env::var("READ_TOKEN").unwrap_or_default(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(12))
                .no_proxy()
                .build()?,
            cloud_error: None,
            last_sent: None,
            next_send_at: (started / send_interval + 1) * send_interval + 2,
            send_interval,
            upload_requests: 0,
            cache: HashMap::new(),
            history_retry: HashMap::new(),
        })
    }
}
fn error(code: StatusCode, message: &str) -> Response {
    (code, Json(json!({"error":message}))).into_response()
}
async fn headers(request: Request, next: Next) -> Response {
    let h = request.headers();
    let method = request.method();
    let origin = h.get("origin").and_then(|v| v.to_str().ok());
    let host = h.get("host").and_then(|v| v.to_str().ok()).unwrap_or("");
    let allowed = matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS")
        || (h
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(';').next() == Some("application/json"))
            && h.get("x-home-sensors").is_some_and(|v| v == "1")
            && origin.is_none_or(|o| o == format!("http://{host}")));
    let mut response = if allowed {
        next.run(request).await
    } else {
        error(StatusCode::FORBIDDEN, "この画面から操作し直してください。")
    };
    for (name, value) in [
        ("cache-control", "no-store"),
        ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}
async fn status(State(shared): State<Shared>) -> Json<Value> {
    let s = shared.lock().await;
    let time = now();
    Json(
        json!({"now":time,"uptime_seconds":time-s.started,"sensors":s.store.status(time),"hue":s.hue.status(time),"collector":{"state":s.scanner.state,"error":s.scanner.error,"last_event":s.scanner.last_event},"cloud":{"state":s.cloud_state,"error":s.cloud_error,"last_sent":s.last_sent,"pending":s.store.pending.len()+s.hue.pending.len(),"dropped":s.store.dropped+s.hue.dropped,"next_send_at":s.next_send_at,"upload_seconds":s.send_interval,"upload_requests":s.upload_requests},"history_points":s.store.history.len()}),
    )
}
async fn discovery(State(shared): State<Shared>) -> Response {
    let s = shared.lock().await;
    if s.scanner.state == "disabled" {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "探索を利用できません。Bluetooth受信状態を確認してください。",
        );
    }
    Json(json!({"devices":s.scanner.discovered(&s.store),"scanning":now()<s.scanner.discovery_until,"until":s.scanner.discovery_until,"collector_state":s.scanner.state})).into_response()
}
async fn start_discovery(State(shared): State<Shared>, Json(body): Json<Value>) -> Response {
    {
        let mut s = shared.lock().await;
        s.scanner.discovery_until = if body["active"] == false {
            0
        } else {
            now() + 120
        };
    }
    discovery(State(shared)).await
}
async fn register(State(shared): State<Shared>, Json(body): Json<Value>) -> Response {
    let Some(address) = body["address"].as_str() else {
        return error(StatusCode::BAD_REQUEST, "機器を選択してください。");
    };
    let address = address.to_uppercase();
    let mut s = shared.lock().await;
    if s.store.sensors.iter().any(|s| s.address == address) {
        return error(StatusCode::CONFLICT, "この機器は登録済みです。");
    }
    if s.store.sensors.len() >= 32 {
        return error(StatusCode::CONFLICT, "登録できる上限の32台に達しました。");
    }
    let candidates = s.scanner.discovered(&s.store);
    let Some(candidate) = candidates.iter().find(|c| c["address"] == address) else {
        return error(
            StatusCode::BAD_REQUEST,
            "最近の電波を受信できません。もう一度探してください。",
        );
    };
    let row = Sensor {
        id: registry::sensor_id(&address),
        address,
        name: body["name"].as_str().unwrap_or("").trim().into(),
        kind: candidate["kind"].as_str().unwrap_or("meter").into(),
        cloud_synced: Some(false),
    };
    if registry::validate(&row).is_err() {
        return error(
            StatusCode::BAD_REQUEST,
            "表示名を1〜40文字で入力してください。",
        );
    }
    let mut rows = s.registry.clone();
    rows.push(row.clone());
    if registry::save(s.registry_path.as_deref(), &rows).is_err() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "登録情報を保存できませんでした。追加は行っていません。",
        );
    }
    s.registry = rows;
    s.store.sensors.push(row.clone());
    if let Ok(values) = serde_json::from_value(candidate.clone()) {
        s.store.observe(
            &row.id,
            values,
            candidate["observed_at"].as_i64().unwrap_or(now()),
        );
    }
    let mut public = serde_json::to_value(row).unwrap();
    public.as_object_mut().unwrap().remove("address");
    (
        StatusCode::CREATED,
        Json(json!({"sensor":public,"cloud_pending":!s.cloud.is_empty()})),
    )
        .into_response()
}
fn app(shared: Shared, dist: PathBuf) -> Router {
    Router::new()
        .route("/api/status", get(status))
        .route("/api/history", get(cloud::history))
        .route("/api/discovery", get(discovery).post(start_discovery))
        .route("/api/sensors", post(register))
        .route("/api/hue/devices", get(hue::devices).post(hue::select))
        .route("/api/hue/control", post(hue::control))
        .route("/api/hue/history", get(hue::history))
        .route_service(
            "/",
            tower_http::services::ServeFile::new(dist.join("index.html")),
        )
        .nest_service(
            "/assets",
            tower_http::services::ServeDir::new(dist.join("assets")),
        )
        .layer(DefaultBodyLimit::max(32768))
        .layer(middleware::from_fn(headers))
        .with_state(shared)
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let result = run().await;
    if let Err(e) = &result {
        log_error(&format!("startup/server: {e}"));
    }
    result
}
async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut path = PathBuf::from("config/sensors.toml");
    let mut dist = PathBuf::from("dist");
    let mut no_ble = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                path = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("missing config"))?
                    .into()
            }
            "--dist" => {
                dist = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("missing dist"))?
                    .into()
            }
            "--no-ble" => no_ble = true,
            "--version" => {
                println!("home-sensors {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            _ => anyhow::bail!("unknown argument: {arg}"),
        }
    }
    let config: Config = toml::from_str(&std::fs::read_to_string(path)?)?;
    ensure!(
        config.receiver == "hci" || no_ble,
        "Rust receiver supports hci only"
    );
    let adapter = config
        .adapter
        .strip_prefix("hci")
        .ok_or_else(|| anyhow::anyhow!("invalid adapter"))?
        .parse()?;
    let bind = format!("{}:{}", config.host, config.port);
    let shared = Arc::new(Mutex::new(Service::new(config)?));
    tokio::spawn(hue::run(shared.clone()));
    if !no_ble {
        tokio::spawn(ble::run(shared.clone(), adapter));
    }
    let sample = shared.clone();
    tokio::spawn(async move {
        let mut minute = now() / 60 * 60;
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let time = now();
            {
                let mut s = sample.lock().await;
                let Service {
                    scanner,
                    store,
                    started,
                    ..
                } = &mut *s;
                for message in scanner.diagnostic_logs(store, time, *started) {
                    log_message("INFO", &message);
                }
            }
            let next = time / 60 * 60;
            if next > minute {
                sample.lock().await.store.finalize(minute, time);
                minute = next;
            }
        }
    });
    let upload = shared.clone();
    tokio::spawn(async move {
        loop {
            cloud::send_due(&upload, now()).await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    axum::serve(listener, app(shared, dist))
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .unwrap();
                tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
        })
        .await?;
    Ok(())
}
