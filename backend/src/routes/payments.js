import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { tx } from '../db.js';
import { config } from '../config.js';
import { HttpError, wrap } from '../utils/http.js';

const r = Router();

function validCallbackSecret(supplied) {
  const expected = config.mpesa.callbackToken;
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function metadataValue(items, name) {
  return items?.find((item) => item.Name === name)?.Value;
}

r.post('/mpesa/callback/:secret', wrap(async (req, res) => {
  if (!validCallbackSecret(req.params.secret)) throw new HttpError(404, 'Not found');
  const callback = req.body?.Body?.stkCallback;
  const rawResultCode = callback?.ResultCode;
  const validResultCode = Number.isInteger(rawResultCode)
    || (typeof rawResultCode === 'string' && /^\d+$/.test(rawResultCode));
  if (!callback?.CheckoutRequestID || !callback?.MerchantRequestID || !validResultCode) {
    throw new HttpError(400, 'Invalid M-Pesa callback');
  }
  const resultCode = Number(callback.ResultCode);
  const items = callback.CallbackMetadata?.Item ?? [];
  const receipt = metadataValue(items, 'MpesaReceiptNumber') || null;
  const amount = metadataValue(items, 'Amount');

  await tx(async (execute) => {
    const [intent] = await execute(
      `SELECT intent_id, produce_type, crop_id, stock_id, customer_id, sold_by, quantity, unit,
              unit_price_kes, payment_amount_kes, payment_status, buyer_name, buyer_phone,
              buyer_address, checkout_request_id, merchant_request_id
         FROM mpesa_payment_intents
        WHERE checkout_request_id = ? AND merchant_request_id = ?
        FOR UPDATE`,
      [callback.CheckoutRequestID, callback.MerchantRequestID]);

    if (intent) {
      if (intent.payment_status !== 'pending') return;

      if (resultCode === 0) {
        if (Number(amount) !== Number(intent.payment_amount_kes)) {
          await execute(
            "UPDATE mpesa_payment_intents SET payment_status = 'review', result_code = ?, result_desc = 'Payment amount mismatch' WHERE intent_id = ?",
            [resultCode, intent.intent_id]);
          return;
        }
        const updated = await execute(
          `UPDATE produce_inventory
              SET quantity = quantity - ?, reserved_quantity = reserved_quantity - ?
            WHERE stock_id = ? AND quantity >= ? AND reserved_quantity >= ?`,
          [intent.quantity, intent.quantity, intent.stock_id, intent.quantity, intent.quantity]);
        if (!updated.affectedRows) throw new HttpError(409, 'Reserved produce stock is inconsistent');
        const sale = await execute(
          `INSERT INTO produce_sales
             (produce_type, crop_id, stock_id, customer_id, sold_by, quantity, unit, unit_price_kes,
              payment_method, payment_status, payment_amount_kes, mpesa_checkout_request_id,
              mpesa_merchant_request_id, mpesa_receipt_number, mpesa_result_code, mpesa_result_desc,
              mpesa_prompt_status, buyer_name, buyer_phone, buyer_address)
           VALUES (?,?,?,?,?,?,?,?,'mpesa','paid',?,?,?,?,?,?,'sent',?,?,?)`,
          [intent.produce_type, intent.crop_id, intent.stock_id, intent.customer_id, intent.sold_by,
            intent.quantity, intent.unit, intent.unit_price_kes, intent.payment_amount_kes,
            callback.CheckoutRequestID, callback.MerchantRequestID, receipt, resultCode,
            String(callback.ResultDesc || '').slice(0, 200) || null,
            intent.buyer_name, intent.buyer_phone, intent.buyer_address]);
        await execute(
          `UPDATE mpesa_payment_intents
              SET payment_status = 'paid', prompt_status = 'sent', sale_id = ?, receipt_number = ?,
                  result_code = ?, result_desc = ?
            WHERE intent_id = ?`,
          [sale.insertId, receipt, resultCode, String(callback.ResultDesc || '').slice(0, 200) || null, intent.intent_id]);
      } else {
        const released = await execute(
          'UPDATE produce_inventory SET reserved_quantity = reserved_quantity - ? WHERE stock_id = ? AND reserved_quantity >= ?',
          [intent.quantity, intent.stock_id, intent.quantity]);
        if (!released.affectedRows) throw new HttpError(409, 'Reserved produce stock is inconsistent');
        await execute(
          `UPDATE mpesa_payment_intents
              SET payment_status = 'failed', prompt_status = 'sent', result_code = ?, result_desc = ?
            WHERE intent_id = ?`,
          [resultCode, String(callback.ResultDesc || 'Payment was not completed').slice(0, 200), intent.intent_id]);
      }
      return;
    }

    // Keep settling requests created before payment intents were introduced.
    const [sale] = await execute(
      `SELECT sale_id, stock_id, quantity, payment_amount_kes, payment_status
         FROM produce_sales
        WHERE mpesa_checkout_request_id = ? AND mpesa_merchant_request_id = ?
        FOR UPDATE`,
      [callback.CheckoutRequestID, callback.MerchantRequestID]);
    if (!sale || sale.payment_status !== 'pending') return;

    if (resultCode === 0) {
      if (Number(amount) !== Number(sale.payment_amount_kes)) {
        await execute(
          "UPDATE produce_sales SET payment_status = 'review', mpesa_prompt_status = 'sent', mpesa_prompt_started_at = NULL, mpesa_result_code = ?, mpesa_result_desc = 'Payment amount mismatch' WHERE sale_id = ?",
          [resultCode, sale.sale_id]);
        return;
      }
      const updated = await execute(
        `UPDATE produce_inventory
            SET quantity = quantity - ?, reserved_quantity = reserved_quantity - ?
          WHERE stock_id = ? AND quantity >= ? AND reserved_quantity >= ?`,
        [sale.quantity, sale.quantity, sale.stock_id, sale.quantity, sale.quantity]);
      if (!updated.affectedRows) throw new HttpError(409, 'Reserved produce stock is inconsistent');
      await execute(
        `UPDATE produce_sales
            SET payment_status = 'paid', mpesa_prompt_status = 'sent', mpesa_prompt_started_at = NULL,
                mpesa_receipt_number = ?, mpesa_result_code = ?, mpesa_result_desc = ?
          WHERE sale_id = ?`,
        [receipt, resultCode, String(callback.ResultDesc || '').slice(0, 200) || null, sale.sale_id]);
    } else {
      const released = await execute(
        'UPDATE produce_inventory SET reserved_quantity = reserved_quantity - ? WHERE stock_id = ? AND reserved_quantity >= ?',
        [sale.quantity, sale.stock_id, sale.quantity]);
      if (!released.affectedRows) throw new HttpError(409, 'Reserved produce stock is inconsistent');
      await execute(
        `UPDATE produce_sales
            SET payment_status = 'failed', mpesa_prompt_status = 'sent', mpesa_prompt_started_at = NULL,
                mpesa_result_code = ?, mpesa_result_desc = ?
          WHERE sale_id = ?`,
        [resultCode, String(callback.ResultDesc || 'Payment was not completed').slice(0, 200), sale.sale_id]);
    }
  });
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
}));

export default r;
