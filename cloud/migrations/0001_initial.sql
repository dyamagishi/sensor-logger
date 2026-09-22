CREATE TABLE samples (
  sensor_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  temperature REAL,
  humidity REAL,
  co2 INTEGER,
  battery INTEGER,
  rssi INTEGER,
  PRIMARY KEY (sensor_id, minute)
) WITHOUT ROWID;
CREATE INDEX samples_time ON samples(minute);
CREATE TABLE hourly (
  sensor_id TEXT NOT NULL,
  hour INTEGER NOT NULL,
  temperature_avg REAL, temperature_min REAL, temperature_max REAL, temperature_count INTEGER NOT NULL,
  humidity_avg REAL, humidity_min REAL, humidity_max REAL, humidity_count INTEGER NOT NULL,
  co2_avg REAL, co2_min REAL, co2_max REAL, co2_count INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (sensor_id, hour)
) WITHOUT ROWID;
CREATE INDEX hourly_time ON hourly(hour);
