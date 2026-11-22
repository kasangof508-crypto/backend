import { Router } from 'express';
import { z } from 'zod';
import { q, tx } from '../db.js';
import { ROLES } from '../config.js';
import { authorize } from '../middleware/auth.js';
import { auditReq } from '../middleware/audit.js';
import { HttpError, wrap } from '../utils/http.js';
import { assertMpesaConfigured, initiateStkPush, normalizeKenyanPhone } from '../services/mpesa.js';
import { createReceiptPdf } from '../services/receiptPdf.js';

const r = Router();
const cropRoles = [ROLES.ADMIN, ROLES.WORKER, ROLES.SYSADMIN];
const productionViewRoles = [ROLES.ADMIN, ROLES.SYSADMIN];

async function sendMpesaPrompt(req, intentId, confirmUncertain = false) {
  assertMpesaConfigured();
  const intent = await tx(async (execute) => {
    const [row] = await execute(
      `SELECT intent_id, stock_id, quantity, payment_amount_kes, payment_status,
              buyer_phone, checkout_request_id, prompt_status,
              (prompt_started_at IS NOT NULL
                AND prompt_started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)) AS prompt_stale
         FROM mpesa_payment_intents WHERE intent_id = ? FOR UPDATE`,
      [intentId]);
    if (!row) throw new HttpError(404, 'M-Pesa payment request not found');
    if (row.payment_status !== 'pending') throw new HttpError(409, 'This payment request is no longer pending');
    if (row.checkout_request_id || row.prompt_status === 'sent') {
      throw new HttpError(409, 'An M-Pesa prompt has already been sent for this request');
    }

    let promptStatus = row.prompt_status;
    if (promptStatus === 'sending') {
      if (!row.prompt_stale) throw new HttpError(409, 'The M-Pesa prompt request is still in progress');
      promptStatus = 'uncertain';
    }
    if (promptStatus === 'uncertain' && !confirmUncertain) {
      throw new HttpError(409, 'The previous request outcome is unknown. Verify with the buyer before retrying.');
    }
    if (!['not_sent', 'uncertain'].includes(promptStatus)) {
      throw new HttpError(409, 'The M-Pesa prompt cannot be sent in its current state');
    }

    const phone = normalizeKenyanPhone(row.buyer_phone);
    await execute(
      "UPDATE mpesa_payment_intents SET prompt_status = 'sending', prompt_started_at = UTC_TIMESTAMP(3), result_desc = NULL WHERE intent_id = ?",
      [intentId]);
    return { ...row, phone };
  });

  let stk;
  try {
    stk = await initiateStkPush({ saleId: intent.intent_id, phone: intent.phone, amount: intent.payment_amount_kes });
  } catch (error) {
    const uncertain = error.status === 503;
    if (uncertain) {
      await q(
        `UPDATE mpesa_payment_intents
            SET prompt_status = 'uncertain', prompt_started_at = NULL, result_desc = ?
          WHERE intent_id = ? AND payment_status = 'pending' AND prompt_status = 'sending'`,
        [String(error.message).slice(0, 200), intentId]);
    } else {
      await tx(async (execute) => {
        const released = await execute(
          'UPDATE produce_inventory SET reserved_quantity = reserved_quantity - ? WHERE stock_id = ? AND reserved_quantity >= ?',
          [intent.quantity, intent.stock_id, intent.quantity]);
        if (!released.affectedRows) throw new HttpError(409, 'Reserved produce stock is inconsistent');
        await execute(
          `UPDATE mpesa_payment_intents
              SET payment_status = 'failed', prompt_status = 'not_sent', prompt_started_at = NULL,
                  result_desc = ?
            WHERE intent_id = ? AND payment_status = 'pending'`,
          [String(error.message).slice(0, 200), intentId]);
      });
    }
    await auditReq(req, 'mpesa_payment_request_failed', 'mpesa_payment_intent', {
      intent_id: intentId, status: uncertain ? 'uncertain' : 'failed',
    });
    throw error;
  }

  await q(
    `UPDATE mpesa_payment_intents
        SET checkout_request_id = ?, merchant_request_id = ?,
            prompt_status = 'sent', prompt_started_at = NULL
      WHERE intent_id = ?`,
    [stk.checkoutRequestId, stk.merchantRequestId, intentId]);
  await auditReq(req, 'mpesa_payment_prompted', 'mpesa_payment_intent', { intent_id: intentId });
  return { intent_id: intentId, payment_status: 'pending', message: 'Payment prompt sent. The sale will be recorded after the buyer approves payment.' };
}

r.get('/cows', authorize(...cropRoles), wrap(async (_req, res) => {
  res.json(await q(
    "SELECT animal_id, tag_id, breed FROM livestock WHERE status = 'active' AND sex = 'F' AND LOWER(species) = 'cattle' ORDER BY tag_id"));
}));

r.get('/crops', authorize(...cropRoles), wrap(async (req, res) => {
  const activeOnly = req.user.role === ROLES.WORKER ? "WHERE c.status = 'active'" : '';
  res.json(await q(
    `SELECT c.crop_id, c.crop_name, c.variety, c.zone_id, z.zone_name, c.planted_on, c.area_ha, c.status, c.created_at
       FROM cultivated_crops c LEFT JOIN zones z ON z.zone_id = c.zone_id ${activeOnly}
      ORDER BY c.status, c.crop_name, c.planted_on DESC`));
}));

r.get('/crop-purchases', authorize(ROLES.ADMIN), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT p.purchase_id, p.crop_name, p.variety, p.quantity, p.unit, p.purchased_on,
            p.supplier, p.total_cost_kes, p.created_at
       FROM crop_purchases p ORDER BY p.crop_name, p.variety, p.purchased_on DESC`));
}));

r.post('/crop-purchases', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({
    crop_name: z.string().trim().min(1).max(80),
    variety: z.string().trim().max(80).optional(),
    quantity: z.number().positive().max(99999999),
    unit: z.string().trim().min(1).max(20),
    purchased_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    supplier: z.string().trim().max(120).optional(),
    total_cost_kes: z.number().min(0).max(9999999999.99).nullable().optional(),
  }).parse(req.body);
  const result = await q(
    `INSERT INTO crop_purchases
       (crop_name, variety, quantity, unit, purchased_on, supplier, total_cost_kes, created_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [b.crop_name, b.variety || null, b.quantity, b.unit, b.purchased_on,
      b.supplier || null, b.total_cost_kes ?? null, req.user.sub]);
  await auditReq(req, 'crop_input_purchased', 'crop_purchase', {
    purchase_id: result.insertId, crop_name: b.crop_name, variety: b.variety ?? null,
    quantity: b.quantity, unit: b.unit, total_cost_kes: b.total_cost_kes ?? null,
  });
  res.status(201).json({ purchase_id: result.insertId });
}));

r.get('/customers', authorize(ROLES.ADMIN), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT c.customer_id, c.full_name, c.phone, c.address, c.created_at,
            COUNT(CASE WHEN s.payment_status = 'paid' THEN 1 END) AS purchases,
            MAX(CASE WHEN s.payment_status = 'paid' THEN s.sold_at END) AS last_purchase_at
       FROM customers c LEFT JOIN produce_sales s ON s.customer_id = c.customer_id
      GROUP BY c.customer_id ORDER BY c.full_name`));
}));

r.post('/customers', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({
    full_name: z.string().trim().min(1).max(120),
    phone: z.string().trim().max(30).optional(),
    address: z.string().trim().max(200).optional(),
  }).parse(req.body);
  const result = await q('INSERT INTO customers (full_name, phone, address, created_by) VALUES (?,?,?,?)',
    [b.full_name, b.phone || null, b.address || null, req.user.sub]);
  await auditReq(req, 'customer_created', 'customer', { customer_id: result.insertId });
  res.status(201).json({ customer_id: result.insertId });
}));

r.post('/crops', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({
    purchase_id: z.number().int().positive(),
    zone_id: z.number().int().positive(),
    planted_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    area_ha: z.number().positive().max(999999.99).nullable().optional(),
  }).parse(req.body);
  const [purchase] = await q(
    'SELECT crop_name, variety FROM crop_purchases WHERE purchase_id = ?',
    [b.purchase_id]);
  if (!purchase) throw new HttpError(400, 'Select a crop from the purchased crop inputs');
  const result = await q(
    'INSERT INTO cultivated_crops (purchase_id, crop_name, variety, zone_id, planted_on, area_ha, created_by) VALUES (?,?,?,?,?,?,?)',
    [b.purchase_id, purchase.crop_name, purchase.variety, b.zone_id, b.planted_on, b.area_ha ?? null, req.user.sub]);
  await auditReq(req, 'crop_created', 'cultivated_crop', {
    crop_id: result.insertId, crop_name: purchase.crop_name, purchase_id: b.purchase_id,
  });
  res.status(201).json({ crop_id: result.insertId });
}));

r.get('/milk', authorize(...cropRoles), wrap(async (req, res) => {
  const own = req.user.role === ROLES.WORKER ? 'WHERE m.recorded_by = ?' : '';
  res.json(await q(
    `SELECT m.milk_id, m.animal_id, a.tag_id, a.breed, m.recorded_at, m.litres, m.notes, u.full_name AS recorded_by
       FROM milk_production m JOIN livestock a ON a.animal_id = m.animal_id
       JOIN users u ON u.user_id = m.recorded_by ${own}
      ORDER BY m.recorded_at DESC LIMIT 500`, own ? [req.user.sub] : []));
}));

r.put('/milk/:id', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({
    litres: z.number().positive().max(1000),
    notes: z.string().trim().max(500).optional(),
  }).parse(req.body);
  await tx(async (execute) => {
    const [record] = await execute('SELECT milk_id, litres FROM milk_production WHERE milk_id = ? FOR UPDATE', [id]);
    if (!record) throw new HttpError(404, 'Milk record not found');
    const [stock] = await execute(
      "SELECT stock_id, quantity, reserved_quantity FROM produce_inventory WHERE stock_key = 'milk:litres' FOR UPDATE");
    if (!stock) throw new HttpError(409, 'Milk inventory record is missing');
    const delta = b.litres - Number(record.litres);
    if (delta < 0 && Number(stock.quantity) - Number(stock.reserved_quantity) < -delta) {
      throw new HttpError(409, 'Cannot reduce this milk record because some of its produce has already been sold or reserved');
    }
    if (delta) await execute('UPDATE produce_inventory SET quantity = quantity + ? WHERE stock_id = ?', [delta, stock.stock_id]);
    await execute('UPDATE milk_production SET litres = ?, notes = ? WHERE milk_id = ?', [b.litres, b.notes || null, id]);
  });
  await auditReq(req, 'milk_production_updated', 'milk_production', { milk_id: id, litres: b.litres });
  res.json({ ok: true });
}));

r.get('/inventory', authorize(...productionViewRoles), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT i.stock_id, i.produce_type, i.crop_id, c.crop_name, i.unit, i.quantity,
            i.reserved_quantity, i.quantity - i.reserved_quantity AS available_quantity
       FROM produce_inventory i LEFT JOIN cultivated_crops c ON c.crop_id = i.crop_id
      ORDER BY i.produce_type, c.crop_name, i.unit`));
}));

r.post('/milk', authorize(ROLES.WORKER, ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({ animal_id: z.string().uuid(), litres: z.number().positive().max(1000), notes: z.string().trim().max(500).optional() }).parse(req.body);
  const milkId = await tx(async (execute) => {
    const [cow] = await execute(
      "SELECT animal_id FROM livestock WHERE animal_id = ? AND status = 'active' AND sex = 'F' AND LOWER(species) = 'cattle' FOR UPDATE",
      [b.animal_id]);
    if (!cow) throw new HttpError(400, 'Select an active female cow');
    const result = await execute('INSERT INTO milk_production (animal_id, recorded_by, litres, notes) VALUES (?,?,?,?)',
      [b.animal_id, req.user.sub, b.litres, b.notes || null]);
    await execute(
      `INSERT INTO produce_inventory (stock_key, produce_type, crop_id, unit, quantity)
       VALUES ('milk:litres','milk',NULL,'litres',?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [b.litres]);
    return result.insertId;
  });
  await auditReq(req, 'milk_production_recorded', 'milk_production', { milk_id: milkId, animal_id: b.animal_id, litres: b.litres });
  res.status(201).json({ milk_id: milkId });
}));

r.get('/harvests', authorize(...cropRoles), wrap(async (req, res) => {
  const own = req.user.role === ROLES.WORKER ? 'WHERE h.recorded_by = ?' : '';
  res.json(await q(
    `SELECT h.harvest_id, h.crop_id, c.crop_name, c.variety, h.harvested_at, h.quantity, h.unit, h.notes, u.full_name AS recorded_by
       FROM crop_harvests h JOIN cultivated_crops c ON c.crop_id = h.crop_id
       JOIN users u ON u.user_id = h.recorded_by ${own}
      ORDER BY h.harvested_at DESC LIMIT 500`, own ? [req.user.sub] : []));
}));

r.post('/harvests', authorize(ROLES.WORKER, ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({
    crop_id: z.number().int().positive(),
    quantity: z.number().positive().max(99999999),
    unit: z.string().trim().min(1).max(20),
    notes: z.string().trim().max(500).optional(),
  }).parse(req.body);
  const unit = b.unit.toLowerCase();
  const harvestId = await tx(async (execute) => {
    const [crop] = await execute("SELECT crop_id FROM cultivated_crops WHERE crop_id = ? AND status = 'active' FOR UPDATE", [b.crop_id]);
    if (!crop) throw new HttpError(400, 'Select an active crop');
    const result = await execute('INSERT INTO crop_harvests (crop_id, recorded_by, quantity, unit, notes) VALUES (?,?,?,?,?)',
      [b.crop_id, req.user.sub, b.quantity, unit, b.notes || null]);
    await execute(
      `INSERT INTO produce_inventory (stock_key, produce_type, crop_id, unit, quantity)
       VALUES (?,?,?, ?,?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [`crop:${b.crop_id}:${unit}`, 'crop', b.crop_id, unit, b.quantity]);
    return result.insertId;
  });
  await auditReq(req, 'crop_harvest_recorded', 'crop_harvest', { harvest_id: harvestId, crop_id: b.crop_id, quantity: b.quantity, unit });
  res.status(201).json({ harvest_id: harvestId });
}));

r.put('/harvests/:id', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({
    crop_id: z.number().int().positive().optional(),
    quantity: z.number().positive().max(99999999),
    unit: z.string().trim().min(1).max(20),
    notes: z.string().trim().max(500).optional(),
  }).parse(req.body);
  const unit = b.unit.toLowerCase();
  await tx(async (execute) => {
    const [record] = await execute(
      'SELECT harvest_id, crop_id, quantity, unit, notes FROM crop_harvests WHERE harvest_id = ? FOR UPDATE',
      [id]);
    if (!record) throw new HttpError(404, 'Harvest record not found');
    const cropId = b.crop_id ?? record.crop_id;
    const [crop] = await execute(
      "SELECT crop_id FROM cultivated_crops WHERE crop_id = ? AND (status = 'active' OR crop_id = ?) FOR UPDATE",
      [cropId, record.crop_id]);
    if (!crop) throw new HttpError(400, 'Select an active crop');
    const oldUnit = String(record.unit).toLowerCase();
    const oldKey = `crop:${record.crop_id}:${oldUnit}`;
    const newKey = `crop:${cropId}:${unit}`;

    if (oldKey === newKey) {
      const [stock] = await execute('SELECT stock_id, quantity, reserved_quantity FROM produce_inventory WHERE stock_key = ? FOR UPDATE', [oldKey]);
      if (!stock) throw new HttpError(409, 'Crop inventory record is missing');
      const delta = b.quantity - Number(record.quantity);
      if (delta < 0 && Number(stock.quantity) - Number(stock.reserved_quantity) < -delta) {
        throw new HttpError(409, 'Cannot reduce this harvest because some of its produce has already been sold or reserved');
      }
      if (delta) await execute('UPDATE produce_inventory SET quantity = quantity + ? WHERE stock_id = ?', [delta, stock.stock_id]);
    } else {
      await execute(
        `INSERT IGNORE INTO produce_inventory (stock_key, produce_type, crop_id, unit, quantity)
         VALUES (?,?,?, ?,0)`,
        [newKey, 'crop', cropId, unit]);
      const stocks = await execute(
        'SELECT stock_id, stock_key, quantity, reserved_quantity FROM produce_inventory WHERE stock_key IN (?,?) ORDER BY stock_key FOR UPDATE',
        [oldKey, newKey]);
      const oldStock = stocks.find((stock) => stock.stock_key === oldKey);
      const newStock = stocks.find((stock) => stock.stock_key === newKey);
      if (!oldStock || !newStock) throw new HttpError(409, 'Crop inventory record is missing');
      if (Number(oldStock.quantity) - Number(oldStock.reserved_quantity) < Number(record.quantity)) {
        throw new HttpError(409, 'Cannot change this harvest because some of its produce has already been sold or reserved');
      }
      await execute('UPDATE produce_inventory SET quantity = quantity - ? WHERE stock_id = ?', [record.quantity, oldStock.stock_id]);
      await execute('UPDATE produce_inventory SET quantity = quantity + ? WHERE stock_id = ?', [b.quantity, newStock.stock_id]);
    }
    await execute(
      'UPDATE crop_harvests SET crop_id = ?, quantity = ?, unit = ?, notes = ? WHERE harvest_id = ?',
      [cropId, b.quantity, unit, b.notes ?? record.notes, id]);
  });
  await auditReq(req, 'crop_harvest_updated', 'crop_harvest', { harvest_id: id, crop_id: b.crop_id, quantity: b.quantity, unit });
  res.json({ ok: true });
}));

r.get('/sales', authorize(...productionViewRoles), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT s.sale_id, s.produce_type, s.crop_id, c.crop_name, s.customer_id, s.sold_at, s.quantity, s.unit, s.unit_price_kes,
            s.payment_method, s.payment_status, s.payment_amount_kes, s.mpesa_receipt_number, s.mpesa_result_desc,
            s.buyer_name, s.buyer_phone, s.buyer_address, u.full_name AS sold_by
       FROM produce_sales s LEFT JOIN cultivated_crops c ON c.crop_id = s.crop_id
       JOIN users u ON u.user_id = s.sold_by ORDER BY s.sold_at DESC LIMIT 500`));
}));

r.get('/sales/:id/receipt', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const [sale] = await q(
    `SELECT s.sale_id, s.produce_type, c.crop_name, s.sold_at, s.quantity, s.unit, s.unit_price_kes,
           s.payment_method, s.payment_status, s.payment_amount_kes, s.mpesa_receipt_number,
           s.buyer_name, s.buyer_phone, s.buyer_address, u.full_name AS sold_by
       FROM produce_sales s LEFT JOIN cultivated_crops c ON c.crop_id = s.crop_id
       JOIN users u ON u.user_id = s.sold_by WHERE s.sale_id = ?`,
    [id]);
  if (!sale) throw new HttpError(404, 'Sale not found');
  if (sale.payment_status !== 'paid') throw new HttpError(409, 'Receipt is available only after payment is confirmed');

  const pdf = await createReceiptPdf(sale);
  await auditReq(req, 'receipt_downloaded', 'produce_sale', { sale_id: sale.sale_id });
  res.type('application/pdf').attachment(`SAFM_receipt_${sale.sale_id}.pdf`).send(pdf);
}));

r.get('/mpesa-requests', authorize(...productionViewRoles), wrap(async (_req, res) => {
  res.json(await q(
    `SELECT i.intent_id, i.produce_type, i.crop_id, c.crop_name, i.created_at, i.quantity, i.unit,
             i.unit_price_kes, i.payment_amount_kes, i.payment_status, i.result_desc, i.sale_id,
             CASE WHEN i.prompt_status = 'sending'
                       AND i.prompt_started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 MINUTE)
                  THEN 'uncertain' ELSE i.prompt_status END AS prompt_status,
             i.buyer_name, i.buyer_phone, u.full_name AS requested_by
        FROM mpesa_payment_intents i LEFT JOIN cultivated_crops c ON c.crop_id = i.crop_id
        JOIN users u ON u.user_id = i.sold_by
       ORDER BY i.created_at DESC LIMIT 100`));
}));

r.post('/sales', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const b = z.object({
    stock_id: z.number().int().positive(),
    customer_id: z.number().int().positive(),
    quantity: z.number().positive().max(99999999),
    unit_price_kes: z.number().min(0).max(99999999.99),
    payment_method: z.enum(['mpesa', 'cash']),
    buyer_phone: z.string().trim().max(30).optional(),
  }).parse(req.body);
  const [customer] = await q('SELECT customer_id, full_name, phone, address FROM customers WHERE customer_id = ?', [b.customer_id]);
  if (!customer) throw new HttpError(404, 'Customer not found');
  const buyerPhone = b.buyer_phone || customer.phone;
  const isMpesa = b.payment_method === 'mpesa';
  const phone = isMpesa ? normalizeKenyanPhone(buyerPhone) : buyerPhone || null;
  const paymentAmount = Math.round(b.quantity * b.unit_price_kes);
  if (isMpesa && paymentAmount < 1) throw new HttpError(400, 'M-Pesa sale amount must be at least KES 1');
  if (isMpesa && (!Number.isSafeInteger(paymentAmount) || paymentAmount > 2147483647)) {
    throw new HttpError(400, 'M-Pesa sale amount exceeds the supported limit');
  }
  if (isMpesa) assertMpesaConfigured();

  const recordId = await tx(async (execute) => {
    const [stock] = await execute(
      'SELECT stock_id, produce_type, crop_id, unit, quantity, reserved_quantity FROM produce_inventory WHERE stock_id = ? FOR UPDATE',
      [b.stock_id]);
    if (!stock) throw new HttpError(404, 'Produce stock was not found');
    const available = Number(stock.quantity) - Number(stock.reserved_quantity);
    if (b.quantity > available) throw new HttpError(409, `Only ${available} ${stock.unit} are available`);
    if (isMpesa) {
      await execute('UPDATE produce_inventory SET reserved_quantity = reserved_quantity + ? WHERE stock_id = ?', [b.quantity, b.stock_id]);
      const result = await execute(
        `INSERT INTO mpesa_payment_intents
           (produce_type, crop_id, stock_id, customer_id, sold_by, quantity, unit, unit_price_kes,
            payment_amount_kes, buyer_name, buyer_phone, buyer_address)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [stock.produce_type, stock.crop_id, stock.stock_id, customer.customer_id, req.user.sub,
          b.quantity, stock.unit, b.unit_price_kes, paymentAmount, customer.full_name, phone, customer.address]);
      return result.insertId;
    }
    await execute('UPDATE produce_inventory SET quantity = quantity - ? WHERE stock_id = ?', [b.quantity, b.stock_id]);
    const result = await execute(
      `INSERT INTO produce_sales
         (produce_type, crop_id, stock_id, customer_id, sold_by, quantity, unit, unit_price_kes,
          payment_method, payment_status, buyer_name, buyer_phone, buyer_address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [stock.produce_type, stock.crop_id, stock.stock_id, customer.customer_id, req.user.sub, b.quantity, stock.unit,
        b.unit_price_kes, b.payment_method, 'paid',
        customer.full_name, phone, customer.address]);
    return result.insertId;
  });

  if (isMpesa) {
    try {
      const result = await sendMpesaPrompt(req, recordId);
      res.status(201).json(result);
    } catch (error) {
      await q(
        'UPDATE mpesa_payment_intents SET result_desc = ? WHERE intent_id = ? AND result_desc IS NULL',
        [String(error.message).slice(0, 200), recordId]);
      const [request] = await q(
        'SELECT payment_status, prompt_status, sale_id FROM mpesa_payment_intents WHERE intent_id = ?',
        [recordId]);
      if (request?.payment_status === 'paid') {
        res.status(201).json({
          intent_id: recordId, sale_id: request.sale_id, payment_status: 'paid',
          message: 'Payment was confirmed and the sale was recorded.',
        });
        return;
      }
      if (request?.payment_status === 'pending' && request.prompt_status === 'sent') {
        res.status(201).json({
          intent_id: recordId, payment_status: 'pending',
          message: 'Payment prompt sent. The sale will be recorded after the buyer approves payment.',
        });
        return;
      }
      if (request?.payment_status === 'pending' && request.prompt_status === 'sending') {
        await q(
          "UPDATE mpesa_payment_intents SET prompt_status = 'uncertain', prompt_started_at = NULL WHERE intent_id = ? AND prompt_status = 'sending'",
          [recordId]);
        request.prompt_status = 'uncertain';
      }
      if (request?.payment_status === 'pending' && request?.prompt_status === 'uncertain') {
        res.status(202).json({
          intent_id: recordId, payment_status: 'pending', prompt_status: 'uncertain',
          message: 'The prompt request outcome is unknown. Check with the buyer before retrying.',
        });
        return;
      }
      throw error;
    }
    return;
  }

  await auditReq(req, 'produce_sale_recorded', 'produce_sale', {
    sale_id: recordId, stock_id: b.stock_id, customer_id: customer.customer_id,
    quantity: b.quantity, payment_method: b.payment_method,
  });
  const [sale] = await q(
    `SELECT s.sale_id, s.produce_type, c.crop_name, s.customer_id, s.sold_at, s.quantity, s.unit,
            s.unit_price_kes, s.payment_method, s.payment_status, s.payment_amount_kes,
            s.mpesa_receipt_number, s.buyer_name, s.buyer_phone, s.buyer_address, u.full_name AS sold_by
       FROM produce_sales s LEFT JOIN cultivated_crops c ON c.crop_id = s.crop_id
       JOIN users u ON u.user_id = s.sold_by WHERE s.sale_id = ?`,
    [recordId]);
  res.status(201).json({ ...sale, message: 'Sale recorded successfully.' });
}));

r.post('/mpesa-requests/:id/prompt', authorize(ROLES.ADMIN), wrap(async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id);
  const b = z.object({ confirm_uncertain: z.boolean().optional() }).parse(req.body ?? {});
  res.json(await sendMpesaPrompt(req, id, b.confirm_uncertain));
}));

export default r;
