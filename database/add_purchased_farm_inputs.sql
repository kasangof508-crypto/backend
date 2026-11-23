-- Apply once to an existing SAFM-SYS database to record crop and machinery purchases.
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

ALTER TABLE cultivated_crops
  ADD COLUMN purchase_id INT NULL,
  ADD INDEX idx_cultivated_purchase (purchase_id),
  ADD CONSTRAINT fk_cultivated_purchase FOREIGN KEY (purchase_id) REFERENCES crop_purchases(purchase_id);

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

ALTER TABLE machinery
  ADD COLUMN purchase_id INT NULL UNIQUE,
  ADD CONSTRAINT fk_m_purchase FOREIGN KEY (purchase_id) REFERENCES machine_purchases(purchase_id);
