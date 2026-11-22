-- SAFM-SYS database schema (MySQL 8.0+)
-- Derived from the System Design Specification, Section 5 (data dictionary), adapted from PostgreSQL to MySQL.
-- Run against the database configured as DB_NAME in backend/.env.
-- Timestamps are stored in UTC (DATETIME(3)); the UI displays them in East Africa Time.

-- ---------- Access ----------
CREATE TABLE roles (
  role_id      TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role_name    VARCHAR(30) NOT NULL UNIQUE,
  description  TEXT
) ENGINE=InnoDB;

INSERT INTO roles (role_name, description) VALUES
 ('Farm Administrator',   'Oversees all farm operations, reports, tasks and alerts'),
 ('Field Worker',         'Receives tasks, signs in/out and updates progress'),
 ('Veterinarian',         'Monitors livestock health and records examinations'),
 ('Machinery Operator',   'Operates machinery, logs fuel and receives maintenance alerts'),
 ('System Administrator', 'Manages users, devices, security and configuration');

CREATE TABLE users (
  user_id             CHAR(36) PRIMARY KEY,
  full_name           VARCHAR(100) NOT NULL,
  email               VARCHAR(120) NOT NULL UNIQUE,
  phone               VARCHAR(20)  NOT NULL,
  password_hash       VARCHAR(100) NOT NULL,
  role_id             TINYINT UNSIGNED NOT NULL,
  preferred_language  CHAR(2) NOT NULL DEFAULT 'en',
  status              ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  mfa_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts     SMALLINT NOT NULL DEFAULT 0,
  locked_until        DATETIME(3) NULL,
  consent_at          DATETIME(3) NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at       DATETIME(3) NULL,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(role_id)
) ENGINE=InnoDB;

CREATE TABLE user_devices (
  device_id      CHAR(36) PRIMARY KEY,
  user_id        CHAR(36) NOT NULL,
  device_name    VARCHAR(80),
  public_key     TEXT NOT NULL,          -- device-bound public key (PEM); biometric template never leaves the phone
  fcm_token      TEXT,
  registered_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_ud_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE refresh_tokens (
  token_id    CHAR(36) PRIMARY KEY,
  user_id     CHAR(36) NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  issued_at   DATETIME(3) NOT NULL,
  expires_at  DATETIME(3) NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX idx_rt_hash (token_hash),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- ---------- Workforce ----------
CREATE TABLE zones (
  zone_id     INT AUTO_INCREMENT PRIMARY KEY,
  zone_name   VARCHAR(60) NOT NULL UNIQUE,
  zone_type   ENUM('field','greenhouse','pen','yard','storage') NOT NULL,
  boundary    JSON NOT NULL,             -- polygon as [[lat,lng],...]
  created_by  CHAR(36) NULL,
  CONSTRAINT fk_zones_user FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE iot_devices (
  device_id         CHAR(36) PRIMARY KEY,
  device_type       ENUM('rfid_collar','gps_tracker','canbus','climate_kit','gateway') NOT NULL,
  serial_no         VARCHAR(40) NOT NULL UNIQUE,   -- hardware serial number
  firmware_version  VARCHAR(20),
  battery_level     TINYINT UNSIGNED,
  last_seen_at      DATETIME(3) NULL,
  status            ENUM('active','offline','retired') NOT NULL DEFAULT 'active',
  CONSTRAINT chk_battery CHECK (battery_level IS NULL OR battery_level BETWEEN 0 AND 100)
) ENGINE=InnoDB;

CREATE TABLE tasks (
  task_id       CHAR(36) PRIMARY KEY,
  title         VARCHAR(120) NOT NULL,
  description   TEXT,
  zone_id       INT NULL,
  assigned_to   CHAR(36) NULL,
  assigned_by   CHAR(36) NULL,
  priority      ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  status        ENUM('assigned','in_progress','completed','cancelled') NOT NULL DEFAULT 'assigned',
  due_at        DATETIME(3) NULL,
  started_at    DATETIME(3) NULL,
  completed_at  DATETIME(3) NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_tasks_worker (assigned_to, status, due_at),
  CONSTRAINT fk_tasks_zone FOREIGN KEY (zone_id) REFERENCES zones(zone_id),
  CONSTRAINT fk_tasks_to   FOREIGN KEY (assigned_to) REFERENCES users(user_id),
  CONSTRAINT fk_tasks_by   FOREIGN KEY (assigned_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE attendance (
  attendance_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id        CHAR(36) NOT NULL,
  sign_in_at     DATETIME(3) NOT NULL,
  sign_out_at    DATETIME(3) NULL,
  sign_in_lat    DECIMAL(9,6) NULL,
  sign_in_lng    DECIMAL(9,6) NULL,
  auth_method    ENUM('fingerprint','face','password') NOT NULL DEFAULT 'password',
  INDEX idx_att_user (user_id, sign_in_at),
  CONSTRAINT fk_att_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE worker_locations (
  user_id      CHAR(36) NOT NULL,
  recorded_at  DATETIME(3) NOT NULL,
  latitude     DECIMAL(9,6) NOT NULL,
  longitude    DECIMAL(9,6) NOT NULL,
  accuracy_m   FLOAT NULL,
  PRIMARY KEY (user_id, recorded_at),
  CONSTRAINT fk_wl_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- ---------- Livestock ----------
CREATE TABLE livestock (
  animal_id         CHAR(36) PRIMARY KEY,
  tag_id            VARCHAR(24) NOT NULL UNIQUE,   -- RFID tag number
  species           VARCHAR(20) NOT NULL DEFAULT 'cattle',
  breed             VARCHAR(40),
  sex               ENUM('M','F') NOT NULL,
  date_of_birth     DATE NULL,
  collar_device_id  CHAR(36) NULL,
  zone_id           INT NULL,
  status            ENUM('active','sold','deceased','deleted') NOT NULL DEFAULT 'active',
  CONSTRAINT fk_live_collar FOREIGN KEY (collar_device_id) REFERENCES iot_devices(device_id),
  CONSTRAINT fk_live_zone   FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
) ENGINE=InnoDB;

CREATE TABLE livestock_tag_sequence (
  sequence_id   TINYINT UNSIGNED PRIMARY KEY,
  prefix        VARCHAR(23) NOT NULL,
  next_number   VARCHAR(24) NOT NULL,
  padding       TINYINT UNSIGNED NOT NULL,
  initialized   BOOLEAN NOT NULL DEFAULT FALSE
) ENGINE=InnoDB;

INSERT INTO livestock_tag_sequence (sequence_id, prefix, next_number, padding, initialized)
VALUES (1, 'COW-', '1', 4, FALSE);

CREATE TABLE livestock_telemetry (
  animal_id       CHAR(36) NOT NULL,
  recorded_at     DATETIME(3) NOT NULL,
  temperature_c   DECIMAL(4,1) NOT NULL,
  activity_index  DECIMAL(6,2) NOT NULL,
  battery_level   TINYINT UNSIGNED NULL,
  PRIMARY KEY (animal_id, recorded_at),
  INDEX idx_lt_time (recorded_at),
  CONSTRAINT chk_lt_temp CHECK (temperature_c BETWEEN 30 AND 45),
  CONSTRAINT fk_lt_animal FOREIGN KEY (animal_id) REFERENCES livestock(animal_id)
) ENGINE=InnoDB;

-- ---------- Alerts ----------
CREATE TABLE thresholds (
  threshold_id      INT AUTO_INCREMENT PRIMARY KEY,
  module            ENUM('livestock','machinery','structure') NOT NULL,
  scope             VARCHAR(40) NOT NULL DEFAULT 'default',   -- breed, machine type or structure type
  metric            VARCHAR(30) NOT NULL,
  min_value         DECIMAL(10,2) NULL,
  max_value         DECIMAL(10,2) NULL,
  duration_minutes  INT NOT NULL DEFAULT 0,
  severity          ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by        CHAR(36) NULL,
  UNIQUE KEY uq_threshold (module, scope, metric),
  CONSTRAINT fk_th_user FOREIGN KEY (updated_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE alert_recipients (
  rule_id        INT AUTO_INCREMENT PRIMARY KEY,
  threshold_id   INT NOT NULL,
  user_id        CHAR(36) NOT NULL,
  level          TINYINT NOT NULL DEFAULT 1,              -- 1 primary, 2 escalation
  channels       VARCHAR(20) NOT NULL DEFAULT 'sms,push', -- sms,push,email
  UNIQUE KEY uq_recipient (threshold_id, user_id, level),
  CONSTRAINT fk_ar_th   FOREIGN KEY (threshold_id) REFERENCES thresholds(threshold_id) ON DELETE CASCADE,
  CONSTRAINT fk_ar_user FOREIGN KEY (user_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE alerts (
  alert_id         CHAR(36) PRIMARY KEY,
  alert_type       VARCHAR(30) NOT NULL,
  severity         ENUM('info','warning','critical') NOT NULL,
  source_module    ENUM('livestock','machinery','structure') NOT NULL,
  entity_type      VARCHAR(20) NOT NULL,
  entity_id        VARCHAR(36) NOT NULL,
  message          TEXT NOT NULL,
  status           ENUM('open','acknowledged','escalated','resolved') NOT NULL DEFAULT 'open',
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  acknowledged_by  CHAR(36) NULL,
  acknowledged_at  DATETIME(3) NULL,
  escalated_at     DATETIME(3) NULL,
  resolved_at      DATETIME(3) NULL,
  INDEX idx_alerts_feed (status, severity, created_at),
  INDEX idx_alerts_entity (entity_id, alert_type, status),
  CONSTRAINT fk_alerts_user FOREIGN KEY (acknowledged_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE notifications (
  notification_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  alert_id         CHAR(36) NOT NULL,
  recipient_id     CHAR(36) NOT NULL,
  channel          ENUM('sms','push','email') NOT NULL,
  status           ENUM('queued','sent','delivered','failed') NOT NULL DEFAULT 'queued',
  attempts         SMALLINT NOT NULL DEFAULT 0,
  sent_at          DATETIME(3) NULL,
  delivered_at     DATETIME(3) NULL,
  INDEX idx_notif_alert (alert_id),
  CONSTRAINT fk_n_alert FOREIGN KEY (alert_id) REFERENCES alerts(alert_id),
  CONSTRAINT fk_n_user  FOREIGN KEY (recipient_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE health_records (
  record_id    CHAR(36) PRIMARY KEY,
  animal_id    CHAR(36) NOT NULL,
  alert_id     CHAR(36) NULL,
  vet_id       CHAR(36) NOT NULL,
  examined_at  DATETIME(3) NOT NULL,
  treatment_cost_kes DECIMAL(12,2) NULL,
  diagnosis    TEXT,
  treatment    TEXT,
  notes        TEXT,
  CONSTRAINT fk_hr_animal FOREIGN KEY (animal_id) REFERENCES livestock(animal_id),
  CONSTRAINT fk_hr_alert  FOREIGN KEY (alert_id) REFERENCES alerts(alert_id),
  CONSTRAINT fk_hr_vet    FOREIGN KEY (vet_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE payroll_runs (
  run_id         CHAR(36) PRIMARY KEY,
  payroll_month  DATE NOT NULL UNIQUE,
  period_start   DATE NOT NULL,
  period_end     DATE NOT NULL,
  created_by     CHAR(36) NOT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT chk_payroll_period CHECK (period_end >= period_start),
  CONSTRAINT fk_payroll_run_user FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE payroll_entries (
  entry_id           CHAR(36) PRIMARY KEY,
  run_id             CHAR(36) NOT NULL,
  user_id            CHAR(36) NOT NULL,
  role_name          VARCHAR(30) NOT NULL,
  hours_worked       DECIMAL(10,2) NOT NULL DEFAULT 0,
  hourly_rate_kes    DECIMAL(10,2) NOT NULL DEFAULT 0,
  base_amount_kes    DECIMAL(12,2) NOT NULL DEFAULT 0,
  treatment_cost_kes DECIMAL(12,2) NOT NULL DEFAULT 0,
  adjustment_kes     DECIMAL(12,2) NOT NULL DEFAULT 0,
  adjustment_note    VARCHAR(500) NULL,
  total_amount_kes   DECIMAL(12,2) NOT NULL DEFAULT 0,
  adjusted_by        CHAR(36) NULL,
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_payroll_employee (run_id, user_id),
  INDEX idx_payroll_user (user_id, run_id),
  CONSTRAINT chk_payroll_amounts CHECK (base_amount_kes >= 0 AND treatment_cost_kes >= 0 AND total_amount_kes >= 0),
  CONSTRAINT fk_payroll_entry_run FOREIGN KEY (run_id) REFERENCES payroll_runs(run_id),
  CONSTRAINT fk_payroll_entry_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_payroll_adjuster FOREIGN KEY (adjusted_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE payroll_treatment_records (
  record_id   CHAR(36) PRIMARY KEY,
  entry_id    CHAR(36) NOT NULL,
  linked_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_payroll_treatment_record FOREIGN KEY (record_id) REFERENCES health_records(record_id),
  CONSTRAINT fk_payroll_treatment_entry FOREIGN KEY (entry_id) REFERENCES payroll_entries(entry_id)
) ENGINE=InnoDB;

CREATE TABLE breeding_events (
  event_id      CHAR(36) PRIMARY KEY,
  animal_id     CHAR(36) NOT NULL,
  event_type    ENUM('estrus','insemination','pregnancy_check','calving') NOT NULL,
  detected_at   DATETIME(3) NOT NULL,
  confirmed_by  CHAR(36) NULL,
  notes         TEXT,
  INDEX idx_be_animal (animal_id, detected_at),
  CONSTRAINT fk_be_animal FOREIGN KEY (animal_id) REFERENCES livestock(animal_id),
  CONSTRAINT fk_be_user   FOREIGN KEY (confirmed_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- ---------- Farm production ----------
CREATE TABLE crop_purchases (
  purchase_id      INT AUTO_INCREMENT PRIMARY KEY,
  crop_name        VARCHAR(80) NOT NULL,
  variety          VARCHAR(80) NULL,
  quantity         DECIMAL(10,2) NOT NULL,
  unit             VARCHAR(20) NOT NULL,
  purchased_on     DATE NOT NULL,
  supplier         VARCHAR(120) NULL,
  total_cost_kes   DECIMAL(12,2) NULL,
  created_by       CHAR(36) NOT NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_crop_purchase_name (crop_name, variety),
  CONSTRAINT chk_crop_purchase_quantity CHECK (quantity > 0),
  CONSTRAINT chk_crop_purchase_cost CHECK (total_cost_kes IS NULL OR total_cost_kes >= 0),
  CONSTRAINT fk_crop_purchase_user FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE cultivated_crops (
  crop_id       INT AUTO_INCREMENT PRIMARY KEY,
  purchase_id   INT NULL,
  crop_name     VARCHAR(80) NOT NULL,
  variety       VARCHAR(80) NULL,
  zone_id       INT NULL,
  planted_on    DATE NOT NULL,
  area_ha       DECIMAL(8,2) NULL,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by    CHAR(36) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_crop_status (status, crop_name),
  INDEX idx_cultivated_purchase (purchase_id),
  CONSTRAINT fk_crop_zone FOREIGN KEY (zone_id) REFERENCES zones(zone_id),
  CONSTRAINT fk_crop_user FOREIGN KEY (created_by) REFERENCES users(user_id),
  CONSTRAINT fk_cultivated_purchase FOREIGN KEY (purchase_id) REFERENCES crop_purchases(purchase_id)
) ENGINE=InnoDB;

CREATE TABLE milk_production (
  milk_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  animal_id     CHAR(36) NOT NULL,
  recorded_by   CHAR(36) NOT NULL,
  recorded_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  litres        DECIMAL(8,2) NOT NULL,
  notes         VARCHAR(500) NULL,
  INDEX idx_milk_recorded (recorded_at),
  INDEX idx_milk_animal (animal_id, recorded_at),
  CONSTRAINT chk_milk_litres CHECK (litres > 0),
  CONSTRAINT fk_milk_animal FOREIGN KEY (animal_id) REFERENCES livestock(animal_id),
  CONSTRAINT fk_milk_user FOREIGN KEY (recorded_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE crop_harvests (
  harvest_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  crop_id       INT NOT NULL,
  recorded_by   CHAR(36) NOT NULL,
  harvested_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  quantity      DECIMAL(10,2) NOT NULL,
  unit          VARCHAR(20) NOT NULL,
  notes         VARCHAR(500) NULL,
  INDEX idx_harvest_date (harvested_at),
  CONSTRAINT chk_harvest_quantity CHECK (quantity > 0),
  CONSTRAINT fk_harvest_crop FOREIGN KEY (crop_id) REFERENCES cultivated_crops(crop_id),
  CONSTRAINT fk_harvest_user FOREIGN KEY (recorded_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE produce_inventory (
  stock_id          INT AUTO_INCREMENT PRIMARY KEY,
  stock_key         VARCHAR(150) NOT NULL UNIQUE,
  produce_type      ENUM('milk','crop') NOT NULL,
  crop_id           INT NULL,
  unit              VARCHAR(20) NOT NULL,
  quantity          DECIMAL(12,2) NOT NULL DEFAULT 0,
  reserved_quantity DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_stock_type (produce_type, crop_id),
  CONSTRAINT chk_stock_quantity CHECK (quantity >= 0),
  CONSTRAINT chk_stock_reserved CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity),
  CONSTRAINT fk_stock_crop FOREIGN KEY (crop_id) REFERENCES cultivated_crops(crop_id)
) ENGINE=InnoDB;

CREATE TABLE customers (
  customer_id  INT AUTO_INCREMENT PRIMARY KEY,
  full_name    VARCHAR(120) NOT NULL,
  phone        VARCHAR(30) NULL,
  address      VARCHAR(200) NULL,
  created_by   CHAR(36) NOT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_customer_name (full_name),
  INDEX idx_customer_phone (phone),
  CONSTRAINT fk_customer_user FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE produce_sales (
  sale_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  produce_type     ENUM('milk','crop') NOT NULL,
  crop_id          INT NULL,
  stock_id         INT NULL,
  customer_id      INT NULL,
  sold_by          CHAR(36) NOT NULL,
  sold_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  quantity         DECIMAL(10,2) NOT NULL,
  unit             VARCHAR(20) NOT NULL,
  unit_price_kes   DECIMAL(10,2) NOT NULL,
  payment_method   ENUM('mpesa','cash') NOT NULL DEFAULT 'cash',
  payment_status   ENUM('pending','paid','failed','review') NOT NULL DEFAULT 'paid',
  mpesa_prompt_status ENUM('not_sent','sending','sent','uncertain') NULL,
  mpesa_prompt_started_at DATETIME(3) NULL,
  payment_amount_kes INT NULL,
  mpesa_checkout_request_id VARCHAR(100) NULL UNIQUE,
  mpesa_merchant_request_id VARCHAR(100) NULL,
  mpesa_receipt_number VARCHAR(50) NULL,
  mpesa_result_code INT NULL,
  mpesa_result_desc VARCHAR(200) NULL,
  buyer_name       VARCHAR(120) NOT NULL,
  buyer_phone      VARCHAR(30) NULL,
  buyer_address    VARCHAR(200) NULL,
  notes            VARCHAR(500) NULL,
  INDEX idx_sale_date (sold_at),
  CONSTRAINT chk_sale_quantity CHECK (quantity > 0),
  CONSTRAINT chk_sale_price CHECK (unit_price_kes >= 0),
  CONSTRAINT chk_sale_crop CHECK ((produce_type = 'crop' AND crop_id IS NOT NULL) OR (produce_type = 'milk' AND crop_id IS NULL)),
  CONSTRAINT fk_sale_crop FOREIGN KEY (crop_id) REFERENCES cultivated_crops(crop_id),
  CONSTRAINT fk_sale_stock FOREIGN KEY (stock_id) REFERENCES produce_inventory(stock_id),
  CONSTRAINT fk_sale_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
  CONSTRAINT fk_sale_user FOREIGN KEY (sold_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE mpesa_payment_intents (
  intent_id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  produce_type    ENUM('milk','crop') NOT NULL,
  crop_id         INT NULL,
  stock_id        INT NOT NULL,
  customer_id     INT NOT NULL,
  sold_by         CHAR(36) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  quantity        DECIMAL(10,2) NOT NULL,
  unit            VARCHAR(20) NOT NULL,
  unit_price_kes  DECIMAL(10,2) NOT NULL,
  payment_amount_kes INT NOT NULL,
  payment_status  ENUM('pending','paid','failed','review') NOT NULL DEFAULT 'pending',
  prompt_status   ENUM('not_sent','sending','sent','uncertain') NOT NULL DEFAULT 'not_sent',
  prompt_started_at DATETIME(3) NULL,
  checkout_request_id VARCHAR(100) NULL UNIQUE,
  merchant_request_id VARCHAR(100) NULL,
  receipt_number  VARCHAR(50) NULL,
  result_code     INT NULL,
  result_desc     VARCHAR(200) NULL,
  buyer_name      VARCHAR(120) NOT NULL,
  buyer_phone     VARCHAR(30) NOT NULL,
  buyer_address   VARCHAR(200) NULL,
  sale_id         BIGINT NULL UNIQUE,
  INDEX idx_mpesa_intent_status (payment_status, created_at),
  CONSTRAINT chk_mpesa_intent_quantity CHECK (quantity > 0),
  CONSTRAINT chk_mpesa_intent_amount CHECK (payment_amount_kes > 0),
  CONSTRAINT chk_mpesa_intent_crop CHECK ((produce_type = 'crop' AND crop_id IS NOT NULL) OR (produce_type = 'milk' AND crop_id IS NULL)),
  CONSTRAINT fk_mpesa_intent_crop FOREIGN KEY (crop_id) REFERENCES cultivated_crops(crop_id),
  CONSTRAINT fk_mpesa_intent_stock FOREIGN KEY (stock_id) REFERENCES produce_inventory(stock_id),
  CONSTRAINT fk_mpesa_intent_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
  CONSTRAINT fk_mpesa_intent_user FOREIGN KEY (sold_by) REFERENCES users(user_id),
  CONSTRAINT fk_mpesa_intent_sale FOREIGN KEY (sale_id) REFERENCES produce_sales(sale_id)
) ENGINE=InnoDB;

-- ---------- Machinery ----------
CREATE TABLE machine_purchases (
  purchase_id       INT AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(60) NOT NULL,
  machine_type      VARCHAR(30) NOT NULL DEFAULT 'tractor',
  registration_no   VARCHAR(20) NULL UNIQUE,
  make_model        VARCHAR(60) NULL,
  purchased_on      DATE NOT NULL,
  supplier          VARCHAR(120) NULL,
  purchase_cost_kes DECIMAL(12,2) NULL,
  created_by        CHAR(36) NOT NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_machine_purchase_name (name),
  CONSTRAINT chk_machine_purchase_cost CHECK (purchase_cost_kes IS NULL OR purchase_cost_kes >= 0),
  CONSTRAINT fk_machine_purchase_user FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE machinery (
  machine_id            CHAR(36) PRIMARY KEY,
  purchase_id           INT NULL UNIQUE,
  name                  VARCHAR(60) NOT NULL,
  machine_type          VARCHAR(30) NOT NULL DEFAULT 'tractor',
  registration_no       VARCHAR(20) UNIQUE,
  make_model            VARCHAR(60),
  tracker_device_id     CHAR(36) NULL,
  service_interval_hrs  INT NOT NULL DEFAULT 250,
  total_engine_hrs      DECIMAL(8,1) NOT NULL DEFAULT 0,
  hrs_at_last_service   DECIMAL(8,1) NOT NULL DEFAULT 0,
  status                ENUM('active','in_service','retired','deleted') NOT NULL DEFAULT 'active',
  CONSTRAINT fk_m_dev FOREIGN KEY (tracker_device_id) REFERENCES iot_devices(device_id),
  CONSTRAINT fk_m_purchase FOREIGN KEY (purchase_id) REFERENCES machine_purchases(purchase_id)
) ENGINE=InnoDB;

CREATE TABLE machinery_telemetry (
  machine_id      CHAR(36) NOT NULL,
  recorded_at     DATETIME(3) NOT NULL,
  latitude        DECIMAL(9,6) NULL,
  longitude       DECIMAL(9,6) NULL,
  speed_kmh       FLOAT NULL,
  ignition_on     BOOLEAN NULL,
  engine_hours    DECIMAL(8,1) NULL,
  fuel_level_pct  FLOAT NULL,
  fault_codes     TEXT NULL,
  PRIMARY KEY (machine_id, recorded_at),
  INDEX idx_mt_time (recorded_at),
  CONSTRAINT chk_mt_fuel CHECK (fuel_level_pct IS NULL OR fuel_level_pct BETWEEN 0 AND 100),
  CONSTRAINT fk_mt_machine FOREIGN KEY (machine_id) REFERENCES machinery(machine_id)
) ENGINE=InnoDB;

CREATE TABLE maintenance_records (
  maintenance_id         CHAR(36) PRIMARY KEY,
  machine_id             CHAR(36) NOT NULL,
  alert_id               CHAR(36) NULL,
  scheduled_for          DATE NULL,
  mechanic_id            CHAR(36) NULL,
  completed_at           DATETIME(3) NULL,
  engine_hrs_at_service  DECIMAL(8,1) NULL,
  service_type           VARCHAR(30),
  cost_kes               DECIMAL(10,2) NULL,
  notes                  TEXT,
  CONSTRAINT fk_mr_machine  FOREIGN KEY (machine_id) REFERENCES machinery(machine_id),
  CONSTRAINT fk_mr_alert    FOREIGN KEY (alert_id) REFERENCES alerts(alert_id),
  CONSTRAINT fk_mr_mechanic FOREIGN KEY (mechanic_id) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE fuel_logs (               -- manual fuel entries by operators (RBAC: operator may create)
  fuel_log_id  BIGINT AUTO_INCREMENT PRIMARY KEY,
  machine_id   CHAR(36) NOT NULL,
  logged_by    CHAR(36) NOT NULL,
  logged_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  litres       DECIMAL(7,2) NOT NULL,
  engine_hours DECIMAL(8,1) NULL,
  notes        VARCHAR(200),
  INDEX idx_fl_machine (machine_id, logged_at),
  CONSTRAINT fk_fl_machine FOREIGN KEY (machine_id) REFERENCES machinery(machine_id),
  CONSTRAINT fk_fl_user    FOREIGN KEY (logged_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- ---------- Environment ----------
CREATE TABLE structures (
  structure_id       INT AUTO_INCREMENT PRIMARY KEY,
  structure_name     VARCHAR(60) NOT NULL,
  structure_type     ENUM('greenhouse','grain_silo','silage_pit') NOT NULL,
  zone_id            INT NULL,
  sensor_device_id   CHAR(36) NULL,
  manual_override    BOOLEAN NOT NULL DEFAULT FALSE,
  emergency_stop     BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT fk_s_zone FOREIGN KEY (zone_id) REFERENCES zones(zone_id),
  CONSTRAINT fk_s_dev  FOREIGN KEY (sensor_device_id) REFERENCES iot_devices(device_id)
) ENGINE=InnoDB;

CREATE TABLE climate_readings (
  structure_id  INT NOT NULL,
  recorded_at   DATETIME(3) NOT NULL,
  temperature_c DECIMAL(4,1) NOT NULL,
  humidity_pct  DECIMAL(4,1) NOT NULL,
  gas_type      VARCHAR(10) NULL,
  gas_ppm       DECIMAL(8,1) NULL,
  PRIMARY KEY (structure_id, recorded_at),
  INDEX idx_cr_time (recorded_at),
  CONSTRAINT chk_cr_hum CHECK (humidity_pct BETWEEN 0 AND 100),
  CONSTRAINT fk_cr_struct FOREIGN KEY (structure_id) REFERENCES structures(structure_id)
) ENGINE=InnoDB;

CREATE TABLE actuators (
  actuator_id      INT AUTO_INCREMENT PRIMARY KEY,
  structure_id     INT NOT NULL,
  actuator_type    ENUM('fan','cooler','vent','alarm') NOT NULL,
  state            ENUM('on','off','open','closed') NOT NULL DEFAULT 'off',
  mode             ENUM('auto','manual') NOT NULL DEFAULT 'auto',
  last_changed_at  DATETIME(3) NULL,
  last_changed_by  CHAR(36) NULL,          -- NULL = automatic
  UNIQUE KEY uq_actuator (structure_id, actuator_type),
  CONSTRAINT fk_act_struct FOREIGN KEY (structure_id) REFERENCES structures(structure_id),
  CONSTRAINT fk_act_user   FOREIGN KEY (last_changed_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

-- ---------- Reporting & audit ----------
CREATE TABLE reports (
  report_id     CHAR(36) PRIMARY KEY,
  report_type   ENUM('livestock','weekly_performance','environment','fuel_efficiency','milk_produce','crop_produce','produce_sale','system_overview') NOT NULL,
  parameters    JSON,
  format        ENUM('pdf','xlsx') NOT NULL,
  file_path     VARCHAR(200),
  generated_by  CHAR(36) NOT NULL,
  generated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_rep_user FOREIGN KEY (generated_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  audit_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     CHAR(36) NULL,
  ip_address  VARCHAR(45) NULL,
  action      VARCHAR(40) NOT NULL,
  entity      VARCHAR(40) NULL,
  details     JSON NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_audit_time (created_at),
  INDEX idx_audit_user (user_id)
) ENGINE=InnoDB;

-- Audit immutability: updates and deletes are blocked at database level
DELIMITER $$
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is immutable'; END$$
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is immutable'; END$$
DELIMITER ;

-- Optional least-privilege application account (change the password!)
-- CREATE USER 'safm'@'%' IDENTIFIED BY 'change-me';
-- GRANT SELECT, INSERT, UPDATE, DELETE ON safm_sys.* TO 'safm'@'%';
-- REVOKE UPDATE, DELETE ON safm_sys.audit_log FROM 'safm'@'%';
