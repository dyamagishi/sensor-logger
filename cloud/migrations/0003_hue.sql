CREATE TABLE hue_lights (
  light_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  output_name TEXT NOT NULL,
  registered_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE hue_samples (
  light_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  available INTEGER NOT NULL,
  connectivity TEXT NOT NULL,
  "on" INTEGER,
  brightness REAL,
  mirek INTEGER,
  x REAL, y REAL,
  color_mode TEXT,
  PRIMARY KEY (light_id, minute)
) WITHOUT ROWID;
CREATE INDEX hue_samples_time ON hue_samples(minute);
CREATE TABLE hue_hourly (
  light_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  on_fraction REAL,
  brightness REAL, brightness_min REAL, brightness_max REAL,
  mirek INTEGER, x REAL, y REAL,
  available_count INTEGER NOT NULL,
  unavailable_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (light_id, hour)
) WITHOUT ROWID;
CREATE INDEX hue_hourly_time ON hue_hourly(hour);
