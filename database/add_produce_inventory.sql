-- Apply once to track available produce stock and sale payment methods.
CREATE TABLE produce_inventory (
  stock_id          INT AUTO_INCREMENT PRIMARY KEY,
  stock_key         VARCHAR(150) NOT NULL UNIQUE,
  produce_type      ENUM('milk','crop') NOT NULL,
  crop_id           INT NULL,
  unit              VARCHAR(20) NOT NULL,
  quantity          DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX idx_stock_type (produce_type, crop_id),
  CONSTRAINT chk_stock_quantity CHECK (quantity >= 0),
  CONSTRAINT fk_stock_crop FOREIGN KEY (crop_id) REFERENCES cultivated_crops(crop_id)
) ENGINE=InnoDB;

ALTER TABLE produce_sales
  ADD COLUMN stock_id INT NULL AFTER crop_id,
  ADD COLUMN payment_method ENUM('mpesa','cash') NOT NULL DEFAULT 'cash' AFTER unit_price_kes,
  ADD CONSTRAINT fk_sale_stock FOREIGN KEY (stock_id) REFERENCES produce_inventory(stock_id);

INSERT INTO produce_inventory (stock_key, produce_type, crop_id, unit, quantity)
SELECT 'milk:litres', 'milk', NULL, 'litres',
       GREATEST(0,
         COALESCE((SELECT SUM(litres) FROM milk_production), 0) -
         COALESCE((SELECT SUM(quantity) FROM produce_sales
                    WHERE produce_type = 'milk' AND LOWER(TRIM(unit)) IN ('litre','litres','l')), 0))
ON DUPLICATE KEY UPDATE quantity = VALUES(quantity);

INSERT INTO produce_inventory (stock_key, produce_type, crop_id, unit, quantity)
SELECT CONCAT('crop:', stock_units.crop_id, ':', stock_units.unit), 'crop', stock_units.crop_id, stock_units.unit,
       GREATEST(0,
         COALESCE((SELECT SUM(h.quantity) FROM crop_harvests h
                    WHERE h.crop_id = stock_units.crop_id AND LOWER(TRIM(h.unit)) = stock_units.unit), 0) -
         COALESCE((SELECT SUM(s.quantity) FROM produce_sales s
                    WHERE s.produce_type = 'crop' AND s.crop_id = stock_units.crop_id
                      AND LOWER(TRIM(s.unit)) = stock_units.unit), 0))
  FROM (
    SELECT crop_id, LOWER(TRIM(unit)) AS unit FROM crop_harvests
    UNION
    SELECT crop_id, LOWER(TRIM(unit)) AS unit FROM produce_sales WHERE produce_type = 'crop' AND crop_id IS NOT NULL
  ) stock_units
ON DUPLICATE KEY UPDATE quantity = VALUES(quantity);

UPDATE produce_sales s
JOIN produce_inventory i
  ON i.stock_key = CASE
    WHEN s.produce_type = 'milk' AND LOWER(TRIM(s.unit)) IN ('litre','litres','l') THEN 'milk:litres'
    WHEN s.produce_type = 'crop' THEN CONCAT('crop:', s.crop_id, ':', LOWER(TRIM(s.unit)))
  END
SET s.stock_id = i.stock_id;
