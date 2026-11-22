import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { config } from '../config.js';

fs.mkdirSync(config.reportDir, { recursive: true });

export async function writeXlsx(report, meta, file) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SAFM-SYS';
  const cover = wb.addWorksheet('Summary');
  cover.addRows([[report.title], [`Period: ${meta.from} to ${meta.to}`], [`Generated: ${new Date().toISOString()}`], [`By: ${meta.by}`]]);
  cover.getRow(1).font = { bold: true, size: 14 };
  report.sections.forEach((s, i) => {
    const ws = wb.addWorksheet(`${i + 1} ${s.heading}`.slice(0, 31).replace(/[\\/?*[\]:]/g, ''));
    ws.addRow(s.columns).font = { bold: true };
    s.rows.forEach((r) => ws.addRow(r));
    ws.columns.forEach((c, idx) => { c.width = Math.max(14, String(s.columns[idx]).length + 4); });
  });
  await wb.xlsx.writeFile(file);
}

export function writePdf(report, meta, file) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
    const stream = fs.createWriteStream(file);
    doc.pipe(stream);
    stream.on('finish', resolve); stream.on('error', reject);

    doc.fontSize(18).fillColor('#1f5a2d').text(report.title);
    doc.fontSize(9).fillColor('#444').text(`Smart Agricultural Farm Management System  |  Period: ${meta.from} to ${meta.to}  |  Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by ${meta.by}`);
    doc.moveDown();

    const width = doc.page.width - 80;
    for (const s of report.sections) {
      if (doc.y > doc.page.height - 120) doc.addPage();
      doc.fontSize(12).fillColor('#1f5a2d').text(s.heading).moveDown(0.3);
      const colW = width / s.columns.length;
      const row = (cells, bold) => {
        if (doc.y > doc.page.height - 60) doc.addPage();
        const y = doc.y;
        doc.fontSize(8.5).fillColor(bold ? '#000' : '#222').font(bold ? 'Helvetica-Bold' : 'Helvetica');
        let h = 12;
        cells.forEach((c, i) => {
          const t = String(c ?? '');
          doc.text(t, 40 + i * colW, y, { width: colW - 6, lineBreak: true });
          h = Math.max(h, doc.y - y);
        });
        doc.y = y + h + 3;
        if (bold) doc.moveTo(40, doc.y - 1).lineTo(40 + width, doc.y - 1).strokeColor('#999').stroke();
      };
      row(s.columns, true);
      if (!s.rows.length) doc.fontSize(9).fillColor('#777').text('No data for this period.');
      s.rows.forEach((r) => row(r, false));
      doc.font('Helvetica').moveDown();
    }
    doc.end();
  });
}

export const reportPath = (id, ext) => path.join(config.reportDir, `${id}.${ext}`);
