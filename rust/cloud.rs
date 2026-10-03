use crate::{Shared, error, now};
use anyhow::{Result, ensure};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone)]
pub struct Cache {
    pub at: i64,
    pub bucket: i64,
    pub rows: Vec<Value>,
}
// Serialize history fetches without holding the collection lock across network I/O.
static HISTORY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn response(response: reqwest::Response) -> Result<Value> {
    ensure!(
        response.status() == 200,
        "HTTP {}",
        response.status().as_u16()
    );
    Ok(response.json().await?)
}
pub async fn send_due(shared: &Shared, time: i64) -> bool {
    let (http, cloud, token, snapshot, registrations) = {
        let mut s = shared.lock().await;
        s.store.prune(time);
        if s.cloud.is_empty() || s.ingest.is_empty() {
            s.cloud_state = "unconfigured".into();
            return false;
        }
        if time < s.next_send_at {
            return false;
        }
        s.next_send_at = (time / s.send_interval + 1) * s.send_interval + 2;
        (
            s.http.clone(),
            s.cloud.clone(),
            s.ingest.clone(),
            s.store.pending.iter().cloned().collect::<Vec<_>>(),
            s.registry
                .iter()
                .filter(|s| s.cloud_synced != Some(true))
                .map(|s| s.id.clone())
                .collect::<Vec<_>>(),
        )
    };
    let mut hue_sent = false;
    let result: Result<()> = async {
        if !registrations.is_empty() {
            let receipt = response(
                http.post(format!("{cloud}/api/v1/sensors"))
                    .bearer_auth(&token)
                    .json(&json!({"sensor_ids":registrations}))
                    .send()
                    .await?,
            )
            .await?;
            ensure!(
                receipt["sensor_ids"] == json!(registrations),
                "invalid registration receipt"
            );
            let mut s = shared.lock().await;
            let mut rows = s.registry.clone();
            for row in &mut rows {
                if registrations.contains(&row.id) {
                    row.cloud_synced = Some(true);
                }
            }
            crate::registry::save(s.registry_path.as_deref(), &rows)?;
            s.registry = rows;
            s.history_retry.clear();
        }
        for batch in snapshot.chunks(1000) {
            shared.lock().await.upload_requests += 1;
            let receipt = response(
                http.post(format!("{cloud}/api/v1/samples"))
                    .bearer_auth(&token)
                    .json(&json!({"samples":batch}))
                    .send()
                    .await?,
            )
            .await?;
            ensure!(
                receipt["accepted"].as_u64() == Some(batch.len() as u64),
                "invalid receipt"
            );
            let accepted: HashSet<_> = batch
                .iter()
                .map(|r| (r.sensor_id.as_str(), r.minute))
                .collect();
            let mut s = shared.lock().await;
            s.store
                .pending
                .retain(|r| !accepted.contains(&(r.sensor_id.as_str(), r.minute)));
            s.last_sent = Some(now());
            s.cloud_state = "online".into();
            s.cloud_error = None;
        }
        hue_sent = crate::hue::upload(shared, &http, &cloud, &token).await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let mut s = shared.lock().await;
        s.cloud_state = "offline".into();
        s.cloud_error = Some(safe_error(&e));
        crate::log_error(&format!("cloud upload: {}", safe_error(&e)));
        return false;
    }
    !snapshot.is_empty() || hue_sent
}
fn safe_error(e: &anyhow::Error) -> String {
    // reqwest errors may carry URLs; tokens and request details never go to clients.
    if e.downcast_ref::<reqwest::Error>().is_some() {
        "network error".into()
    } else {
        e.to_string()
    }
}
#[derive(Deserialize)]
pub struct HistoryQuery {
    sensor_id: String,
    #[serde(default = "one")]
    days: i64,
}
fn one() -> i64 {
    1
}
pub async fn history(State(shared): State<Shared>, Query(query): Query<HistoryQuery>) -> Response {
    let id = query.sensor_id;
    let days = query.days;
    let time = now();
    if ![1, 7, 30, 365].contains(&days)
        || !shared.lock().await.store.sensors.iter().any(|s| s.id == id)
    {
        return error(StatusCode::BAD_REQUEST, "invalid history query");
    }
    let to = time / 60 * 60 + 60;
    let start = to - days * 86400;
    let key = (id.clone(), days);
    let _guard = HISTORY_LOCK.lock().await;
    let (http, cloud, token, fetch) = {
        let s = shared.lock().await;
        let registered = !s
            .registry
            .iter()
            .any(|r| r.id == id && r.cloud_synced != Some(true));
        let stale = s
            .cache
            .get(&key)
            .is_none_or(|c| time - c.at >= 3600 || s.last_sent.unwrap_or(0) > c.at);
        let retry = s.history_retry.get(&key).is_none_or(|(at, _)| time >= *at);
        (
            s.http.clone(),
            s.cloud.clone(),
            s.read.clone(),
            registered && stale && retry && !s.cloud.is_empty() && !s.read.is_empty(),
        )
    };
    if fetch {
        let result: Result<Cache> = async {
            let data = response(
                http.get(format!("{cloud}/api/v1/history"))
                    .bearer_auth(token)
                    .query(&[
                        ("sensor_id", id.clone()),
                        ("from", start.to_string()),
                        ("to", to.to_string()),
                        (
                            "resolution",
                            if days == 365 { "hour" } else { "minute" }.into(),
                        ),
                    ])
                    .send()
                    .await?,
            )
            .await?;
            let rows = data["samples"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("invalid history receipt"))?
                .clone();
            let bucket =
                data["bucket_seconds"]
                    .as_i64()
                    .unwrap_or(if days == 365 { 3600 } else { 60 });
            ensure!(matches!(bucket, 60 | 3600), "invalid bucket");
            ensure!(
                rows.iter().all(|r| r["minute"].as_i64().is_some()),
                "invalid history timestamp"
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
                s.cache.insert(key.clone(), cache);
                s.history_retry.remove(&key);
                while s.cache.values().map(|c| c.rows.len()).sum::<usize>() > 72000
                    && s.cache.len() > 1
                {
                    let oldest = s
                        .cache
                        .iter()
                        .filter(|(k, _)| *k != &key)
                        .min_by_key(|(_, c)| c.at)
                        .map(|(k, _)| k.clone())
                        .unwrap();
                    s.cache.remove(&oldest);
                }
            }
            Err(e) => {
                s.history_retry
                    .insert(key.clone(), (time + 3600, safe_error(&e)));
            }
        }
    }
    let s = shared.lock().await;
    let cached = s.cache.get(&key);
    let bucket = cached.map_or(if days == 365 { 3600 } else { 60 }, |c| c.bucket);
    let cloud_error = s.history_retry.get(&key).map(|(_, e)| e);
    let source = if cached.is_none() {
        "memory"
    } else if cloud_error.is_some() {
        "cached"
    } else {
        "cloud"
    };
    let mut merged: BTreeMap<i64, Value> = cached
        .into_iter()
        .flat_map(|c| c.rows.iter())
        .filter_map(|r| {
            r["minute"]
                .as_i64()
                .filter(|m| *m >= start && *m < to)
                .map(|m| (m, r.clone()))
        })
        .collect();
    let mut grouped: BTreeMap<i64, Vec<&crate::store::Sample>> = BTreeMap::new();
    for row in &s.store.history {
        if row.sensor_id == id && row.minute >= start && row.minute < to {
            grouped
                .entry(row.minute / bucket * bucket)
                .or_default()
                .push(row);
        }
    }
    for (timestamp, samples) in grouped {
        if let (Some(existing), Some(cache)) = (merged.get(&timestamp), cached) {
            let end = (timestamp + bucket).min(cache.at / 60 * 60);
            if (timestamp..end)
                .step_by(60)
                .any(|t| !samples.iter().any(|s| s.minute == t))
                || samples.len() < (existing["sample_count"].as_u64().unwrap_or(0) as usize)
            {
                continue;
            }
        }
        let mut output = json!({"minute":timestamp,"sample_count":samples.len()});
        for metric in ["temperature", "humidity", "co2"] {
            let values: Vec<f64> = samples
                .iter()
                .filter_map(|s| match metric {
                    "temperature" => s.values.temperature,
                    "humidity" => s.values.humidity,
                    _ => s.values.co2,
                })
                .collect();
            output[metric] = json!(if values.is_empty() {
                None
            } else {
                Some(values.iter().sum::<f64>() / values.len() as f64)
            });
            output[format!("{metric}_min")] = json!(values.iter().copied().reduce(f64::min));
            output[format!("{metric}_max")] = json!(values.iter().copied().reduce(f64::max));
        }
        merged.insert(timestamp, output);
    }
    Json(json!({"available_since":merged.keys().next(),"samples":merged.values().collect::<Vec<_>>(),"source":source,"cloud_error":cloud_error,"bucket_seconds":bucket,"from":start,"to":to})).into_response()
}
