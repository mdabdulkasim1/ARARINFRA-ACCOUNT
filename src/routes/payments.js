'use strict';

const express = require('express');
const { db, audit, nextDocNo } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess } = require('../auth');
const {
  text, money, toDate, today, badRequest, notFound, parseAmount, isBlank, daysBetween
} = require('../util');
const {
  PAYMENT_SELECT, refreshInvoiceStatus, refreshInvoicesForPayment
} = require('../queries');

const router = express.Router();
router.use(requireAuth);

const MODES = ['CASH', 'BANK_TRANSFER', 'PDC', 'CHEQUE', 'ONLINE', 'OTHER'];
const PDC_STATUSES = ['ISSUED', 'PRESENTED', 'CLEARED', 'BOUNCED', 'CANCELLED', 'REPLACED'];

/**
 * List payments.
 * Filters: company_id, supplier_id, mode, payment_type, pdc_status, from, to, q,
 *          view = all | pdc_pending | advances_open
 */
router.get('/', requirePermission('payment.view'), (req, res, next) => {
  try {
    const where = [`p.company_id IN (${req.companyIds.map(() => '?').join(',') || '-1'})`];
    const params = [...req.companyIds];

    if (req.query.company_id) {
      where.push('p.company_id = ?');
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    if (req.query.supplier_id) {
      where.push('p.supplier_id = ?');
      params.push(Number(req.query.supplier_id));
    }
    if (req.query.mode) {
      where.push('p.mode = ?');
      params.push(String(req.query.mode).toUpperCase());
    }
    if (req.query.payment_type) {
      where.push('p.payment_type = ?');
      params.push(String(req.query.payment_type).toUpperCase());
    }
    if (req.query.pdc_status) {
      where.push('p.pdc_status = ?');
      params.push(String(req.query.pdc_status).toUpperCase());
    }
    if (req.query.from) {
      where.push("COALESCE(CASE WHEN p.mode IN ('PDC','CHEQUE') THEN p.cheque_date END, p.payment_date) >= ?");
      params.push(toDate(req.query.from));
    }
    if (req.query.to) {
      where.push("COALESCE(CASE WHEN p.mode IN ('PDC','CHEQUE') THEN p.cheque_date END, p.payment_date) <= ?");
      params.push(toDate(req.query.to));
    }
    const q = text(req.query.q);
    if (q) {
      where.push(`(p.payment_no LIKE '%' || ? || '%' OR p.cheque_no LIKE '%' || ? || '%'
                   OR p.transfer_ref LIKE '%' || ? || '%' OR s.name LIKE '%' || ? || '%'
                   OR p.narration LIKE '%' || ? || '%')`);
      params.push(q, q, q, q, q);
    }

    const view = String(req.query.view || 'all').toLowerCase();
    if (view === 'pdc_pending') {
      where.push("p.mode IN ('PDC','CHEQUE') AND p.pdc_status IN ('ISSUED','PRESENTED') AND p.status <> 'CANCELLED'");
    } else if (view === 'advances_open') {
      where.push("p.payment_type = 'ADVANCE' AND p.status <> 'CANCELLED' AND (p.amount - IFNULL(al.amt, 0)) > 0.005");
    }

    const orderBy = view === 'pdc_pending'
      ? 'p.cheque_date ASC, p.id ASC'
      : 'p.payment_date DESC, p.id DESC';

    const rows = db
      .prepare(`${PAYMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`)
      .all(...params)
      .map(decorate);

    res.json({ rows, totals: summarisePayments(rows) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('payment.view'), (req, res, next) => {
  try {
    const row = db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(req.params.id);
    if (!row) throw notFound('Payment not found');
    assertCompanyAccess(req, row.company_id);
    const allocations = db
      .prepare(
        `SELECT a.id, a.amount, i.id AS invoice_id, i.invoice_no, i.invoice_date,
                i.submitted_date, i.due_date, i.total_amount
           FROM payment_allocations a
           JOIN purchase_invoices i ON i.id = a.invoice_id
          WHERE a.payment_id = ? ORDER BY i.due_date, i.id`
      )
      .all(row.id);
    res.json({ ...decorate(row), allocations });
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission('payment.create'), (req, res, next) => {
  try {
    const data = readPayment(req);
    const allocations = readAllocations(req.body.allocations, data);

    const company = db.prepare('SELECT code FROM companies WHERE id = ?').get(data.company_id);

    const created = db.transaction(() => {
      const paymentNo = nextDocNo(prefixFor(data.mode), company.code, data.payment_date);
      const info = db
        .prepare(
          `INSERT INTO payments
             (company_id, supplier_id, payment_no, payment_date, amount, currency, mode, payment_type,
              party_bank_name, party_account_no, party_iban, transfer_ref, from_bank_account_id,
              cheque_no, cheque_date, cheque_bank_name, pdc_status, status, narration,
              created_by, updated_by)
           VALUES (@company_id, @supplier_id, @payment_no, @payment_date, @amount, @currency, @mode,
                   @payment_type, @party_bank_name, @party_account_no, @party_iban, @transfer_ref,
                   @from_bank_account_id, @cheque_no, @cheque_date, @cheque_bank_name, @pdc_status,
                   @status, @narration, @user, @user)`
        )
        .run({ ...data, payment_no: paymentNo, user: req.user.id });
      const paymentId = info.lastInsertRowid;
      insertAllocations(paymentId, allocations);
      return paymentId;
    })();

    refreshInvoicesForPayment(created);
    const row = decorate(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(created));
    audit(req, {
      action: 'CREATE', entity: 'payment', entity_id: created,
      summary: `${row.payment_no}: ${money(data.amount)} ${data.currency} to ${row.supplier_name} by ${label(data.mode)}` +
               (data.payment_type === 'ADVANCE' ? ' (advance)' : ''),
      details: { ...data, allocations }
    });
    res.status(201).json(row);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requirePermission('payment.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Payment not found');
    assertCompanyAccess(req, existing.company_id);
    if (existing.pdc_status === 'CLEARED' && existing.mode !== 'CASH') {
      throw badRequest('This cheque has already cleared - it can no longer be edited');
    }

    const data = readPayment(req, existing);
    const allocations = readAllocations(
      req.body.allocations === undefined ? currentAllocations(existing.id) : req.body.allocations,
      data,
      existing.id
    );
    const touched = new Set(db
      .prepare('SELECT invoice_id FROM payment_allocations WHERE payment_id = ?')
      .all(existing.id).map((r) => r.invoice_id));

    db.transaction(() => {
      db.prepare(
        `UPDATE payments SET
           company_id = @company_id, supplier_id = @supplier_id, payment_date = @payment_date,
           amount = @amount, currency = @currency, mode = @mode, payment_type = @payment_type,
           party_bank_name = @party_bank_name, party_account_no = @party_account_no,
           party_iban = @party_iban, transfer_ref = @transfer_ref,
           from_bank_account_id = @from_bank_account_id, cheque_no = @cheque_no,
           cheque_date = @cheque_date, cheque_bank_name = @cheque_bank_name,
           pdc_status = @pdc_status, status = @status, narration = @narration,
           updated_by = @user, updated_at = datetime('now')
         WHERE id = @id`
      ).run({ ...data, id: existing.id, user: req.user.id });
      db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(existing.id);
      insertAllocations(existing.id, allocations);
    })();

    allocations.forEach((a) => touched.add(a.invoice_id));
    touched.forEach(refreshInvoiceStatus);

    audit(req, {
      action: 'UPDATE', entity: 'payment', entity_id: existing.id,
      summary: `Edited payment ${existing.payment_no}`, details: { ...data, allocations }
    });
    res.json(decorate(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

/**
 * Move a cheque along: presented, cleared, bounced, cancelled or replaced.
 * Until a cheque clears it is only a commitment, so this is what turns a PDC
 * into money that has actually gone out.
 */
router.post('/:id/pdc-status', requirePermission('payment.pdcstatus'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Payment not found');
    assertCompanyAccess(req, existing.company_id);
    if (existing.mode !== 'PDC' && existing.mode !== 'CHEQUE') {
      throw badRequest('Only cheque payments have a cheque status');
    }
    const status = String(req.body.status || '').toUpperCase();
    if (!PDC_STATUSES.includes(status)) {
      throw badRequest(`Cheque status must be one of: ${PDC_STATUSES.join(', ')}`);
    }
    const clearedDate = status === 'CLEARED'
      ? (toDate(req.body.cleared_date) || today())
      : null;
    const reason = text(req.body.reason);
    if (status === 'BOUNCED' && !reason) throw badRequest('Enter the reason the cheque bounced');

    db.prepare(
      `UPDATE payments SET pdc_status = ?, cleared_date = ?, bounce_reason = ?,
              status = CASE WHEN ? IN ('CANCELLED') THEN 'CANCELLED' ELSE 'COMPLETED' END,
              updated_by = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(status, clearedDate, status === 'BOUNCED' ? reason : null, status, req.user.id, existing.id);

    refreshInvoicesForPayment(existing.id);
    audit(req, {
      action: 'PDC_STATUS', entity: 'payment', entity_id: existing.id,
      summary: `Cheque ${existing.cheque_no || existing.payment_no} marked ${label(status)}`,
      details: { from: existing.pdc_status, to: status, cleared_date: clearedDate, reason }
    });
    res.json(decorate(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

/** Set an existing advance (or its unused part) against invoices. */
router.post('/:id/allocate', requirePermission('payment.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Payment not found');
    assertCompanyAccess(req, existing.company_id);

    const incoming = Array.isArray(req.body.allocations) ? req.body.allocations : [];
    if (!incoming.length) throw badRequest('Choose at least one invoice');

    const merged = mergeAllocations(currentAllocations(existing.id), incoming);
    const allocations = readAllocations(merged, existing, existing.id);
    const touched = new Set(db
      .prepare('SELECT invoice_id FROM payment_allocations WHERE payment_id = ?')
      .all(existing.id).map((r) => r.invoice_id));

    db.transaction(() => {
      db.prepare('DELETE FROM payment_allocations WHERE payment_id = ?').run(existing.id);
      insertAllocations(existing.id, allocations);
    })();

    allocations.forEach((a) => touched.add(a.invoice_id));
    touched.forEach(refreshInvoiceStatus);

    audit(req, {
      action: 'ALLOCATE', entity: 'payment', entity_id: existing.id,
      summary: `Set advance ${existing.payment_no} against ${allocations.length} invoice(s)`,
      details: allocations
    });
    res.json(decorate(db.prepare(`${PAYMENT_SELECT} WHERE p.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('payment.delete'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Payment not found');
    assertCompanyAccess(req, existing.company_id);
    const touched = db
      .prepare('SELECT invoice_id FROM payment_allocations WHERE payment_id = ?')
      .all(existing.id).map((r) => r.invoice_id);

    db.prepare('DELETE FROM payments WHERE id = ?').run(existing.id);
    touched.forEach(refreshInvoiceStatus);
    audit(req, {
      action: 'DELETE', entity: 'payment', entity_id: existing.id,
      summary: `Deleted payment ${existing.payment_no} of ${money(existing.amount)}`,
      details: existing
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ helpers

function prefixFor(mode) {
  if (mode === 'PDC') return 'PDC';
  if (mode === 'CHEQUE') return 'CHQ';
  return 'PAY';
}

function label(v) {
  return String(v || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function readPayment(req, existing) {
  const b = req.body;
  const companyId = assertCompanyAccess(req, b.company_id ?? (existing && existing.company_id));
  const supplierId = Number(b.supplier_id ?? (existing && existing.supplier_id));
  if (!supplierId) throw badRequest('Choose a supplier');
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) throw badRequest('That supplier no longer exists');

  const mode = String(b.mode ?? (existing && existing.mode) ?? '').toUpperCase();
  if (!MODES.includes(mode)) throw badRequest(`Choose a payment mode: ${MODES.join(', ')}`);

  const paymentType = String(b.payment_type ?? (existing && existing.payment_type) ?? 'INVOICE').toUpperCase();
  if (!['INVOICE', 'ADVANCE'].includes(paymentType)) {
    throw badRequest('Payment type must be Against Invoice or Advance');
  }

  const paymentDate = toDate(b.payment_date ?? (existing && existing.payment_date)) || today();
  const amount = parseAmount(b.amount ?? (existing && existing.amount), 'Amount');
  if (amount <= 0) throw badRequest('The payment amount must be more than zero');

  const isCheque = mode === 'PDC' || mode === 'CHEQUE';
  const isTransfer = mode === 'BANK_TRANSFER' || mode === 'ONLINE';

  let partyBank = text(b.party_bank_name);
  if (isTransfer) {
    // The owner wants to see which bank the money went to, every time.
    partyBank = partyBank || supplier.bank_name;
    if (!partyBank) {
      throw badRequest("Enter the supplier's bank name for a bank transfer");
    }
  }

  let chequeNo = null;
  let chequeDate = null;
  let chequeBank = null;
  let pdcStatus = null;
  if (isCheque) {
    chequeNo = text(b.cheque_no);
    if (!chequeNo) throw badRequest('Enter the cheque number');
    chequeDate = toDate(b.cheque_date);
    if (!chequeDate) throw badRequest('Enter the cheque date (the date written on the cheque)');
    chequeBank = text(b.cheque_bank_name) ||
      (b.from_bank_account_id
        ? (db.prepare('SELECT bank_name FROM bank_accounts WHERE id = ?').get(Number(b.from_bank_account_id)) || {}).bank_name
        : null);
    if (!chequeBank) throw badRequest('Enter the bank the cheque is drawn on');
    pdcStatus = String(b.pdc_status || (existing && existing.pdc_status) || 'ISSUED').toUpperCase();
    if (!PDC_STATUSES.includes(pdcStatus)) throw badRequest('Invalid cheque status');
  }

  let status = String(b.status ?? (existing && existing.status) ?? 'COMPLETED').toUpperCase();
  if (!['COMPLETED', 'PENDING', 'CANCELLED'].includes(status)) status = 'COMPLETED';

  return {
    company_id: companyId,
    supplier_id: supplierId,
    payment_date: paymentDate,
    amount,
    currency: text(b.currency) || (existing && existing.currency) || process.env.DEFAULT_CURRENCY || 'AED',
    mode,
    payment_type: paymentType,
    party_bank_name: partyBank,
    party_account_no: text(b.party_account_no) || (isTransfer ? supplier.bank_account_no : null),
    party_iban: text(b.party_iban) || (isTransfer ? supplier.iban : null),
    transfer_ref: text(b.transfer_ref),
    from_bank_account_id: isBlank(b.from_bank_account_id) ? null : Number(b.from_bank_account_id),
    cheque_no: chequeNo,
    cheque_date: chequeDate,
    cheque_bank_name: chequeBank,
    pdc_status: pdcStatus,
    status,
    narration: text(b.narration)
  };
}

function currentAllocations(paymentId) {
  return db
    .prepare('SELECT invoice_id, amount FROM payment_allocations WHERE payment_id = ?')
    .all(paymentId);
}

function mergeAllocations(existing, incoming) {
  const map = new Map();
  existing.forEach((a) => map.set(Number(a.invoice_id), money(a.amount)));
  incoming.forEach((a) => {
    const id = Number(a.invoice_id);
    map.set(id, money((map.get(id) || 0) + money(a.amount)));
  });
  return [...map.entries()].map(([invoice_id, amount]) => ({ invoice_id, amount }));
}

/**
 * Check the invoice lines of a payment: same supplier, sensible amounts, and
 * never more than the invoice still owes.
 */
function readAllocations(raw, payment, ignorePaymentId) {
  const list = Array.isArray(raw) ? raw : [];
  const cleaned = [];
  let sum = 0;

  for (const item of list) {
    const invoiceId = Number(item.invoice_id);
    const amount = parseAmount(item.amount, 'Allocated amount');
    if (!invoiceId || amount <= 0) continue;

    const invoice = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(invoiceId);
    if (!invoice) throw badRequest('One of the selected invoices no longer exists');
    if (invoice.supplier_id !== payment.supplier_id) {
      throw badRequest(`Invoice ${invoice.invoice_no} belongs to a different supplier`);
    }
    if (invoice.company_id !== payment.company_id) {
      throw badRequest(`Invoice ${invoice.invoice_no} belongs to a different company`);
    }
    if (invoice.status === 'CANCELLED') {
      throw badRequest(`Invoice ${invoice.invoice_no} has been cancelled`);
    }

    // What is already committed to this invoice by everyone except this payment.
    const others = db
      .prepare(
        `SELECT IFNULL(SUM(a.amount), 0) a
           FROM payment_allocations a
           JOIN payments p ON p.id = a.payment_id
          WHERE a.invoice_id = ? AND p.status <> 'CANCELLED' AND a.payment_id <> ?`
      )
      .get(invoiceId, ignorePaymentId || -1).a;
    const room = money(invoice.total_amount - others);
    if (amount > room + 0.005) {
      throw badRequest(
        `Invoice ${invoice.invoice_no} only has ${room.toFixed(2)} left to settle, ` +
        `but ${amount.toFixed(2)} was entered`
      );
    }

    cleaned.push({ invoice_id: invoiceId, amount });
    sum = money(sum + amount);
  }

  if (sum > money(payment.amount) + 0.005) {
    throw badRequest(
      `The invoice lines add up to ${sum.toFixed(2)}, which is more than the payment of ${money(payment.amount).toFixed(2)}`
    );
  }
  if (payment.payment_type === 'INVOICE' && cleaned.length === 0) {
    throw badRequest('Choose the invoice(s) this payment settles, or record it as an advance');
  }
  return cleaned;
}

function insertAllocations(paymentId, allocations) {
  const ins = db.prepare(
    'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)'
  );
  allocations.forEach((a) => ins.run(paymentId, a.invoice_id, a.amount));
}

/** Add the fields the cheque register colours by. */
function decorate(row) {
  if (!row) return row;
  const isCheque = row.mode === 'PDC' || row.mode === 'CHEQUE';
  const pending = isCheque && ['ISSUED', 'PRESENTED'].includes(row.pdc_status) && row.status !== 'CANCELLED';
  const daysToCheque = isCheque && row.cheque_date ? daysBetween(today(), row.cheque_date) : null;
  return {
    ...row,
    is_cheque: isCheque,
    pdc_pending: pending,
    is_advance: row.payment_type === 'ADVANCE',
    has_unallocated: money(row.unallocated_amount) > 0.005 && row.status !== 'CANCELLED',
    days_to_cheque_date: daysToCheque,
    cheque_due_soon: pending && daysToCheque !== null && daysToCheque >= 0 && daysToCheque <= 7,
    cheque_date_passed: pending && daysToCheque !== null && daysToCheque < 0,
    settled: row.status !== 'CANCELLED' && (isCheque ? row.pdc_status === 'CLEARED' : row.status === 'COMPLETED')
  };
}

function summarisePayments(rows) {
  const t = {
    count: rows.length, total: 0, settled: 0, pdc_pending: 0,
    advance_unallocated: 0, cash: 0, bank_transfer: 0, cheque: 0
  };
  for (const r of rows) {
    if (r.status === 'CANCELLED') continue;
    t.total += money(r.amount);
    if (r.settled) t.settled += money(r.amount);
    if (r.pdc_pending) t.pdc_pending += money(r.amount);
    if (r.is_advance && r.settled) t.advance_unallocated += money(r.unallocated_amount);
    if (r.mode === 'CASH') t.cash += money(r.amount);
    if (r.mode === 'BANK_TRANSFER' || r.mode === 'ONLINE') t.bank_transfer += money(r.amount);
    if (r.is_cheque) t.cheque += money(r.amount);
  }
  Object.keys(t).forEach((k) => { if (k !== 'count') t[k] = money(t[k]); });
  return t;
}

module.exports = router;
module.exports.MODES = MODES;
module.exports.PDC_STATUSES = PDC_STATUSES;
