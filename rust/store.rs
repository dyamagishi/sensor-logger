use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Sensor {
    pub id: String,
    pub address: String,
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloud_synced: Option<bool>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Values {
    pub temperature: Option<f64>,
    pub humidity: Option<f64>,
    pub co2: Option<f64>,
    pub battery: Option<f64>,
    pub rssi: Option<f64>,
}
impl Values {
    pub fn checked(mut self) -> Self {
        for (v, low, high) in [
            (&mut self.temperature, -50., 100.),
            (&mut self.humidity, 0., 100.),
            (&mut self.co2, 1., 9999.),
            (&mut self.battery, 0., 100.),
            (&mut self.rssi, -127., 20.),
        ] {
            *v = v.filter(|x| x.is_finite() && *x >= low && *x <= high);
        }
        self
    }
    pub fn valid(&self) -> bool {
        self.temperature.is_some() || self.humidity.is_some() || self.co2.is_some()
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Sample {
    pub sensor_id: String,
    pub observed_at: i64,
    pub minute: i64,
    #[serde(flatten)]
    pub values: Values,
}
pub struct Store {
    pub sensors: Vec<Sensor>,
    pub latest: HashMap<String, Sample>,
    pub current: HashMap<(String, i64), Sample>,
    pub history: VecDeque<Sample>,
    pub pending: VecDeque<Sample>,
    pub events: HashMap<String, u64>,
    pub dropped: u64,
    retention: i64,
}
impl Store {
    pub fn new(sensors: Vec<Sensor>, retention: i64) -> Self {
        Self {
            sensors,
            retention,
            latest: HashMap::new(),
            current: HashMap::new(),
            history: VecDeque::new(),
            pending: VecDeque::new(),
            events: HashMap::new(),
            dropped: 0,
        }
    }
    pub fn observe(&mut self, id: &str, values: Values, now: i64) {
        let values = values.checked();
        if !values.valid() {
            return;
        }
        let row = Sample {
            sensor_id: id.into(),
            observed_at: now,
            minute: now / 60 * 60,
            values,
        };
        self.latest.insert(id.into(), row.clone());
        self.current.insert((id.into(), row.minute), row);
        *self.events.entry(id.into()).or_default() += 1;
    }
    pub fn prune(&mut self, now: i64) {
        let cutoff = now - self.retention;
        self.history.retain(|r| r.minute >= cutoff);
        let before = self.pending.len();
        self.pending.retain(|r| r.minute >= cutoff);
        self.dropped += (before - self.pending.len()) as u64;
        self.current.retain(|(_, m), _| *m >= cutoff);
    }
    pub fn finalize(&mut self, minute: i64, now: i64) {
        self.prune(now);
        for sensor in &self.sensors {
            if let Some(row) = self.current.remove(&(sensor.id.clone(), minute)) {
                self.history.push_back(row.clone());
                self.pending.push_back(row);
            }
        }
    }
    pub fn status(&self, now: i64) -> Vec<Value> {
        self.sensors
            .iter()
            .map(|s| {
                let mut row = serde_json::to_value(s).unwrap();
                row.as_object_mut().unwrap().remove("address");
                if let Some(latest) = self.latest.get(&s.id) {
                    let mut v = serde_json::to_value(latest).unwrap();
                    v.as_object_mut().unwrap().remove("minute");
                    row.as_object_mut()
                        .unwrap()
                        .extend(v.as_object().unwrap().clone());
                }
                row["stale"] =
                    json!(now - self.latest.get(&s.id).map_or(0, |r| r.observed_at) >= 180);
                row["events"] = json!(self.events.get(&s.id).copied().unwrap_or(0));
                row
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_carry_forward_and_expiry() {
        let mut s = Store::new(
            vec![Sensor {
                id: "a".into(),
                address: "".into(),
                name: "A".into(),
                kind: "meter".into(),
                cloud_synced: None,
            }],
            120,
        );
        s.observe(
            "a",
            Values {
                temperature: Some(20.),
                ..Default::default()
            },
            61,
        );
        s.observe(
            "a",
            Values {
                temperature: Some(21.),
                ..Default::default()
            },
            119,
        );
        s.finalize(60, 120);
        s.finalize(120, 180);
        assert_eq!(s.history.len(), 1);
        assert_eq!(s.history[0].values.temperature, Some(21.));
        s.prune(181);
        assert!(s.pending.is_empty());
        assert_eq!(s.dropped, 1);
    }
}
