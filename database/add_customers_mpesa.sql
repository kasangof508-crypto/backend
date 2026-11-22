-- Apply once to track saved customers and asynchronous M-Pesa payments.
ALTER TABLE produce_inventory
  ADD COLUMN reserved_quantity DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER quantity,
  ADD CONSTRAINT chk_stock_reserved CHECK (reserved_quantity >= 0 AND reserved_quantity <= quantity);

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

ALTER TABLE produce_sales
  ADD COLUMN customer_id INT NULL AFTER stock_id,
  ADD COLUMN payment_status ENUM('pending','paid','failed','review') NOT NULL DEFAULT 'paid' AFTER payment_method,
  ADD COLUMN payment_amount_kes INT NULL AFTER payment_status,
  ADD COLUMN mpesa_checkout_request_id VARCHAR(100) NULL UNIQUE AFTER payment_amount_kes,
  ADD COLUMN mpesa_merchant_request_id VARCHAR(100) NULL AFTER mpesa_checkout_request_id,
  ADD COLUMN mpesa_receipt_number VARCHAR(50) NULL AFTER mpesa_merchant_request_id,
  ADD COLUMN mpesa_result_code INT NULL AFTER mpesa_receipt_number,
  ADD COLUMN mpesa_result_desc VARCHAR(200) NULL AFTER mpesa_result_code,
  ADD CONSTRAINT fk_sale_customer FOREIGN KEY (customer_id) REFERENCES customers(customer_id);

INSERT INTO customers (full_name, phone, address, created_by)
SELECT buyer_name, buyer_phone, MAX(buyer_address), MIN(sold_by)
  FROM produce_sales GROUP BY buyer_name, buyer_phone;

UPDATE produce_sales s
JOIN customers c ON c.full_name = s.buyer_name AND c.phone <=> s.buyer_phone
SET s.customer_id = c.customer_id;
