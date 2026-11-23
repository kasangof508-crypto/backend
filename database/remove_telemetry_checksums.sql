-- Run once against a database created with the older schema.
ALTER TABLE livestock_telemetry DROP COLUMN checksum;
ALTER TABLE machinery_telemetry DROP COLUMN checksum;
ALTER TABLE climate_readings DROP COLUMN checksum;