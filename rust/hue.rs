//! Individual Hue devices only. Scheduled observations and UI command reads are separate.
use crate::{Shared, cloud::Cache, error, now};
use anyhow::{Result, ensure};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    io::Write,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

#[derive(Clone, Deserialize)]
pub struct Config {
    pub bridge_url: String,
    pub bridge_id: String,
    pub certificate_file: PathBuf,
    pub registry_file: PathBuf,
}

// Exact leaf-certificate trust established by the administrator wizard. Keep TLS
// handshake signature verification: trusting a certificate is not trusting any key.
#[derive(Debug)]
struct PinnedCertificate(Vec<u8>);
impl ServerCertVerifier for PinnedCertificate {
    fn verify_server_cert(
        &self,
        cert: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if cert.as_ref() == self.0 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "Hue certificate changed; run setup again".into(),
            ))
        }
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            signature,
            &rustls::crypto::ring::default_provider().signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    url: String,
    key: String,
    bridge: String,
}
impl Client {
    fn new(config: &Config) -> Result<Self> {
        let url = reqwest::Url::parse(&config.bridge_url)?;
        ensure!(
            url.scheme() == "https"
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none(),
            "invalid Hue URL"
        );
        ensure!(
            config.bridge_id.len() == 16 && config.bridge_id.bytes().all(|b| b.is_ascii_hexdigit()),
            "invalid Hue Bridge id"
        );
        let key = std::env::var("HUE_APPLICATION_KEY").unwrap_or_default();
        ensure!(
            !key.is_empty()
                && key.len() <= 128
                && key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "HUE_APPLICATION_KEY is missing or invalid"
        );
        let tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedCertificate(std::fs::read(
            &config.certificate_file,
        )?)))
        .with_no_client_auth();
        let http = reqwest::Client::builder()
            .use_preconfigured_tls(tls)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8))
            .build()?;
        Ok(Self {
            http,
            url: config.bridge_url.trim_end_matches('/').into(),
            key,
            bridge: config.bridge_id.to_lowercase(),
        })
    }
    async fn resources(&self, kind: &str) -> Result<Vec<Value>> {
        let data = self.request(reqwest::Method::GET, kind, None).await?;
        Ok(data["data"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid Hue response"))?
            .clone())
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let mut req = self
            .http
            .request(method, format!("{}/clip/v2/resource/{path}", self.url))
            .header("hue-application-key", &self.key);
        if let Some(body) = body {
            req = req.json(body);
        }
        let mut response = req.send().await.map_err(|_| {
            anyhow::anyhow!("Hue connection failed (check address, certificate and key)")
        })?;
        ensure!(
            response.status().is_success(),
            "Hue HTTP {}",
            response.status().as_u16()
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 2_097_152,
                "Hue response too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let data: Value = serde_json::from_slice(&bytes)?;
        ensure!(
            data["errors"].as_array().is_some_and(|e| e.is_empty()),
            "Hue rejected request"
        );
        Ok(data)
    }
    async fn inventory(&self) -> Result<Vec<Device>> {
        // Do not retrieve scenes, rooms, zones, or grouped_light resources.
        let devices = self.resources("device").await?;
        let lights = self.resources("light").await?;
        let connectivity = self.resources("zigbee_connectivity").await?;
        parse_inventory(&self.bridge, &devices, &lights, &connectivity)
    }
}
fn identity(bridge: &str, rid: &str) -> String {
    format!(
        "hue-{:x}",
        Sha256::digest(format!("{bridge}/{rid}").as_bytes())
    )[..36]
        .into()
}
fn uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Values {
    pub on: Option<bool>,
    pub brightness: Option<f64>,
    pub mirek: Option<u32>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub color_mode: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Output {
    pub id: String,
    pub rid: String,
    pub name: String,
    #[serde(default)]
    pub dimming: bool,
    #[serde(default)]
    pub color: bool,
    #[serde(default)]
    pub temperature: Option<[u32; 2]>,
    #[serde(default)]
    pub gamut: Option<[[f64; 2]; 3]>,
    #[serde(default)]
    pub values: Values,
    #[serde(default)]
    pub connectivity: String,
    #[serde(default)]
    pub available: bool,
    #[serde(default)]
    pub observed_at: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub outputs: Vec<Output>,
    #[serde(default)]
    pub selected: bool,
    #[serde(default)]
    pub present: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Sample {
    pub light_id: String,
    pub minute: i64,
    pub observed_at: i64,
    pub available: bool,
    pub connectivity: String,
    #[serde(flatten)]
    pub values: Values,
}
fn finite(v: &Value, min: f64, max: f64) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
}
fn display_name(value: &Value) -> String {
    let name: String = value
        .as_str()
        .unwrap_or("照明")
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect();
    if name.trim().is_empty() {
        "照明".into()
    } else {
        name
    }
}
pub fn parse_inventory(
    bridge: &str,
    devices: &[Value],
    lights: &[Value],
    connectivity: &[Value],
) -> Result<Vec<Device>> {
    let mut result = Vec::new();
    ensure!(
        devices.len() <= 512 && lights.len() <= 512,
        "Hue inventory too large"
    );
    for d in devices {
        let rid = d["id"].as_str().unwrap_or("");
        ensure!(uuid(rid), "invalid Hue device id");
        let mut outputs = Vec::new();
        for service in d["services"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid Hue services"))?
        {
            if service["rtype"] != "light" {
                continue;
            }
            let Some(l) = lights
                .iter()
                .find(|l| l["id"] == service["rid"] && l["owner"]["rid"] == rid)
            else {
                continue;
            };
            let lrid = l["id"].as_str().unwrap_or("");
            ensure!(uuid(lrid), "invalid Hue light id");
            let status = connectivity
                .iter()
                .find(|c| c["owner"]["rid"] == rid)
                .and_then(|c| c["status"].as_str())
                .unwrap_or("unknown");
            let status = match status {
                "connected"
                | "disconnected"
                | "connectivity_issue"
                | "unidirectional_incoming"
                | "pending_discovery" => status,
                _ => "unknown",
            };
            let valid_ct = l["color_temperature"]["mirek_valid"] == true;
            let mirek = if valid_ct {
                l["color_temperature"]["mirek"]
                    .as_u64()
                    .filter(|n| (1..=1000).contains(n))
                    .map(|n| n as u32)
            } else {
                None
            };
            let temperature = l["color_temperature"]["mirek_schema"]
                .as_object()
                .and_then(|s| {
                    Some([
                        s.get("mirek_minimum")?.as_u64()? as u32,
                        s.get("mirek_maximum")?.as_u64()? as u32,
                    ])
                })
                .filter(|[a, b]| *a > 0 && a <= b && *b <= 1000);
            let gamut = l["color"]["gamut"].as_object().and_then(|g| {
                let point = |name: &str| -> Option<[f64; 2]> {
                    let p = g.get(name)?;
                    Some([finite(&p["x"], 0., 1.)?, finite(&p["y"], 0., 1.)?])
                };
                Some([point("red")?, point("green")?, point("blue")?])
            });
            let on = l["on"]["on"].as_bool();
            let available = status == "connected" && on.is_some();
            let xy = finite(&l["color"]["xy"]["x"], 0., 1.)
                .zip(finite(&l["color"]["xy"]["y"], 0., 1.))
                .filter(|(x, y)| x + y <= 1.000001);
            outputs.push(Output {
                id: identity(bridge, lrid),
                rid: lrid.into(),
                name: display_name(&l["metadata"]["name"]),
                dimming: l["dimming"].is_object(),
                color: l["color"].is_object(),
                temperature,
                gamut,
                values: Values {
                    on,
                    brightness: finite(&l["dimming"]["brightness"], 0., 100.),
                    mirek,
                    x: xy.map(|(x, _)| x),
                    y: xy.map(|(_, y)| y),
                    color_mode: if mirek.is_some() {
                        Some("temperature".into())
                    } else if l.get("color").is_some() {
                        Some("color".into())
                    } else {
                        None
                    },
                },
                connectivity: status.into(),
                available,
                observed_at: None,
            });
        }
        if !outputs.is_empty() {
            result.push(Device {
                id: identity(bridge, rid),
                name: display_name(&d["metadata"]["name"]),
                outputs,
                selected: false,
                present: true,
            });
        }
    }
    Ok(result)
}

pub struct Hue {
    pub client: Option<Client>,
    pub devices: Vec<Device>,
    pub inventory: Vec<Device>,
    path: Option<PathBuf>,
    pub pending: VecDeque<Sample>,
    pub history: VecDeque<Sample>,
    pub dropped: u64,
    pub state: String,
    pub last_poll: Option<i64>,
    pub error: Option<String>,
    catalog_dirty: bool,
    pub cache: HashMap<(String, i64), Cache>,
    pub retry: HashMap<(String, i64), i64>,
    pub io: Arc<tokio::sync::Mutex<()>>,
    pub history_io: Arc<tokio::sync::Mutex<()>>,
}
impl Hue {
    pub fn new(config: Option<Config>) -> Result<Self> {
        let config = if let Some(path) = std::env::var_os("HUE_CONFIG_FILE") {
            Some(toml::from_str::<Config>(&std::fs::read_to_string(
                PathBuf::from(path),
            )?)?)
        } else {
            config
        };
        let client = config.as_ref().map(Client::new).transpose()?;
        let path = config.map(|c| c.registry_file);
        let mut devices: Vec<Device> = if let Some(path) = path.as_ref().filter(|p| p.exists()) {
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            vec![]
        };
        ensure!(
            devices.len() <= 512 && devices.iter().map(|d| d.outputs.len()).sum::<usize>() <= 512,
            "Hue registry too large"
        );
        let mut ids = HashSet::new();
        for d in &mut devices {
            ensure!(
                valid_id(&d.id) && ids.insert(d.id.clone()),
                "invalid Hue registry"
            );
            d.present = false;
            for o in &mut d.outputs {
                ensure!(
                    valid_id(&o.id) && uuid(&o.rid) && ids.insert(o.id.clone()),
                    "invalid Hue output"
                );
                o.available = false;
                o.observed_at = None;
                o.values = Values::default();
            }
        }
        Ok(Self {
            state: if client.is_some() {
                "connecting"
            } else {
                "unconfigured"
            }
            .into(),
            client,
            devices,
            inventory: vec![],
            path,
            pending: VecDeque::new(),
            history: VecDeque::new(),
            dropped: 0,
            last_poll: None,
            error: None,
            catalog_dirty: false,
            cache: HashMap::new(),
            retry: HashMap::new(),
            io: Arc::new(tokio::sync::Mutex::new(())),
            history_io: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
    fn save(&self, devices: &[Device]) -> Result<()> {
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Hue registry not configured"))?;
        let parent = path.parent().unwrap();
        std::fs::create_dir_all(parent)?;
        let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
        tmp.write_all(&serde_json::to_vec(devices)?)?;
        tmp.as_file().sync_all()?;
        tmp.persist(path)?;
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    }
    pub fn prune(&mut self, time: i64) {
        self.history.retain(|s| s.minute >= time - 86400);
        let before = self.pending.len();
        self.pending.retain(|s| s.minute >= time - 86400);
        self.dropped += (before - self.pending.len()) as u64;
    }
    pub fn status(&self, time: i64) -> Value {
        let mut devices = self.devices.clone();
        if self.state != "online" || self.last_poll.is_none_or(|t| time - t > 180) {
            for d in &mut devices {
                for o in &mut d.outputs {
                    o.available = false;
                }
            }
        }
        json!({"state":self.state,"error":self.error,"last_poll":self.last_poll,"devices":devices,"poll_seconds":60})
    }
    fn apply(&mut self, result: Result<Vec<Device>>, time: i64, record: bool) {
        match result {
            Ok(mut inventory) => {
                for d in &mut inventory {
                    for o in &mut d.outputs {
                        if o.available {
                            o.observed_at = Some(time);
                        }
                    }
                }
                let mut next = self.devices.clone();
                for d in &mut next {
                    if let Some(fresh) = inventory.iter_mut().find(|i| i.id == d.id) {
                        fresh.selected = d.selected;
                        let mut updated = fresh.clone();
                        for o in &mut updated.outputs {
                            if o.available {
                                o.observed_at = Some(time);
                            } else if let Some(old) = d.outputs.iter().find(|old| old.id == o.id) {
                                o.values = old.values.clone();
                                o.observed_at = old.observed_at;
                            }
                        }
                        // Preserve removed outputs for archive access, but never poll them.
                        for old in &d.outputs {
                            if !updated.outputs.iter().any(|o| o.id == old.id) {
                                let mut old = old.clone();
                                old.available = false;
                                old.connectivity = "removed".into();
                                updated.outputs.push(old);
                            }
                        }
                        *d = updated;
                    } else {
                        d.present = false;
                        d.selected = false;
                        for o in &mut d.outputs {
                            o.available = false;
                            o.connectivity = "removed".into();
                        }
                    }
                }
                // Persist only catalog changes, not every observed state.
                let catalog = |ds: &[Device]| {
                    json!(
                        ds.iter()
                            .map(|d| json!([
                                d.id,
                                d.name,
                                d.selected,
                                d.present,
                                d.outputs
                                    .iter()
                                    .map(|o| json!([
                                        o.id,
                                        o.name,
                                        o.rid,
                                        o.connectivity == "removed"
                                    ]))
                                    .collect::<Vec<_>>()
                            ]))
                            .collect::<Vec<_>>()
                    )
                };
                self.catalog_dirty |= catalog(&next) != catalog(&self.devices);
                if self.catalog_dirty && self.save(&next).is_err() {
                    self.error = Some("Hue登録情報の更新を保存できませんでした".into());
                } else {
                    self.error = None;
                    self.catalog_dirty = false;
                }
                self.devices = next;
                self.inventory = inventory;
                self.state = "online".into();
                self.last_poll = Some(time);
            }
            Err(_) => {
                self.state = "offline".into();
                self.error = Some(
                    "Hue Bridgeに接続できません。接続先・認証情報・証明書を確認してください。"
                        .into(),
                );
                for d in &mut self.devices {
                    for o in &mut d.outputs {
                        o.available = false;
                        if o.connectivity != "removed" {
                            o.connectivity = "bridge_unavailable".into();
                        }
                    }
                }
            }
        }
        if record {
            for d in self.devices.iter().filter(|d| d.selected) {
                for o in d.outputs.iter().filter(|o| o.connectivity != "removed") {
                    let row = Sample {
                        light_id: o.id.clone(),
                        minute: time / 60 * 60,
                        observed_at: time,
                        available: o.available,
                        connectivity: o.connectivity.clone(),
                        values: if o.available {
                            o.values.clone()
                        } else {
                            Values::default()
                        },
                    };
                    if !self
                        .history
                        .iter()
                        .rev()
                        .take(512)
                        .any(|s| s.light_id == row.light_id && s.minute == row.minute)
                    {
                        self.history.push_back(row.clone());
                        self.pending.push_back(row);
                    }
                }
            }
            self.prune(time);
        }
    }
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.starts_with("hue-") && id[4..].bytes().all(|b| b.is_ascii_hexdigit())
}
async fn refresh(shared: &Shared, record: bool) {
    let (client, io) = {
        let s = shared.lock().await;
        (s.hue.client.clone(), s.hue.io.clone())
    };
    let Some(client) = client else { return };
    let _guard = io.lock().await;
    let result = client.inventory().await;
    shared.lock().await.hue.apply(result, now(), record);
}
pub async fn run(shared: Shared) {
    if shared.lock().await.hue.client.is_none() {
        return;
    }
    loop {
        refresh(&shared, true).await;
        let wait = (now() / 60 + 1) * 60 - now();
        tokio::time::sleep(Duration::from_secs(wait.max(1) as u64)).await;
    }
}
pub async fn devices(State(shared): State<Shared>) -> Response {
    let s = shared.lock().await;
    let archive: Vec<_> = s
        .hue
        .devices
        .iter()
        .filter_map(|d| {
            let mut archived = d.clone();
            if d.selected {
                archived.outputs.retain(|o| o.connectivity == "removed");
            }
            if archived.outputs.is_empty() {
                None
            } else {
                Some(archived)
            }
        })
        .collect();
    Json(json!({"state":s.hue.state,"error":s.hue.error,"devices":s.hue.inventory,"archive":archive})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    device_id: String,
    selected: bool,
}
pub async fn select(State(shared): State<Shared>, Json(body): Json<Selection>) -> Response {
    let io = shared.lock().await.hue.io.clone();
    let _guard = io.lock().await;
    let mut s = shared.lock().await;
    if body.selected && s.hue.state != "online" {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Hue Bridgeへの接続を確認してください。",
        );
    }
    let mut next = s.hue.devices.clone();
    if body.selected {
        let Some(fresh) = s
            .hue
            .inventory
            .iter()
            .find(|d| d.id == body.device_id && d.present)
            .cloned()
        else {
            return error(StatusCode::BAD_REQUEST, "照明一覧から選択してください。");
        };
        if let Some(d) = next.iter_mut().find(|d| d.id == body.device_id) {
            d.selected = true;
        } else {
            let mut d = fresh;
            d.selected = true;
            next.push(d);
        }
        if next.iter().filter(|d| d.selected).count() > 128
            || next.iter().map(|d| d.outputs.len()).sum::<usize>() > 512
        {
            return error(StatusCode::CONFLICT, "登録上限に達しました。");
        }
    } else if let Some(d) = next.iter_mut().find(|d| d.id == body.device_id) {
        d.selected = false;
    } else {
        return error(StatusCode::NOT_FOUND, "照明が見つかりません。");
    }
    if s.hue.save(&next).is_err() {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "登録情報を保存できませんでした。",
        );
    }
    s.hue.devices = next;
    s.hue.catalog_dirty = false;
    for d in &mut s.hue.inventory {
        if d.id == body.device_id {
            d.selected = body.selected;
        }
    }
    Json(json!({"ok":true})).into_response()
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub light_id: String,
    pub on: Option<bool>,
    pub brightness: Option<f64>,
    pub mirek: Option<u32>,
    pub xy: Option<[f64; 2]>,
}
pub fn command_body(cmd: &Command, out: &Output) -> Result<Value> {
    ensure!(
        cmd.on.is_some() || cmd.brightness.is_some() || cmd.mirek.is_some() || cmd.xy.is_some(),
        "empty command"
    );
    ensure!(
        cmd.mirek.is_none() || cmd.xy.is_none(),
        "choose color or temperature"
    );
    let adjust = cmd.brightness.is_some() || cmd.mirek.is_some() || cmd.xy.is_some();
    ensure!(
        !(cmd.on == Some(false) && adjust),
        "cannot adjust and turn off together"
    );
    let mut body = json!({});
    if let Some(on) = cmd.on {
        body["on"] = json!({"on":on});
    } else if adjust {
        body["on"] = json!({"on":true});
    }
    if let Some(n) = cmd.brightness {
        ensure!(
            out.dimming && n.is_finite() && (0.0..=100.0).contains(&n),
            "invalid brightness"
        );
        body["dimming"] = json!({"brightness":n});
    }
    if let Some(n) = cmd.mirek {
        ensure!(
            out.temperature.is_some_and(|[a, b]| n >= a && n <= b),
            "invalid temperature"
        );
        body["color_temperature"] = json!({"mirek":n});
    }
    if let Some([x, y]) = cmd.xy {
        ensure!(
            out.color
                && x.is_finite()
                && y.is_finite()
                && (0.0..=1.0).contains(&x)
                && (0.0..=1.0).contains(&y)
                && x + y <= 1.000001,
            "invalid color"
        );
        let [x, y] = out.gamut.map_or([x, y], |g| clamp_gamut([x, y], g));
        body["color"] = json!({"xy":{"x":x,"y":y}});
    }
    Ok(body)
}
fn clamp_gamut(p: [f64; 2], g: [[f64; 2]; 3]) -> [f64; 2] {
    let cross = |a: [f64; 2], b: [f64; 2], p: [f64; 2]| {
        (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    };
    let c = [
        cross(g[0], g[1], p),
        cross(g[1], g[2], p),
        cross(g[2], g[0], p),
    ];
    if c.iter().all(|c| *c >= 0.) || c.iter().all(|c| *c <= 0.) {
        return p;
    }
    (0..3)
        .map(|i| {
            let a = g[i];
            let b = g[(i + 1) % 3];
            let dx = b[0] - a[0];
            let dy = b[1] - a[1];
            let denom = dx * dx + dy * dy;
            let t = if denom == 0. {
                0.
            } else {
                (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denom).clamp(0., 1.)
            };
            [a[0] + t * dx, a[1] + t * dy]
        })
        .min_by(|a, b| {
            let distance = |q: &[f64; 2]| (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2);
            distance(a).total_cmp(&distance(b))
        })
        .unwrap()
}
pub async fn control(State(shared): State<Shared>, Json(cmd): Json<Command>) -> Response {
    let (client, io) = {
        let s = shared.lock().await;
        (s.hue.client.clone(), s.hue.io.clone())
    };
    let Some(client) = client else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "Hueが未設定です。");
    };
    let Ok(_guard) = io.try_lock() else {
        return error(
            StatusCode::CONFLICT,
            "Hueの確認・操作中です。少し待って再度操作してください。",
        );
    };
    let out = {
        let s = shared.lock().await;
        s.hue
            .devices
            .iter()
            .filter(|d| d.selected && d.present)
            .flat_map(|d| &d.outputs)
            .find(|o| o.id == cmd.light_id && o.connectivity != "removed")
            .cloned()
    };
    let Some(out) = out else {
        return error(StatusCode::NOT_FOUND, "登録済みの照明を選択してください。");
    };
    if !out.available
        || shared
            .lock()
            .await
            .hue
            .last_poll
            .is_none_or(|t| now() - t > 180)
    {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "照明の状態を取得できません。",
        );
    }
    let Ok(body) = command_body(&cmd, &out) else {
        return error(
            StatusCode::BAD_REQUEST,
            "対応している操作と値を指定してください。",
        );
    };
    let result = client
        .request(
            reqwest::Method::PUT,
            &format!("light/{}", out.rid),
            Some(&body),
        )
        .await;
    // Also refresh after a failed response: a timed-out write may have been applied.
    if result.is_ok() {
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let fresh = client.inventory().await;
    let confirmed = fresh.as_ref().is_ok_and(|ds| {
        ds.iter()
            .flat_map(|d| &d.outputs)
            .any(|o| o.id == out.id && o.available)
    });
    shared.lock().await.hue.apply(fresh, now(), false);
    if result.is_err() {
        return error(
            StatusCode::BAD_GATEWAY,
            "操作結果を確認できませんでした。現在の状態を確認してから再操作してください。",
        );
    }
    if !confirmed {
        return error(
            StatusCode::BAD_GATEWAY,
            "指示は受け付けられましたが、状態を再取得できませんでした。",
        );
    }
    Json(shared.lock().await.hue.status(now())).into_response()
}

pub async fn upload(
    shared: &Shared,
    http: &reqwest::Client,
    cloud: &str,
    token: &str,
) -> Result<bool> {
    let (catalog, snapshot) = {
        let mut s = shared.lock().await;
        s.hue.prune(now());
        (s.hue.devices.iter().flat_map(|d|d.outputs.iter().map(|o|json!({"light_id":o.id,"device_id":d.id,"name":d.name,"output_name":o.name}))).collect::<Vec<_>>(),s.hue.pending.iter().cloned().collect::<Vec<_>>())
    };
    if catalog.is_empty() {
        return Ok(false);
    }
    let receipt = http
        .post(format!("{cloud}/api/v1/hue/lights"))
        .bearer_auth(token)
        .json(&json!({"lights":catalog}))
        .send()
        .await?;
    ensure!(
        receipt.status() == 200,
        "Hue registration HTTP {}",
        receipt.status().as_u16()
    );
    let receipt: Value = receipt.json().await?;
    ensure!(
        receipt["light_ids"]
            == json!(
                catalog
                    .iter()
                    .map(|r| r["light_id"].clone())
                    .collect::<Vec<_>>()
            ),
        "invalid Hue registration receipt"
    );
    for batch in snapshot.chunks(1000) {
        shared.lock().await.upload_requests += 1;
        let receipt = http
            .post(format!("{cloud}/api/v1/hue/samples"))
            .bearer_auth(token)
            .json(&json!({"samples":batch}))
            .send()
            .await?;
        ensure!(
            receipt.status() == 200,
            "Hue upload HTTP {}",
            receipt.status().as_u16()
        );
        let receipt: Value = receipt.json().await?;
        ensure!(
            receipt["accepted"].as_u64() == Some(batch.len() as u64),
            "invalid Hue upload receipt"
        );
        let accepted: HashSet<_> = batch.iter().map(|r| (&r.light_id, r.minute)).collect();
        let mut s = shared.lock().await;
        s.hue
            .pending
            .retain(|r| !accepted.contains(&(&r.light_id, r.minute)));
        s.last_sent = Some(now());
        s.cloud_state = "online".into();
        s.cloud_error = None;
    }
    Ok(!snapshot.is_empty())
}
#[derive(Deserialize)]
pub struct HistoryQuery {
    light_id: String,
    #[serde(default = "one")]
    days: i64,
}
fn one() -> i64 {
    1
}
pub fn aggregate(rows: &[&Sample], minute: i64) -> Value {
    let available = rows
        .iter()
        .filter(|r| r.available && r.values.on.is_some())
        .count();
    let on = rows
        .iter()
        .filter(|r| r.available && r.values.on == Some(true))
        .count();
    let brightness: Vec<_> = rows
        .iter()
        .filter(|r| r.available && r.values.on == Some(true))
        .filter_map(|r| r.values.brightness)
        .collect();
    let last_ct = rows
        .iter()
        .rev()
        .find_map(|r| if r.available { r.values.mirek } else { None });
    let last_color = rows
        .iter()
        .rev()
        .find(|r| r.available && r.values.x.is_some() && r.values.y.is_some());
    json!({"minute":minute,"on_fraction":if available>0{Some(on as f64/available as f64)}else{None},"available_count":available,"unavailable_count":rows.len()-available,"sample_count":rows.len(),"brightness":if brightness.is_empty(){None}else{Some(brightness.iter().sum::<f64>()/brightness.len() as f64)},"brightness_min":brightness.iter().copied().reduce(f64::min),"brightness_max":brightness.iter().copied().reduce(f64::max),"mirek":last_ct,"x":last_color.and_then(|r|r.values.x),"y":last_color.and_then(|r|r.values.y)})
}
pub async fn history(State(shared): State<Shared>, Query(q): Query<HistoryQuery>) -> Response {
    if ![1, 7, 30, 365].contains(&q.days) || !valid_id(&q.light_id) {
        return error(StatusCode::BAD_REQUEST, "invalid Hue history query");
    }
    let io = shared.lock().await.hue.history_io.clone();
    let _guard = io.lock().await;
    let time = now();
    let to = time / 60 * 60 + 60;
    let from = to - q.days * 86400;
    let bucket = if q.days == 365 { 3600 } else { 60 };
    let key = (q.light_id.clone(), q.days);
    let (http, cloud, token, fetch) = {
        let s = shared.lock().await;
        if !s
            .hue
            .devices
            .iter()
            .flat_map(|d| &d.outputs)
            .any(|o| o.id == q.light_id)
        {
            return error(StatusCode::BAD_REQUEST, "unknown Hue light");
        }
        let stale = s
            .hue
            .cache
            .get(&key)
            .is_none_or(|c| time - c.at >= 3600 || s.last_sent.unwrap_or(0) > c.at);
        (
            s.http.clone(),
            s.cloud.clone(),
            s.read.clone(),
            stale
                && s.hue.retry.get(&key).is_none_or(|t| time >= *t)
                && !s.cloud.is_empty()
                && !s.read.is_empty(),
        )
    };
    if fetch {
        let result: Result<Cache> = async {
            let response = http
                .get(format!("{cloud}/api/v1/hue/history"))
                .bearer_auth(token)
                .query(&[
                    ("light_id", q.light_id.clone()),
                    ("from", from.to_string()),
                    ("to", to.to_string()),
                    (
                        "resolution",
                        if bucket == 60 { "minute" } else { "hour" }.into(),
                    ),
                ])
                .send()
                .await?;
            ensure!(response.status() == 200, "Hue history HTTP error");
            let data: Value = response.json().await?;
            let rows = data["samples"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("invalid Hue history"))?
                .clone();
            ensure!(
                rows.len() <= 45000
                    && rows.iter().all(|r| r["minute"]
                        .as_i64()
                        .is_some_and(|t| t >= from && t < to && t % bucket == 0)),
                "invalid Hue history timestamps"
            );
            Ok(Cache {
                at: now(),
                bucket,
                rows,
            })
        }
        .await;
        let mut s = shared.lock().await;
        match result {
            Ok(cache) => {
                s.hue.cache.insert(key.clone(), cache);
                s.hue.retry.remove(&key);
                while s.hue.cache.values().map(|c| c.rows.len()).sum::<usize>() > 72000
                    && s.hue.cache.len() > 1
                {
                    let oldest = s
                        .hue
                        .cache
                        .iter()
                        .filter(|(k, _)| *k != &key)
                        .min_by_key(|(_, c)| c.at)
                        .map(|(k, _)| k.clone())
                        .unwrap();
                    s.hue.cache.remove(&oldest);
                }
            }
            Err(_) => {
                s.hue.retry.insert(key.clone(), time + 300);
            }
        }
    }
    let s = shared.lock().await;
    let cache = s.hue.cache.get(&key);
    let failed = s.hue.retry.contains_key(&key);
    let mut merged: BTreeMap<i64, Value> = cache
        .into_iter()
        .flat_map(|c| c.rows.iter())
        .filter_map(|r| {
            r["minute"]
                .as_i64()
                .filter(|m| *m >= from && *m < to)
                .map(|m| (m, r.clone()))
        })
        .collect();
    let mut groups: BTreeMap<i64, Vec<&Sample>> = BTreeMap::new();
    for r in s
        .hue
        .history
        .iter()
        .filter(|r| r.light_id == q.light_id && r.minute >= from && r.minute < to)
    {
        groups
            .entry(r.minute / bucket * bucket)
            .or_default()
            .push(r);
    }
    for (minute, rows) in groups {
        if bucket == 60 {
            merged.insert(minute, serde_json::to_value(rows[0]).unwrap());
        } else {
            if let (Some(existing), Some(cache)) = (merged.get(&minute), cache) {
                let end = (minute + bucket).min(cache.at / 60 * 60);
                if rows.len() < (existing["sample_count"].as_u64().unwrap_or(0) as usize)
                    || (minute..end)
                        .step_by(60)
                        .any(|t| !rows.iter().any(|r| r.minute == t))
                {
                    continue;
                }
            }
            merged.insert(minute, aggregate(&rows, minute));
        }
    }
    Json(json!({"samples":merged.values().collect::<Vec<_>>(),"source":if cache.is_none(){"memory"}else if failed{"cached"}else{"cloud"},"cloud_error":if failed{Some("クラウド履歴を取得できませんでした")}else{None},"bucket_seconds":bucket,"from":from,"to":to})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        http::Request,
        routing::{get, post},
    };
    use tower::ServiceExt;
    const BRIDGE: &str = "001788fffe123456";
    const DEVICE: &str = "00000000-0000-4000-8000-000000000001";
    const LIGHT: &str = "00000000-0000-4000-8000-000000000002";
    const SECOND: &str = "00000000-0000-4000-8000-000000000003";
    fn resources(on: bool, connected: bool) -> (Vec<Value>, Vec<Value>, Vec<Value>) {
        (
            vec![
                json!({"id":DEVICE,"metadata":{"name":"寝室"},"services":[{"rid":LIGHT,"rtype":"light"},{"rid":SECOND,"rtype":"light"},{"rid":"ignored","rtype":"grouped_light"}]}),
            ],
            vec![
                json!({"id":LIGHT,"owner":{"rid":DEVICE},"metadata":{"name":"左"},"on":{"on":on},"dimming":{"brightness":40},"color_temperature":{"mirek":250,"mirek_valid":true,"mirek_schema":{"mirek_minimum":153,"mirek_maximum":500}},"color":{"xy":{"x":0.3,"y":0.3},"gamut":{"red":{"x":0.7,"y":0.3},"green":{"x":0.2,"y":0.7},"blue":{"x":0.1,"y":0.1}}}}),
                json!({"id":SECOND,"owner":{"rid":DEVICE},"metadata":{"name":"右"},"on":{"on":on}}),
            ],
            vec![
                json!({"owner":{"rid":DEVICE},"status":if connected{"connected"}else{"disconnected"}}),
            ],
        )
    }
    fn inventory(on: bool, connected: bool) -> Vec<Device> {
        let (d, l, c) = resources(on, connected);
        parse_inventory(BRIDGE, &d, &l, &c).unwrap()
    }
    fn store() -> Hue {
        let mut h = Hue::new(None).unwrap();
        h.devices = inventory(false, true);
        h.devices[0].selected = true;
        h.inventory = h.devices.clone();
        h
    }
    async fn request(
        router: Router,
        path: &str,
        body: Option<Value>,
        csrf: bool,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().uri(path).header("host", "localhost");
        let body = if let Some(v) = body {
            req = req
                .method("POST")
                .header("content-type", "application/json");
            if csrf {
                req = req
                    .header("x-home-sensors", "1")
                    .header("origin", "http://localhost");
            }
            Body::from(v.to_string())
        } else {
            Body::empty()
        };
        let response = router.oneshot(req.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }
    #[test]
    fn individual_outputs_capabilities_ct_validity_and_command_semantics() {
        let mut ds = inventory(false, true);
        assert_eq!(ds.len(), 1);
        assert_eq!(ds[0].outputs.len(), 2);
        let out = &ds[0].outputs[0];
        assert!(out.available);
        assert_eq!(out.values.on, Some(false));
        assert_eq!(out.values.brightness, Some(40.));
        assert_eq!(out.temperature, Some([153, 500]));
        let body = command_body(
            &Command {
                brightness: Some(0.),
                ..Default::default()
            },
            out,
        )
        .unwrap();
        assert_eq!(body["on"]["on"], true);
        assert_eq!(body["dimming"]["brightness"], 0.);
        assert_eq!(
            command_body(
                &Command {
                    on: Some(false),
                    ..Default::default()
                },
                out
            )
            .unwrap(),
            json!({"on":{"on":false}})
        );
        for command in [
            Command {
                mirek: Some(501),
                ..Default::default()
            },
            Command {
                brightness: Some(101.),
                ..Default::default()
            },
            Command {
                mirek: Some(250),
                xy: Some([0.3, 0.3]),
                ..Default::default()
            },
            Command {
                on: Some(false),
                brightness: Some(50.),
                ..Default::default()
            },
        ] {
            assert!(command_body(&command, out).is_err());
        }
        assert!(
            command_body(
                &Command {
                    brightness: Some(50.),
                    ..Default::default()
                },
                &ds[0].outputs[1]
            )
            .is_err()
        );
        let clipped = clamp_gamut([0.99, 0.01], out.gamut.unwrap());
        assert!(clipped[0] < 0.8 && clipped[1] > 0.1);
        let (d, mut l, c) = resources(true, true);
        l[0]["color_temperature"]["mirek_valid"] = json!(false);
        ds = parse_inventory(BRIDGE, &d, &l, &c).unwrap();
        assert_eq!(ds[0].outputs[0].values.mirek, None);
        assert_eq!(ds[0].outputs[0].values.color_mode.as_deref(), Some("color"));
        assert_ne!(identity(BRIDGE, LIGHT), identity("different-bridge", LIGHT));
    }
    #[test]
    fn scheduled_snapshots_only_and_no_stale_values_in_gaps() {
        let mut h = store();
        h.apply(Ok(inventory(false, true)), 3601, true);
        assert_eq!(h.history.len(), 2);
        h.apply(Ok(inventory(true, true)), 3610, false);
        assert_eq!(h.history.len(), 2);
        assert_eq!(h.devices[0].outputs[0].values.on, Some(true));
        assert_eq!(h.history[0].values.on, Some(false));
        h.apply(Ok(inventory(true, true)), 3620, true);
        assert_eq!(h.history.len(), 2);
        h.apply(Ok(inventory(true, false)), 3661, true);
        assert_eq!(h.history[2].values.on, None);
        assert!(!h.history[2].available);
        assert_eq!(h.devices[0].outputs[0].values.on, Some(true));
        assert_eq!(h.devices[0].outputs[0].observed_at, Some(3620));
        h.apply(Err(anyhow::anyhow!("private details")), 3721, true);
        assert_eq!(h.history[4].connectivity, "bridge_unavailable");
        assert_eq!(h.history[4].values.brightness, None);
        assert!(!h.error.as_ref().unwrap().contains("private"));
        h.prune(3721 + 86400);
        assert!(h.history.is_empty());
        assert_eq!(h.dropped, 6);
    }
    #[test]
    fn hourly_fraction_is_not_duration_and_excludes_off_brightness() {
        let samples = [
            Sample {
                light_id: identity(BRIDGE, LIGHT),
                minute: 3600,
                observed_at: 3601,
                available: true,
                connectivity: "connected".into(),
                values: Values {
                    on: Some(true),
                    brightness: Some(20.),
                    mirek: Some(250),
                    ..Default::default()
                },
            },
            Sample {
                light_id: identity(BRIDGE, LIGHT),
                minute: 3660,
                observed_at: 3661,
                available: true,
                connectivity: "connected".into(),
                values: Values {
                    on: Some(false),
                    brightness: Some(100.),
                    x: Some(0.2),
                    y: Some(0.3),
                    ..Default::default()
                },
            },
            Sample {
                light_id: identity(BRIDGE, LIGHT),
                minute: 3720,
                observed_at: 3721,
                available: false,
                connectivity: "bridge_unavailable".into(),
                values: Values::default(),
            },
        ];
        let a = aggregate(&samples.iter().collect::<Vec<_>>(), 3600);
        assert_eq!(a["on_fraction"], 0.5);
        assert_eq!(a["brightness"], 20.);
        assert_eq!(a["available_count"], 2);
        assert_eq!(a["unavailable_count"], 1);
        assert_eq!(a["mirek"], 250);
        assert_eq!(a["x"], 0.2);
    }
    #[tokio::test]
    async fn removed_outputs_stay_archived_during_outage_and_partial_ram_keeps_cloud_hour() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hue.json");
        let mut h = store();
        h.path = Some(path.clone());
        let time = now();
        let minute = time / 60 * 60 - 120;
        h.apply(Ok(inventory(true, true)), minute + 1, true);
        let mut partial = inventory(true, true);
        partial[0].outputs.truncate(1);
        h.apply(Ok(partial), minute + 61, true);
        assert_eq!(h.devices[0].outputs[1].connectivity, "removed");
        let persisted: Vec<Device> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted[0].outputs[1].connectivity, "removed");
        h.apply(Err(anyhow::anyhow!("offline")), minute + 121, true);
        assert_eq!(h.devices[0].outputs[1].connectivity, "removed");
        assert_eq!(h.history.len(), 4);
        let light = identity(BRIDGE, LIGHT);
        let hour = minute / 3600 * 3600;
        h.cache.insert((light.clone(),365),Cache{at:time,bucket:3600,rows:vec![json!({"minute":hour,"on_fraction":0.25,"sample_count":45,"available_count":40,"unavailable_count":5,"brightness":30})]});
        let shared = Arc::new(tokio::sync::Mutex::new(
            crate::Service::new(crate::Config::default()).unwrap(),
        ));
        shared.lock().await.hue = h;
        let router = crate::app(shared, "dist".into());
        let (_, archive) = request(router.clone(), "/api/hue/devices", None, false).await;
        assert_eq!(
            archive["archive"][0]["outputs"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            archive["archive"][0]["outputs"][0]["id"],
            identity(BRIDGE, SECOND)
        );
        let (_, history) = request(
            router,
            &format!("/api/hue/history?light_id={light}&days=365"),
            None,
            false,
        )
        .await;
        let row = history["samples"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["minute"] == hour)
            .unwrap();
        assert_eq!(row["sample_count"], 45);
        assert_eq!(row["on_fraction"], 0.25);
    }
    #[tokio::test]
    async fn selection_control_archive_and_extra_read_without_snapshot() {
        let state = Arc::new(tokio::sync::Mutex::new(false));
        let puts = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
        let fake = Router::new()
            .route(
                "/clip/v2/resource/device",
                get(|| async { Json(json!({"data":resources(false,true).0,"errors":[]})) }),
            )
            .route(
                "/clip/v2/resource/zigbee_connectivity",
                get(|| async { Json(json!({"data":resources(false,true).2,"errors":[]})) }),
            )
            .route(
                "/clip/v2/resource/light",
                get({
                    let state = state.clone();
                    move || {
                        let state = state.clone();
                        async move {
                            Json(json!({"data":resources(*state.lock().await,true).1,"errors":[]}))
                        }
                    }
                }),
            )
            .route(
                &format!("/clip/v2/resource/light/{LIGHT}"),
                axum::routing::put({
                    let state = state.clone();
                    let puts = puts.clone();
                    move |Json(body): Json<Value>| {
                        let state = state.clone();
                        let puts = puts.clone();
                        async move {
                            *state.lock().await = body["on"]["on"].as_bool().unwrap();
                            puts.lock().await.push(body);
                            Json(json!({"data":[{"rid":LIGHT,"rtype":"light"}],"errors":[]}))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let shared = Arc::new(tokio::sync::Mutex::new(
            crate::Service::new(crate::Config::default()).unwrap(),
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hue.json");
        {
            let mut s = shared.lock().await;
            s.hue.path = Some(path.clone());
            s.hue.client = Some(Client {
                http: reqwest::Client::new(),
                url,
                key: "test-key".into(),
                bridge: BRIDGE.into(),
            });
        }
        refresh(&shared, true).await;
        assert!(shared.lock().await.hue.history.is_empty());
        let router = crate::app(shared.clone(), "dist".into());
        let id = identity(BRIDGE, DEVICE);
        let light = identity(BRIDGE, LIGHT);
        assert_eq!(
            request(
                router.clone(),
                "/api/hue/devices",
                Some(json!({"device_id":id,"selected":true})),
                false
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                router.clone(),
                "/api/hue/devices",
                Some(json!({"device_id":id,"selected":true})),
                true
            )
            .await
            .0,
            StatusCode::OK
        );
        let (_, data) = request(
            router.clone(),
            "/api/hue/control",
            Some(json!({"light_id":light,"brightness":50})),
            true,
        )
        .await;
        assert_eq!(data["devices"][0]["outputs"][0]["values"]["on"], true);
        assert_eq!(puts.lock().await.len(), 1);
        assert!(shared.lock().await.hue.history.is_empty());
        refresh(&shared, true).await;
        assert_eq!(shared.lock().await.hue.history.len(), 2);
        request(
            router.clone(),
            "/api/hue/devices",
            Some(json!({"device_id":id,"selected":false})),
            true,
        )
        .await;
        assert_eq!(
            request(
                router.clone(),
                "/api/hue/control",
                Some(json!({"light_id":light,"on":false})),
                true
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        let (_, data) = request(
            router.clone(),
            &format!("/api/hue/history?light_id={light}&days=1"),
            None,
            false,
        )
        .await;
        assert_eq!(data["samples"].as_array().unwrap().len(), 1);
        let persisted: Vec<Device> = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert!(!persisted[0].selected);
        assert_eq!(puts.lock().await.len(), 1);
        assert!(!data.to_string().contains("test-key"));
        server.abort();
    }
    #[tokio::test]
    async fn upload_receipt_retains_queue_on_failure_then_deduplicates() {
        let calls = Arc::new(tokio::sync::Mutex::new(Vec::<Value>::new()));
        let fake=Router::new().route("/api/v1/hue/lights",post(|Json(body):Json<Value>|async move{Json(json!({"light_ids":body["lights"].as_array().unwrap().iter().map(|r|r["light_id"].clone()).collect::<Vec<_>>()}))}))
            .route("/api/v1/hue/samples",post({let calls=calls.clone();move|Json(body):Json<Value>|{let calls=calls.clone();async move{let mut calls=calls.lock().await;calls.push(body.clone());Json(json!({"accepted":if calls.len()==1{0}else{body["samples"].as_array().unwrap().len()}}))}}}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
        let shared = Arc::new(tokio::sync::Mutex::new(
            crate::Service::new(crate::Config::default()).unwrap(),
        ));
        let http = reqwest::Client::new();
        {
            let mut s = shared.lock().await;
            s.hue = store();
            s.hue.apply(Ok(inventory(true, true)), now(), true);
        }
        assert!(upload(&shared, &http, &url, "token").await.is_err());
        assert_eq!(shared.lock().await.hue.pending.len(), 2);
        assert!(upload(&shared, &http, &url, "token").await.unwrap());
        assert!(shared.lock().await.hue.pending.is_empty());
        let calls = calls.lock().await;
        assert_eq!(calls[0], calls[1]);
        server.abort();
    }
}
