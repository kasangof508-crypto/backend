-- Apply once to let administrators send M-Pesa prompts manually from the sales list.
ALTER TABLE produce_sales
  ADD COLUMN mpesa_prompt_status ENUM('not_sent','sending','sent','uncertain') NULL AFTER payment_status,
  ADD COLUMN mpesa_prompt_started_at DATETIME(3) NULL AFTER mpesa_prompt_status;

UPDATE produce_sales
   SET mpesa_prompt_status = 'sent'
 WHERE payment_method = 'mpesa' AND mpesa_checkout_request_id IS NOT NULL;

UPDATE produce_sales
   SET mpesa_prompt_status = 'uncertain'
 WHERE payment_method = 'mpesa'
   AND payment_status = 'pending'
   AND mpesa_checkout_request_id IS NULL;
