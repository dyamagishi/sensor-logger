use super::*;
use axum::extract::Query;
use axum::{
    body::{Body, to_bytes},
    http::Request as HttpRequest,
};
use tower::ServiceExt;

fn service() -> Shared {
    Arc::new(Mutex::new(
        Service::new(Config {
            sensors: vec![Sensor {
                id: "a".into(),
                address: "AA:BB:CC:DD:EE:FF".into(),
                name: "A".into(),
                kind: "meter".into(),
                cloud_synced: None,
            }],
            ..Default::default()
        })
        .unwrap(),
    ))
}
fn packet() -> Vec<u8> {
    let mut body = vec![2, 2];
    for fields in [
        vec![6, 0x16, 0x3d, 0xfd, 0x35, 0, 100],
        vec![
            19, 0xff, 0x69, 9, 0x02, 0x11, 0x22, 0x33, 0x44, 0x55, 0x2f, 0xe4, 7, 0x9a, 45, 0, 5,
            4, 0x59, 0x20,
        ],
    ] {
        body.extend([4, 0, 0x55, 0x44, 0x33, 0x22, 0x11, 0x02, fields.len() as u8]);
        body.extend(fields);
        body.push(0xc4);
    }
    let mut packet = vec![4, 0x3e, body.len() as u8];
    packet.extend(body);
    packet
}
async fn request(app: Router, path: &str, body: Option<Value>, csrf: bool) -> (StatusCode, Value) {
    let mut builder = HttpRequest::builder().uri(path).header("host", "localhost");
    let body = if let Some(body) = body {
        builder = builder
            .method("POST")
            .header("content-type", "application/json");
        if csrf {
            builder = builder
                .header("x-home-sensors", "1")
                .header("origin", "http://localhost");
        }
        Body::from(body.to_string())
    } else {
        Body::empty()
    };
    let res = app.oneshot(builder.body(body).unwrap()).await.unwrap();
    let code = res.status();
    let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (code, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn ble_diagnostics_count_reports_without_changing_collection() {
    let shared = service();
    let started = now();
    {
        let mut s = shared.lock().await;
        s.store.sensors[0].address = "02:11:22:33:44:55".into();
        s.scanner.state = "scanning".into();
    }
    ble::consume(&shared, &packet()).await;
    let mut s = shared.lock().await;
    assert_eq!(s.store.events["a"], 1);
    let Service { scanner, store, .. } = &mut *s;
    let logs = scanner.diagnostic_logs(store, started + 300, started);
    assert_eq!(logs.len(), 1);
    assert!(logs[0].contains("received=2 accepted=1"));
    assert!(logs[0].contains("no_manufacturer_in_report\": 1"));
}

#[tokio::test]
async fn discovery_registration_persistence_and_csrf() {
    let s = service();
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("sensors.json");
    {
        let mut s = s.lock().await;
        s.registry_path = Some(path.clone());
        s.scanner.state = "scanning".into();
    }
    let router = app(s.clone(), "dist".into());
    ble::consume(&s, &packet()).await;
    assert!(s.lock().await.scanner.candidates.is_empty());
    assert_eq!(
        request(router.clone(), "/api/discovery", Some(json!({})), false)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    request(router.clone(), "/api/discovery", Some(json!({})), true).await;
    ble::consume(&s, &packet()).await;
    let (_, found) = request(router.clone(), "/api/discovery", None, false).await;
    assert_eq!(found["devices"][0]["co2"], 1113.);
    let body = json!({"address":"02:11:22:33:44:55","name":"寝室 <テスト>"});
    let (a, b) = tokio::join!(
        request(router.clone(), "/api/sensors", Some(body.clone()), true),
        request(router.clone(), "/api/sensors", Some(body), true)
    );
    let mut codes = vec![a.0.as_u16(), b.0.as_u16()];
    codes.sort();
    assert_eq!(codes, [201, 409]);
    let rows = registry::load(Some(&path)).unwrap();
    assert_eq!(rows[0].name, "寝室 <テスト>");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let before = s.lock().await.store.events[&rows[0].id];
    ble::consume(&s, &packet()).await;
    assert_eq!(s.lock().await.store.events[&rows[0].id], before + 1);
    // Every truncated HCI frame is safe to parse, including partial AD fields.
    for n in 0..packet().len() {
        ble::consume(&s, &packet()[..n]).await;
    }
}
#[tokio::test]
async fn upload_receipt_retry_batching_and_registry_order() {
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let capture = calls.clone();
    let fake = Router::new()
        .route(
            "/api/v1/sensors",
            post({
                let capture = capture.clone();
                move |Json(v): Json<Value>| {
                    let capture = capture.clone();
                    async move {
                        capture.lock().await.push(v.clone());
                        Json(v)
                    }
                }
            }),
        )
        .route(
            "/api/v1/samples",
            post(move |Json(v): Json<Value>| {
                let capture = capture.clone();
                async move {
                    let mut calls = capture.lock().await;
                    calls.push(v.clone());
                    let accepted = if calls.len() == 2 {
                        0
                    } else {
                        v["samples"].as_array().unwrap().len()
                    };
                    Json(json!({"accepted":accepted}))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
    let s = service();
    let tmp = tempfile::tempdir().unwrap();
    let time = now();
    let minute = time / 60 * 60 - 60;
    {
        let mut s = s.lock().await;
        s.cloud = format!("http://{address}");
        s.ingest = "test".into();
        s.next_send_at = time;
        s.registry_path = Some(tmp.path().join("sensors.json"));
        s.registry.push(Sensor {
            id: registry::sensor_id("02:11:22:33:44:55"),
            address: "02:11:22:33:44:55".into(),
            name: "test".into(),
            kind: "co2".into(),
            cloud_synced: Some(false),
        });
        for n in 0..1001 {
            s.store.pending.push_back(store::Sample {
                sensor_id: format!("s{n}"),
                minute,
                observed_at: minute + 1,
                values: store::Values {
                    temperature: Some(20.),
                    ..Default::default()
                },
            });
        }
    }
    assert!(!cloud::send_due(&s, time - 1).await);
    assert!(calls.lock().await.is_empty());
    assert!(!cloud::send_due(&s, time).await);
    assert_eq!(s.lock().await.store.pending.len(), 1001);
    assert!(!cloud::send_due(&s, time + 1).await);
    assert_eq!(calls.lock().await.len(), 2);
    let due = s.lock().await.next_send_at;
    assert!(cloud::send_due(&s, due).await);
    assert!(s.lock().await.store.pending.is_empty());
    let calls = calls.lock().await;
    assert!(calls[0]["sensor_ids"].is_array());
    assert_eq!(calls[1], calls[2]);
    assert_eq!(calls[3]["samples"].as_array().unwrap().len(), 1);
    server.abort();
}
#[tokio::test]
async fn history_cache_spikes_and_partial_hour() {
    let s = service();
    let time = now();
    let minute = time / 60 * 60 - 180;
    let hour = minute / 3600 * 3600;
    {
        let mut s = s.lock().await;
        s.cache.insert(
            ("a".into(), 1),
            cloud::Cache {
                at: time,
                bucket: 60,
                rows: vec![json!({"minute":minute,"temperature":80})],
            },
        );
        s.cache.insert(
            ("a".into(), 365),
            cloud::Cache {
                at: time,
                bucket: 3600,
                rows: vec![json!({"minute":hour,"temperature":20,"sample_count":30})],
            },
        );
        s.store.observe(
            "a",
            store::Values {
                temperature: Some(25.),
                ..Default::default()
            },
            minute + 61,
        );
        s.store.finalize(minute + 60, time);
    }
    let router = app(s, "dist".into());
    let (_, data) = request(
        router.clone(),
        "/api/history?sensor_id=a&days=1",
        None,
        false,
    )
    .await;
    assert_eq!(data["samples"][0]["temperature"], 80);
    assert_eq!(data["samples"][1]["temperature"], 25.);
    let (_, data) = request(router, "/api/history?sensor_id=a&days=365", None, false).await;
    assert_eq!(data["samples"][0]["sample_count"], 30);
    assert_eq!(data["samples"][0]["temperature"], 20);
}

#[tokio::test]
async fn history_fetch_cache_and_failure_backoff() {
    let calls = Arc::new(Mutex::new(0usize));
    let capture = calls.clone();
    let minute = now() / 60 * 60 - 60;
    let fake = Router::new().route(
        "/api/v1/history",
        get(move |Query(q): Query<HashMap<String, String>>| {
            let capture = capture.clone();
            async move {
                *capture.lock().await += 1;
                if q["resolution"] == "hour" {
                    return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))).into_response();
                }
                Json(json!({"samples":[{"minute":minute,"temperature":80}],"bucket_seconds":60}))
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, fake).await.unwrap() });
    let s = service();
    {
        let mut s = s.lock().await;
        s.cloud = format!("http://{address}");
        s.read = "test".into();
    }
    let router = app(s, "dist".into());
    for _ in 0..3 {
        let (_, data) = request(
            router.clone(),
            "/api/history?sensor_id=a&days=1",
            None,
            false,
        )
        .await;
        assert_eq!(data["source"], "cloud");
        assert_eq!(data["samples"][0]["temperature"], 80);
    }
    assert_eq!(*calls.lock().await, 1);
    for _ in 0..3 {
        let (_, data) = request(
            router.clone(),
            "/api/history?sensor_id=a&days=365",
            None,
            false,
        )
        .await;
        assert_eq!(data["source"], "memory");
        assert_eq!(data["cloud_error"], "HTTP 503");
    }
    assert_eq!(*calls.lock().await, 2);
    assert_eq!(
        request(
            router,
            "/api/history?sensor_id=a&days=9223372036854775807",
            None,
            false
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    server.abort();
}
