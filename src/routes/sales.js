'use strict';

const express = require('express');
const { db, audit, nextDocNo } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess } = require('../auth');
const {
  text, money, toDate, today, badRequest, notFound, parseAmount, computeDueDate, isBlank, daysBetween
} = require('../util');
const {
  SALES_SELECT, RECEIPT_SELECT, refreshSalesInvoiceStatus, refreshInvoicesForReceipt
} = require('../queries');

const router = express.Router();
router.use(requireAuth);

// ================================================================== sales invoices

router.get('/invoices', requirePermission('sales.view'), (req, res, next) => {
  try {
    const where = [`i.company_id IN (${req.companyIds.map(() => '?').join(',') || '-1'})`];
    const params = [...req.companyIds];

    if (req.query.company_id) {
      where.push('i.company_id = ?');
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    if (req.query.customer_id) {
      where.push('i.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    if (req.query.status) {
      where.push('i.status = ?');
      params.push(String(req.query.status).toUpperCase());
    }
    if (req.query.from) {
      where.push('i.invoice_date >= ?');
      params.push(toDate(req.query.from));
    }
    if (req.query.to) {
      where.push('i.invoice_date <= ?');
      params.push(toDate(req.query.to));
    }
    const q = text(req.query.q);
    if (q) {
      where.push(`(i.invoice_no LIKE '%' || ? || '%' OR cu.name LIKE '%' || ? || '%'
                   OR i.description LIKE '%' || ? || '%' OR i.project_ref LIKE '%' || ? || '%')`);
      params.push(q, q, q, q);
    }

    let rows = db
      .prepare(`${SALES_SELECT} WHERE ${where.join(' AND ')} ORDER BY i.invoice_date DESC, i.id DESC`)
      .all(...params)
      .map(decorateSales);

    const view = String(req.query.view || 'all').toLowerCase();
    if (view === 'overdue') rows = rows.filter((r) => r.is_overdue);
    else if (view === 'open') rows = rows.filter((r) => r.is_open);

    const totals = rows.reduce(
      (t, r) => {
        if (r.status === 'CANCELLED') return t;
        t.total = money(t.total + r.total_amount);
        t.received = money(t.received + r.received_amount);
        t.outstanding = money(t.outstanding + r.outstanding);
        if (r.is_overdue) {
          t.overdue = money(t.overdue + r.outstanding);
          t.overdue_count += 1;
        }
        return t;
      },
      { count: rows.length, total: 0, received: 0, outstanding: 0, overdue: 0, overdue_count: 0 }
    );

    res.json({ rows, totals });
  } catch (err) {
    next(err);
  }
});

router.get('/invoices/:id', requirePermission('sales.view'), (req, res, next) => {
  try {
    const row = db.prepare(`${SALES_SELECT} WHERE i.id = ?`).get(req.params.id);
    if (!row) throw notFound('Invoice not found');
    assertCompanyAccess(req, row.company_id);
    const receipts = db
      .prepare(
        `SELECT a.amount AS allocated, r.* FROM receipt_allocations a
           JOIN receipts r ON r.id = a.receipt_id WHERE a.invoice_id = ?
          ORDER BY r.receipt_date, r.id`
      )
      .all(row.id);
    res.json({ ...decorateSales(row), receipts });
  } catch (err) {
    next(err);
  }
});

router.post('/invoices', requirePermission('sales.create'), (req, res, next) => {
  try {
    const data = readSalesInvoice(req);
    const info = db
      .prepare(
        `INSERT INTO sales_invoices
           (company_id, customer_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
            due_date, currency, subtotal, tax_amount, total_amount, category_id, project_ref,
            lpo_no, description, status, created_by, updated_by)
         VALUES (@company_id, @customer_id, @invoice_no, @invoice_date, @submitted_date,
                 @payment_terms_days, @due_date, @currency, @subtotal, @tax_amount, @total_amount,
                 @category_id, @project_ref, @lpo_no, @description, 'OPEN', @user, @user)`
      )
      .run({ ...data, user: req.user.id });
    audit(req, {
      action: 'CREATE', entity: 'sales_invoice', entity_id: info.lastInsertRowid,
      summary: `Sales invoice ${data.invoice_no} for ${money(data.total_amount)} ${data.currency}`
    });
    res.status(201).json(decorateSales(db.prepare(`${SALES_SELECT} WHERE i.id = ?`).get(info.lastInsertRowid)));
  } catch (err) {
    next(salesDbError(err));
  }
});

router.put('/invoices/:id', requirePermission('sales.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Invoice not found');
    assertCompanyAccess(req, existing.company_id);
    const data = readSalesInvoice(req, existing);
    const received = db
      .prepare('SELECT IFNULL(SUM(amount), 0) a FROM receipt_allocations WHERE invoice_id = ?')
      .get(existing.id).a;
    if (money(data.total_amount) < money(received) - 0.005) {
      throw badRequest(`The invoice total cannot be less than the ${money(received)} already received`);
    }
    db.prepare(
      `UPDATE sales_invoices SET company_id = @company_id, customer_id = @customer_id,
         invoice_no = @invoice_no, invoice_date = @invoice_date, submitted_date = @submitted_date,
         payment_terms_days = @payment_terms_days, due_date = @due_date, currency = @currency,
         subtotal = @subtotal, tax_amount = @tax_amount, total_amount = @total_amount,
         category_id = @category_id, project_ref = @project_ref, lpo_no = @lpo_no,
         description = @description, updated_by = @user, updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...data, id: existing.id, user: req.user.id });
    refreshSalesInvoiceStatus(existing.id);
    audit(req, {
      action: 'UPDATE', entity: 'sales_invoice', entity_id: existing.id,
      summary: `Edited sales invoice ${data.invoice_no}`
    });
    res.json(decorateSales(db.prepare(`${SALES_SELECT} WHERE i.id = ?`).get(existing.id)));
  } catch (err) {
    next(salesDbError(err));
  }
});

router.delete('/invoices/:id', requirePermission('sales.delete'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Invoice not found');
    assertCompanyAccess(req, existing.company_id);
    const used = db.prepare('SELECT COUNT(*) c FROM receipt_allocations WHERE invoice_id = ?').get(existing.id).c;
    if (used > 0) {
      db.prepare("UPDATE sales_invoices SET status = 'CANCELLED' WHERE id = ?").run(existing.id);
      audit(req, { action: 'CANCEL', entity: 'sales_invoice', entity_id: existing.id, summary: `Cancelled sales invoice ${existing.invoice_no}` });
      return res.json({ ok: true, cancelled: true });
    }
    db.prepare('DELETE FROM sales_invoices WHERE id = ?').run(existing.id);
    audit(req, { action: 'DELETE', entity: 'sales_invoice', entity_id: existing.id, summary: `Deleted sales invoice ${existing.invoice_no}` });
    res.json({ ok: true, cancelled: false });
  } catch (err) {
    next(err);
  }
});

router.get('/invoices/open/for-customer/:customerId', requirePermission('sales.view'), (req, res, next) => {
  try {
    const params = [Number(req.params.customerId)];
    let extra = '';
    if (req.query.company_id) {
      extra = ' AND i.company_id = ?';
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    const rows = db
      .prepare(
        `${SALES_SELECT} WHERE i.customer_id = ? ${extra} AND i.status <> 'CANCELLED'
           AND (i.total_amount - IFNULL(rec.amt, 0)) > 0.005
         ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date, i.id`
      )
      .all(...params)
      .map(decorateSales);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ================================================================== receipts

router.get('/receipts', requirePermission('receipt.view'), (req, res, next) => {
  try {
    const where = [`r.company_id IN (${req.companyIds.map(() => '?').join(',') || '-1'})`];
    const params = [...req.companyIds];
    if (req.query.company_id) {
      where.push('r.company_id = ?');
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    if (req.query.customer_id) {
      where.push('r.customer_id = ?');
      params.push(Number(req.query.customer_id));
    }
    if (req.query.mode) {
      where.push('r.mode = ?');
      params.push(String(req.query.mode).toUpperCase());
    }
    if (req.query.from) {
      where.push('r.receipt_date >= ?');
      params.push(toDate(req.query.from));
    }
    if (req.query.to) {
      where.push('r.receipt_date <= ?');
      params.push(toDate(req.query.to));
    }
    if (String(req.query.view || '').toLowerCase() === 'pdc_pending') {
      where.push("r.mode IN ('PDC','CHEQUE') AND r.pdc_status IN ('ISSUED','PRESENTED') AND r.status <> 'CANCELLED'");
    }
    const q = text(req.query.q);
    if (q) {
      where.push(`(r.receipt_no LIKE '%' || ? || '%' OR r.cheque_no LIKE '%' || ? || '%'
                   OR cu.name LIKE '%' || ? || '%' OR r.transfer_ref LIKE '%' || ? || '%')`);
      params.push(q, q, q, q);
    }
    const rows = db
      .prepare(`${RECEIPT_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.receipt_date DESC, r.id DESC`)
      .all(...params)
      .map(decorateReceipt);
    const totals = rows.reduce(
      (t, r) => {
        if (r.status === 'CANCELLED') return t;
        t.total = money(t.total + r.amount);
        if (r.settled) t.settled = money(t.settled + r.amount);
        if (r.pdc_pending) t.pdc_pending = money(t.pdc_pending + r.amount);
        return t;
      },
      { count: rows.length, total: 0, settled: 0, pdc_pending: 0 }
    );
    res.json({ rows, totals });
  } catch (err) {
    next(err);
  }
});

router.post('/receipts', requirePermission('receipt.create'), (req, res, next) => {
  try {
    const data = readReceipt(req);
    const allocations = readReceiptAllocations(req.body.allocations, data);
    const company = db.prepare('SELECT code FROM companies WHERE id = ?').get(data.company_id);

    const id = db.transaction(() => {
      const receiptNo = nextDocNo('RCP', company.code, data.receipt_date);
      const info = db
        .prepare(
          `INSERT INTO receipts
             (company_id, customer_id, receipt_no, receipt_date, amount, currency, mode, receipt_type,
              party_bank_name, transfer_ref, to_bank_account_id, cheque_no, cheque_date,
              cheque_bank_name, pdc_status, status, narration, created_by, updated_by)
           VALUES (@company_id, @customer_id, @receipt_no, @receipt_date, @amount, @currency, @mode,
                   @receipt_type, @party_bank_name, @transfer_ref, @to_bank_account_id, @cheque_no,
                   @cheque_date, @cheque_bank_name, @pdc_status, @status, @narration, @user, @user)`
        )
        .run({ ...data, receipt_no: receiptNo, user: req.user.id });
      const receiptId = info.lastInsertRowid;
      const ins = db.prepare('INSERT INTO receipt_allocations (receipt_id, invoice_id, amount) VALUES (?, ?, ?)');
      allocations.forEach((a) => ins.run(receiptId, a.invoice_id, a.amount));
      return receiptId;
    })();

    refreshInvoicesForReceipt(id);
    const row = decorateReceipt(db.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`).get(id));
    audit(req, {
      action: 'CREATE', entity: 'receipt', entity_id: id,
      summary: `${row.receipt_no}: received ${money(data.amount)} ${data.currency} from ${row.customer_name}`
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/receipts/:id/pdc-status', requirePermission('receipt.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Receipt not found');
    assertCompanyAccess(req, existing.company_id);
    if (existing.mode !== 'PDC' && existing.mode !== 'CHEQUE') {
      throw badRequest('Only cheque receipts have a cheque status');
    }
    const status = String(req.body.status || '').toUpperCase();
    const allowed = ['ISSUED', 'PRESENTED', 'CLEARED', 'SETTLED', 'BOUNCED', 'CANCELLED', 'REPLACED'];
    if (!allowed.includes(status)) throw badRequest(`Cheque status must be one of: ${allowed.join(', ')}`);
    db.prepare(
      `UPDATE receipts SET pdc_status = ?, cleared_date = ?, bounce_reason = ?,
              status = CASE WHEN ? = 'CANCELLED' THEN 'CANCELLED' ELSE 'COMPLETED' END,
              updated_by = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      status, (status === 'CLEARED' || status === 'SETTLED') ? (toDate(req.body.cleared_date) || today()) : null,
      status === 'BOUNCED' ? text(req.body.reason) : null, status, req.user.id, existing.id
    );
    refreshInvoicesForReceipt(existing.id);
    audit(req, {
      action: 'PDC_STATUS', entity: 'receipt', entity_id: existing.id,
      summary: `Customer cheque ${existing.cheque_no || existing.receipt_no} marked ${status.toLowerCase()}`
    });
    res.json(decorateReceipt(db.prepare(`${RECEIPT_SELECT} WHERE r.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

router.delete('/receipts/:id', requirePermission('receipt.delete'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM receipts WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Receipt not found');
    assertCompanyAccess(req, existing.company_id);
    const touched = db.prepare('SELECT invoice_id FROM receipt_allocations WHERE receipt_id = ?')
      .all(existing.id).map((r) => r.invoice_id);
    db.prepare('DELETE FROM receipts WHERE id = ?').run(existing.id);
    touched.forEach(refreshSalesInvoiceStatus);
    audit(req, { action: 'DELETE', entity: 'receipt', entity_id: existing.id, summary: `Deleted receipt ${existing.receipt_no}` });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ helpers

function readSalesInvoice(req, existing) {
  const b = req.body;
  const companyId = assertCompanyAccess(req, b.company_id ?? (existing && existing.company_id));
  const customerId = Number(b.customer_id ?? (existing && existing.customer_id));
  if (!customerId) throw badRequest('Choose a customer');
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw badRequest('That customer no longer exists');

  const invoiceNo = text(b.invoice_no ?? (existing && existing.invoice_no));
  if (!invoiceNo) throw badRequest('Enter the invoice number');
  const invoiceDate = toDate(b.invoice_date ?? (existing && existing.invoice_date));
  if (!invoiceDate) throw badRequest('Enter the invoice date');
  const submittedDate = b.submitted_date === undefined
    ? (existing ? existing.submitted_date : null)
    : toDate(b.submitted_date);
  const terms = Number(b.payment_terms_days ?? (existing ? existing.payment_terms_days : customer.payment_terms_days));

  const subtotal = parseAmount(b.subtotal ?? (existing ? existing.subtotal : 0), 'Amount');
  const tax = parseAmount(b.tax_amount ?? (existing ? existing.tax_amount : 0), 'VAT amount');
  const total = !isBlank(b.total_amount) ? parseAmount(b.total_amount, 'Total') : money(subtotal + tax);
  if (total <= 0) throw badRequest('The invoice total must be more than zero');

  return {
    company_id: companyId,
    customer_id: customerId,
    invoice_no: invoiceNo,
    invoice_date: invoiceDate,
    submitted_date: submittedDate,
    payment_terms_days: terms,
    due_date: computeDueDate({ submitted_date: submittedDate, invoice_date: invoiceDate, payment_terms_days: terms }),
    currency: text(b.currency) || (existing && existing.currency) || process.env.DEFAULT_CURRENCY || 'AED',
    subtotal,
    tax_amount: tax,
    total_amount: total,
    category_id: isBlank(b.category_id) ? (existing ? existing.category_id : null) : Number(b.category_id),
    project_ref: text(b.project_ref),
    lpo_no: text(b.lpo_no),
    description: text(b.description)
  };
}

function readReceipt(req, existing) {
  const b = req.body;
  const companyId = assertCompanyAccess(req, b.company_id ?? (existing && existing.company_id));
  const customerId = Number(b.customer_id ?? (existing && existing.customer_id));
  if (!customerId) throw badRequest('Choose a customer');
  const mode = String(b.mode || 'BANK_TRANSFER').toUpperCase();
  if (!['CASH', 'BANK_TRANSFER', 'PDC', 'CHEQUE', 'ONLINE', 'OTHER'].includes(mode)) {
    throw badRequest('Choose how the money was received');
  }
  const amount = parseAmount(b.amount, 'Amount');
  if (amount <= 0) throw badRequest('The amount must be more than zero');
  const isCheque = mode === 'PDC' || mode === 'CHEQUE';
  if (isCheque && !text(b.cheque_no)) throw badRequest('Enter the cheque number');
  if (isCheque && !toDate(b.cheque_date)) throw badRequest('Enter the cheque date');

  return {
    company_id: companyId,
    customer_id: customerId,
    receipt_date: toDate(b.receipt_date) || today(),
    amount,
    currency: text(b.currency) || process.env.DEFAULT_CURRENCY || 'AED',
    mode,
    receipt_type: String(b.receipt_type || 'INVOICE').toUpperCase() === 'ADVANCE' ? 'ADVANCE' : 'INVOICE',
    party_bank_name: text(b.party_bank_name),
    transfer_ref: text(b.transfer_ref),
    to_bank_account_id: isBlank(b.to_bank_account_id) ? null : Number(b.to_bank_account_id),
    cheque_no: isCheque ? text(b.cheque_no) : null,
    cheque_date: isCheque ? toDate(b.cheque_date) : null,
    cheque_bank_name: isCheque ? text(b.cheque_bank_name) : null,
    pdc_status: isCheque ? String(b.pdc_status || 'ISSUED').toUpperCase() : null,
    status: 'COMPLETED',
    narration: text(b.narration)
  };
}

function readReceiptAllocations(raw, receipt) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = [];
  let sum = 0;
  for (const item of list) {
    const invoiceId = Number(item.invoice_id);
    const amount = parseAmount(item.amount, 'Allocated amount');
    if (!invoiceId || amount <= 0) continue;
    const invoice = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw badRequest('One of the selected invoices no longer exists');
    if (invoice.customer_id !== receipt.customer_id) {
      throw badRequest(`Invoice ${invoice.invoice_no} belongs to a different customer`);
    }
    const others = db
      .prepare(
        `SELECT IFNULL(SUM(a.amount), 0) a FROM receipt_allocations a
           JOIN receipts r ON r.id = a.receipt_id
          WHERE a.invoice_id = ? AND r.status <> 'CANCELLED'`
      )
      .get(invoiceId).a;
    const room = money(invoice.total_amount - others);
    if (amount > room + 0.005) {
      throw badRequest(`Invoice ${invoice.invoice_no} only has ${room.toFixed(2)} left to collect`);
    }
    cleaned.push({ invoice_id: invoiceId, amount });
    sum = money(sum + amount);
  }
  if (sum > money(receipt.amount) + 0.005) {
    throw badRequest('The invoice lines add up to more than the amount received');
  }
  if (receipt.receipt_type === 'INVOICE' && cleaned.length === 0) {
    throw badRequest('Choose the invoice(s) this receipt settles, or record it as an advance');
  }
  return cleaned;
}

function decorateSales(row) {
  if (!row) return row;
  const open = row.status !== 'CANCELLED' && money(row.outstanding) > 0.005;
  const daysOverdue = row.due_date ? daysBetween(row.due_date, today()) : null;
  return {
    ...row,
    is_open: open,
    days_overdue: daysOverdue && daysOverdue > 0 ? daysOverdue : 0,
    is_overdue: open && daysOverdue !== null && daysOverdue > 0
  };
}

function decorateReceipt(row) {
  if (!row) return row;
  const isCheque = row.mode === 'PDC' || row.mode === 'CHEQUE';
  return {
    ...row,
    is_cheque: isCheque,
    pdc_pending: isCheque && ['ISSUED', 'PRESENTED'].includes(row.pdc_status) && row.status !== 'CANCELLED',
    settled: row.status !== 'CANCELLED' && (isCheque ? row.pdc_status === 'CLEARED' : row.status === 'COMPLETED')
  };
}

function salesDbError(err) {
  if (err && /UNIQUE constraint failed: sales_invoices/.test(err.message)) {
    return badRequest('This invoice number is already recorded for that customer in this company');
  }
  return err;
}

module.exports = router;
