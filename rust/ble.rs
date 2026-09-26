// On macOS the decoder is exercised by tests; live HCI is Linux-only.
#![cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
use crate::{Shared, now, store::Values};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default, Clone)]
pub struct Advertisement {
    pub service: HashMap<u16, Vec<u8>>,
    pub manufacturer: HashMap<u16, Vec<u8>>,
    pub rssi: i8,
}
pub fn reports(packet: &[u8]) -> Vec<(String, Advertisement)> {
    let mut out = vec![];
    if packet.len() < 5 || packet[..2] != [4, 0x3e] || packet[3] != 2 {
        return out;
    }
    let mut pos = 5;
    for _ in 0..packet[4] {
        if pos + 10 > packet.len() {
            break;
        }
        let address = packet[pos + 2..pos + 8]
            .iter()
            .rev()
            .map(|b| format!("{b:02X}"))
            .collect::<Vec<_>>()
            .join(":");
        let end = pos + 9 + packet[pos + 8] as usize;
        if end >= packet.len() {
            break;
        }
        let data = &packet[pos + 9..end];
        let mut adv = Advertisement {
            rssi: packet[end] as i8,
            ..Default::default()
        };
        let mut offset = 0;
        while offset < data.len() {
            let size = data[offset] as usize;
            if size == 0 || offset + size >= data.len() {
                break;
            }
            let value = &data[offset + 2..offset + size + 1];
            if value.len() >= 2 {
                let id = u16::from_le_bytes([value[0], value[1]]);
                match data[offset + 1] {
                    0xff => {
                        adv.manufacturer.insert(id, value[2..].to_vec());
                    }
                    0x16 => {
                        adv.service.insert(id, value[2..].to_vec());
                    }
                    _ => {}
                }
            }
            offset += size + 1;
        }
        out.push((address, adv));
        pos = end + 1;
    }
    out
}
pub fn decode(adv: &Advertisement) -> Option<Values> {
    let service = adv
        .service
        .get(&0xfd3d)
        .or_else(|| adv.service.get(&0x0d00))?;
    let model = service.first()? & 0x7f;
    if !matches!(
        model,
        b'w' | b'W' | b'i' | b'I' | b't' | b'T' | b'4' | 0x14 | b'5' | 0x15
    ) {
        return None;
    }
    let manufacturer = adv.manufacturer.get(&2409);
    let temp = manufacturer
        .filter(|m| m.len() >= 11)
        .map(|m| &m[8..11])
        .or_else(|| service.get(3..6))?;
    let battery = service.get(2).map(|v| (v & 127) as f64);
    let temperature = ((temp[1] & 127) as f64 + (temp[0] & 15) as f64 / 10.)
        * if temp[1] & 128 != 0 { 1. } else { -1. };
    let humidity = (temp[2] & 127) as f64;
    if temperature == 0. && humidity == 0. && battery == Some(0.) {
        return None;
    }
    let co2 = if matches!(model, b'5' | 0x15) {
        manufacturer
            .and_then(|m| m.get(13..15))
            .map(|v| u16::from_be_bytes([v[0], v[1]]) as f64)
    } else {
        None
    };
    Some(
        Values {
            temperature: Some(temperature),
            humidity: Some(humidity),
            co2,
            battery,
            rssi: Some(adv.rssi as f64),
        }
        .checked(),
    )
}
#[derive(Default)]
pub struct Scanner {
    pub state: String,
    pub error: Option<String>,
    pub last_event: Option<i64>,
    pub discovery_until: i64,
    cache: HashMap<String, (Advertisement, i64)>,
    pub candidates: HashMap<String, Value>,
}
impl Scanner {
    pub fn disabled() -> Self {
        Self {
            state: "disabled".into(),
            ..Default::default()
        }
    }
    pub fn discovered(&self, store: &crate::store::Store) -> Vec<Value> {
        self.candidates
            .values()
            .filter(|v| now() - v["observed_at"].as_i64().unwrap_or(0) < 180)
            .map(|v| {
                let mut v = v.clone();
                let sensor = store
                    .sensors
                    .iter()
                    .find(|s| Some(s.address.as_str()) == v["address"].as_str());
                v["registered"] = json!(sensor.is_some());
                v["registered_name"] = json!(sensor.map(|s| &s.name));
                v
            })
            .collect()
    }
}
pub async fn consume(shared: &Shared, packet: &[u8]) {
    let mut s = shared.lock().await;
    let time = now();
    for (address, adv) in reports(packet) {
        let id = s
            .store
            .sensors
            .iter()
            .find(|s| s.address == address)
            .map(|s| s.id.clone());
        let discovering = time < s.scanner.discovery_until;
        if id.is_none() && !discovering {
            continue;
        }
        if !s.scanner.cache.contains_key(&address) && s.scanner.cache.len() >= 256 {
            let oldest = s
                .scanner
                .cache
                .iter()
                .filter(|(a, _)| !s.store.sensors.iter().any(|s| &s.address == *a))
                .min_by_key(|(_, (_, t))| *t)
                .map(|(a, _)| a.clone());
            let Some(oldest) = oldest else {
                continue;
            };
            s.scanner.cache.remove(&oldest);
            s.scanner.candidates.remove(&oldest);
        }
        let has_manufacturer = !adv.manufacturer.is_empty();
        let entry = s.scanner.cache.entry(address.clone()).or_default();
        entry.0.service.extend(adv.service);
        entry.0.manufacturer.extend(adv.manufacturer);
        entry.0.rssi = adv.rssi;
        entry.1 = time;
        if !has_manufacturer {
            continue;
        }
        let Some(values) = decode(&entry.0).filter(Values::valid) else {
            continue;
        };
        if discovering {
            let kind = if values.co2.is_some() { "co2" } else { "meter" };
            let mut row = serde_json::to_value(values).unwrap();
            row.as_object_mut().unwrap().extend(json!({"address":address,"kind":kind,"name":if kind=="co2"{"CO₂センサー"}else{"温湿度計"},"observed_at":time}).as_object().unwrap().clone());
            s.scanner.candidates.insert(address, row);
        }
        if let Some(id) = id {
            s.store.observe(&id, values, time);
            s.scanner.last_event = Some(time);
        }
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use anyhow::{Result, ensure};
    use std::{
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        time::Duration,
    };
    use tokio::io::unix::AsyncFd;
    struct Hci(AsyncFd<OwnedFd>);
    impl Hci {
        fn open(adapter: u16) -> Result<Self> {
            // Linux sockaddr_hci and hci_filter ABIs, independent of BlueZ libraries.
            #[repr(C)]
            struct Address {
                family: u16,
                device: u16,
                channel: u16,
            }
            #[repr(C)]
            struct Filter {
                kind: u32,
                events: [u32; 2],
                opcode: u16,
            }
            let fd = unsafe {
                libc::socket(
                    31,
                    libc::SOCK_RAW | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
                    1,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error().into());
            }
            let fd = unsafe { OwnedFd::from_raw_fd(fd) };
            let address = Address {
                family: 31,
                device: adapter,
                channel: 0,
            };
            let filter = Filter {
                kind: 1 << 4,
                events: [(1 << 14) | (1 << 15), 1 << 30],
                opcode: 0,
            };
            for result in [
                unsafe {
                    libc::bind(
                        fd.as_raw_fd(),
                        &address as *const _ as *const libc::sockaddr,
                        6,
                    )
                },
                unsafe {
                    libc::setsockopt(
                        fd.as_raw_fd(),
                        0,
                        2,
                        &filter as *const _ as *const libc::c_void,
                        std::mem::size_of::<Filter>() as _,
                    )
                },
            ] {
                if result < 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
            const HCIDEVUP: libc::c_int = 0x400448c9;
            if unsafe { libc::ioctl(fd.as_raw_fd(), HCIDEVUP, adapter as libc::c_int) } < 0 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() != Some(libc::EALREADY) {
                    return Err(error.into());
                }
            }
            Ok(Self(AsyncFd::new(fd)?))
        }
        async fn recv(&self) -> Result<Vec<u8>> {
            loop {
                let mut ready = self.0.readable().await?;
                let mut buf = vec![0; 4096];
                match ready.try_io(|fd| {
                    let n =
                        unsafe { libc::recv(fd.as_raw_fd(), buf.as_mut_ptr() as _, buf.len(), 0) };
                    if n < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(n as usize)
                    }
                }) {
                    Ok(result) => {
                        let n = result?;
                        ensure!(n > 0, "HCI socket closed");
                        buf.truncate(n);
                        return Ok(buf);
                    }
                    Err(_) => continue,
                }
            }
        }
        async fn command(&self, shared: &Shared, opcode: u16, params: &[u8]) -> Result<()> {
            let mut cmd = vec![1, opcode as u8, (opcode >> 8) as u8, params.len() as u8];
            cmd.extend(params);
            loop {
                let mut ready = self.0.writable().await?;
                match ready.try_io(|fd| {
                    let n = unsafe { libc::send(fd.as_raw_fd(), cmd.as_ptr() as _, cmd.len(), 0) };
                    if n < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(n as usize)
                    }
                }) {
                    Ok(n) => {
                        ensure!(n? == cmd.len(), "short HCI write");
                        break;
                    }
                    Err(_) => continue,
                }
            }
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let p = self.recv().await?;
                    if p.len() >= 7
                        && p[..2] == [4, 14]
                        && u16::from_le_bytes([p[4], p[5]]) == opcode
                    {
                        ensure!(
                            p[6] == 0 || (opcode == 0x200c && params == [0, 0] && p[6] == 12),
                            "HCI {opcode:04x} status {:02x}",
                            p[6]
                        );
                        return Ok(());
                    }
                    consume(shared, &p).await;
                }
            })
            .await?
        }
    }
    pub async fn run(shared: Shared, adapter: u16) {
        loop {
            {
                let mut s = shared.lock().await;
                s.scanner.state = "connecting".into();
                s.scanner.cache.clear();
            }
            let result: Result<()> = async {
                let hci = Hci::open(adapter)?;
                hci.command(&shared, 0x200c, &[0, 0]).await?;
                hci.command(&shared, 0x200b, &[1, 0x20, 0, 0x20, 0, 0, 0])
                    .await?;
                hci.command(&shared, 0x200c, &[1, 0]).await?;
                {
                    let mut s = shared.lock().await;
                    s.scanner.state = "scanning".into();
                    s.scanner.error = None;
                }
                loop {
                    let packet =
                        tokio::time::timeout(Duration::from_secs(120), hci.recv()).await??;
                    consume(&shared, &packet).await;
                }
            }
            .await;
            if let Err(e) = result {
                let mut s = shared.lock().await;
                s.scanner.state = "error".into();
                s.scanner.error = Some(e.to_string());
                crate::log_error(&format!("HCI: {e}"));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }
}
#[cfg(target_os = "linux")]
pub use linux::run;
#[cfg(not(target_os = "linux"))]
pub async fn run(shared: Shared, _adapter: u16) {
    let mut s = shared.lock().await;
    s.scanner.state = "error".into();
    s.scanner.error = Some("HCI requires Linux; use --no-ble locally".into());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn co2_fixture_and_truncation() {
        let mut a = Advertisement::default();
        a.service.insert(0xfd3d, vec![0x35, 0, 100]);
        a.manufacturer.insert(
            2409,
            vec![
                0x02, 0x11, 0x22, 0x33, 0x44, 0x55, 0x2f, 0xe4, 7, 0x9a, 45, 0, 5, 4, 0x59, 0x20,
            ],
        );
        let v = decode(&a).unwrap();
        assert_eq!(v.co2, Some(1113.));
        assert_eq!(v.temperature, Some(26.7));
        assert_eq!(v.humidity, Some(45.));
        a.manufacturer.get_mut(&2409).unwrap()[13] = 255;
        assert_eq!(decode(&a).unwrap().co2, None);
        for n in 0..20 {
            assert!(reports(&vec![4; n]).is_empty());
        }
    }
}
