import PDFDocument from 'pdfkit';

export function createReceiptPdf(sale) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const total = Number(sale.payment_amount_kes ?? Number(sale.quantity) * Number(sale.unit_price_kes)).toFixed(2);
    const date = new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi', dateStyle: 'medium', timeStyle: 'short',
    }).format(new Date(sale.sold_at));
    const produce = sale.produce_type === 'milk' ? 'Milk' : sale.crop_name;
    const row = (label, value) => {
      doc.font('Helvetica-Bold').text(`${label}:`, { continued: true });
      doc.font('Helvetica').text(` ${value ?? '-'}`);
    };

    doc.font('Helvetica-Bold').fontSize(22).fillColor('#1f5a2d').text('SAFM Farm Management');
    doc.moveDown(0.35).fontSize(15).fillColor('#232820').text(`Purchase receipt #${sale.sale_id}`);
    doc.moveDown().fontSize(10);
    row('Date', date);
    row('Customer', sale.buyer_name);
    row('Contact', sale.buyer_phone);
    row('Address', sale.buyer_address);

    doc.moveDown().moveTo(48, doc.y).lineTo(547, doc.y).strokeColor('#e2ded1').stroke();
    doc.moveDown();
    row('Produce', produce);
    row('Quantity', `${sale.quantity} ${sale.unit}`);
    row('Unit price', `KES ${Number(sale.unit_price_kes).toFixed(2)}`);
    row('Payment method', sale.payment_method === 'mpesa' ? 'M-Pesa' : 'Cash');
    row('Payment status', sale.payment_status);
    if (sale.mpesa_receipt_number) row('M-Pesa reference', sale.mpesa_receipt_number);
    doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13).fillColor('#17401f').text(`Total paid: KES ${total}`);
    doc.moveDown().font('Helvetica').fontSize(10).fillColor('#232820');
    row('Recorded by', sale.sold_by);
    doc.end();
  });
}
