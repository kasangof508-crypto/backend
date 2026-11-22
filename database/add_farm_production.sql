-- Apply once to an existing SAFM-SYS database to add crop, milk, harvest and sales records.
CREATE TABLE IF NOT EXISTS cultivated_crops (
  crop_id       INT AUTO_INCREMENT PRIMARY KEY,
  crop_name     VARCHAR(80) NOT NULL,
  variety       VARCHAR(80) NULL,
  zone_id       INT NULL,
  planted_on    DATE NOT NULL,
  area_ha       DECIMAL(8,2) NULL,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by    CHAR(36) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_crop_status (status, crop_name),
  CONSTRAINT fk_crop_zone FOREIGN KEY (zone_id) REFERENCES zones(zone_id),
  CONSTRAINT fk_crop_user FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS milk_production (
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

CREATE TABLE IF NOT EXISTS crop_harvests (
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

CREATE TABLE IF NOT EXISTS produce_sales (
  sale_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  produce_type     ENUM('milk','crop') NOT NULL,
  crop_id          INT NULL,
  sold_by          CHAR(36) NOT NULL,
  sold_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  quantity         DECIMAL(10,2) NOT NULL,
  unit             VARCHAR(20) NOT NULL,
  unit_price_kes   DECIMAL(10,2) NOT NULL,
  buyer_name       VARCHAR(120) NOT NULL,
  buyer_phone      VARCHAR(30) NULL,
  buyer_address    VARCHAR(200) NULL,
  notes            VARCHAR(500) NULL,
  INDEX idx_sale_date (sold_at),
  CONSTRAINT chk_sale_quantity CHECK (quantity > 0),
  CONSTRAINT chk_sale_price CHECK (unit_price_kes >= 0),
  CONSTRAINT chk_sale_crop CHECK ((produce_type = 'crop' AND crop_id IS NOT NULL) OR (produce_type = 'milk' AND crop_id IS NULL)),
  CONSTRAINT fk_sale_crop FOREIGN KEY (crop_id) REFERENCES cultivated_crops(crop_id),
  CONSTRAINT fk_sale_user FOREIGN KEY (sold_by) REFERENCES users(user_id)
) ENGINE=InnoDB;

ALTER TABLE reports MODIFY report_type
  ENUM('livestock','weekly_performance','environment','fuel_efficiency','milk_produce','crop_produce','produce_sale','system_overview') NOT NULL;
