-- Adds treatment costs and monthly payroll runs to an existing SAFM database.
ALTER TABLE health_records
  ADD COLUMN treatment_cost_kes DECIMAL(12,2) NULL;

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
