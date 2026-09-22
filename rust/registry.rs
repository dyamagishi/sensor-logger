use crate::store::Sensor;
use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::Path};

pub fn sensor_id(address: &str) -> String {
    format!("sb-{:x}", Sha256::digest(address.to_uppercase().as_bytes()))[..19].into()
}
pub fn validate(row: &Sensor) -> Result<()> {
    let parts: Vec<_> = row.address.split(':').collect();
    ensure!(
        parts.len() == 6
            && parts.iter().all(|s| s.len() == 2
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))),
        "invalid address"
    );
    ensure!(
        row.id == sensor_id(&row.address) && matches!(row.kind.as_str(), "meter" | "co2"),
        "invalid sensor"
    );
    ensure!(
        (1..=40).contains(&row.name.trim().chars().count())
            && !row.name.chars().any(|c| (c as u32) < 32),
        "invalid name"
    );
    Ok(())
}
pub fn load(path: Option<&Path>) -> Result<Vec<Sensor>> {
    let Some(path) = path.filter(|p| p.exists()) else {
        return Ok(vec![]);
    };
    let mut rows: Vec<Sensor> = serde_json::from_slice(&fs::read(path)?)?;
    ensure!(rows.len() <= 32, "invalid registry");
    let mut ids = HashSet::new();
    for row in &mut rows {
        validate(row)?;
        ensure!(ids.insert(row.id.clone()), "duplicate registry");
        row.cloud_synced = Some(row.cloud_synced == Some(true));
    }
    Ok(rows)
}
pub fn save(path: Option<&Path>, rows: &[Sensor]) -> Result<()> {
    let path = path.ok_or_else(|| anyhow::anyhow!("registration storage is not configured"))?;
    for row in rows {
        validate(row)?;
    }
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(&serde_json::to_vec(rows)?)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)?;
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}
