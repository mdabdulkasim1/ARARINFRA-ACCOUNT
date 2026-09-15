'use strict';

const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess } = require('../auth');
const {
  text, bool, money, toDate, today, badRequest, notFound, parseAmount, computeDueDate, isBlank
} = require('../util');
const { INVOICE_SELECT, enrichInvoice, refreshInvoiceStatus } = require('../queries');

const router = express.Router();
router.use(requireAuth);

/**
 * List supplier invoices.
 * Filters: company_id, supplier_id, status, view (overdue | due_soon | open | all),
 *          from, to (on submitted date), q (invoice number / description / supplier).
 */
router.get('/', requirePermission('invoice.view'), (req, res, next) => {
  try {
    const where = [];
    const params = [];

    where.push(`i.company_id IN (${req.companyIds.map(() => '?').join(',') || '-1'})`);
    params.push(...req.companyIds);

    if (req.query.company_id) {
      where.push('i.company_id = ?');
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    if (req.query.supplier_id) {
      where.push('i.supplier_id = ?');
      params.push(Number(req.query.supplier_id));
    }
    if (req.query.status) {
      where.push('i.status = ?');
      params.push(String(req.query.status).toUpperCase());
    }
    if (req.query.category_id) {
      where.push('i.category_id = ?');
      params.push(Number(req.query.category_id));
    }
    if (req.query.from) {
      where.push('COALESCE(i.submitted_date, i.invoice_date) >= ?');
      params.push(toDate(req.query.from));
    }
    if (req.query.to) {
      where.push('COALESCE(i.submitted_date, i.invoice_date) <= ?');
      params.push(toDate(req.query.to));
    }
    const q = text(req.query.q);
    if (q) {
      where.push(`(i.invoice_no LIKE '%' || ? || '%' OR i.description LIKE '%' || ? || '%'
                   OR s.name LIKE '%' || ? || '%' OR i.lpo_no LIKE '%' || ? || '%'
                   OR i.project_ref LIKE '%' || ? || '%')`);
      params.push(q, q, q, q, q);
    }

    const sql = `${INVOICE_SELECT} WHERE ${where.join(' AND ')} ORDER BY
                   CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date ASC, i.id DESC`;
    let rows = db.prepare(sql).all(...params).map((r) => enrichInvoice(r));

    const view = String(req.query.view || 'all').toLowerCase();
    if (view === 'overdue') rows = rows.filter((r) => r.is_overdue);
    else if (view === 'due_soon') rows = rows.filter((r) => r.is_due_soon);
    else if (view === 'open') rows = rows.filter((r) => r.is_open);
    else if (view === 'unsubmitted') rows = rows.filter((r) => !r.is_submitted && r.status !== 'CANCELLED');

    res.json({
      rows,
      totals: summarise(rows)
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('invoice.view'), (req, res, next) => {
  try {
    const row = db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(req.params.id);
    if (!row) throw notFound('Invoice not found');
    assertCompanyAccess(req, row.company_id);
    const payments = db
      .prepare(
        `SELECT a.amount AS allocated, p.*
           FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
          WHERE a.invoice_id = ? ORDER BY p.payment_date, p.id`
      )
      .all(row.id);
    res.json({ ...enrichInvoice(row), payments });
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission('invoice.create'), (req, res, next) => {
  try {
    const data = readInvoice(req);
    const info = db
      .prepare(
        `INSERT INTO purchase_invoices
           (company_id, supplier_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
            due_date, currency, subtotal, tax_amount, total_amount, category_id, project_ref,
            lpo_no, description, status, created_by, updated_by)
         VALUES (@company_id, @supplier_id, @invoice_no, @invoice_date, @submitted_date,
                 @payment_terms_days, @due_date, @currency, @subtotal, @tax_amount, @total_amount,
                 @category_id, @project_ref, @lpo_no, @description, 'OPEN', @user, @user)`
      )
      .run({ ...data, user: req.user.id });
    audit(req, {
      action: 'CREATE', entity: 'purchase_invoice', entity_id: info.lastInsertRowid,
      summary: `Supplier invoice ${data.invoice_no} for ${money(data.total_amount)} ${data.currency}`,
      details: data
    });
    res.status(201).json(
      enrichInvoice(db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(info.lastInsertRowid))
    );
  } catch (err) {
    next(dbError(err));
  }
});

router.put('/:id', requirePermission('invoice.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Invoice not found');
    assertCompanyAccess(req, existing.company_id);

    const data = readInvoice(req, existing);

    // The invoice must still cover whatever has already been paid against it.
    const paid = db
      .prepare('SELECT IFNULL(SUM(amount), 0) a FROM payment_allocations WHERE invoice_id = ?')
      .get(existing.id).a;
    if (money(data.total_amount) < money(paid) - 0.005) {
      throw badRequest(
        `The invoice total cannot be less than the ${money(paid)} already allocated against it`
      );
    }

    db.prepare(
      `UPDATE purchase_invoices SET
         company_id = @company_id, supplier_id = @supplier_id, invoice_no = @invoice_no,
         invoice_date = @invoice_date, submitted_date = @submitted_date,
         payment_terms_days = @payment_terms_days, due_date = @due_date, currency = @currency,
         subtotal = @subtotal, tax_amount = @tax_amount, total_amount = @total_amount,
         category_id = @category_id, project_ref = @project_ref, lpo_no = @lpo_no,
         description = @description, updated_by = @user, updated_at = datetime('now')
       WHERE id = @id`
    ).run({ ...data, id: existing.id, user: req.user.id });

    refreshInvoiceStatus(existing.id);
    audit(req, {
      action: 'UPDATE', entity: 'purchase_invoice', entity_id: existing.id,
      summary: `Edited supplier invoice ${data.invoice_no}`, details: data
    });
    res.json(enrichInvoice(db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(existing.id)));
  } catch (err) {
    next(dbError(err));
  }
});

/** Put an invoice on hold, or take it off hold. Disputed bills stay out of the due list. */
router.post('/:id/hold', requirePermission('invoice.hold'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Invoice not found');
    assertCompanyAccess(req, existing.company_id);
    const hold = bool(req.body.hold, true);
    if (hold) {
      db.prepare("UPDATE purchase_invoices SET status = 'ON_HOLD', hold_reason = ?, updated_at = datetime('now') WHERE id = ?")
        .run(text(req.body.reason), existing.id);
    } else {
      db.prepare("UPDATE purchase_invoices SET status = 'OPEN', hold_reason = NULL WHERE id = ?").run(existing.id);
      refreshInvoiceStatus(existing.id);
    }
    audit(req, {
      action: hold ? 'HOLD' : 'UNHOLD', entity: 'purchase_invoice', entity_id: existing.id,
      summary: `${hold ? 'Put on hold' : 'Released'} invoice ${existing.invoice_no}`,
      details: { reason: text(req.body.reason) }
    });
    res.json(enrichInvoice(db.prepare(`${INVOICE_SELECT} WHERE i.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('invoice.delete'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Invoice not found');
    assertCompanyAccess(req, existing.company_id);
    const allocations = db
      .prepare('SELECT COUNT(*) c FROM payment_allocations WHERE invoice_id = ?')
      .get(existing.id).c;
    if (allocations > 0) {
      // Keep the history. Cancelling leaves the trail intact for the auditors.
      db.prepare("UPDATE purchase_invoices SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?")
        .run(existing.id);
      audit(req, {
        action: 'CANCEL', entity: 'purchase_invoice', entity_id: existing.id,
        summary: `Cancelled invoice ${existing.invoice_no} (payments exist, record kept)`
      });
      return res.json({ ok: true, cancelled: true });
    }
    db.prepare('DELETE FROM purchase_invoices WHERE id = ?').run(existing.id);
    audit(req, {
      action: 'DELETE', entity: 'purchase_invoice', entity_id: existing.id,
      summary: `Deleted invoice ${existing.invoice_no}`, details: existing
    });
    res.json({ ok: true, cancelled: false });
  } catch (err) {
    next(err);
  }
});

/** Open invoices of one supplier, for the payment allocation picker. */
router.get('/open/for-supplier/:supplierId', requirePermission('invoice.view'), (req, res, next) => {
  try {
    const params = [Number(req.params.supplierId)];
    let extra = '';
    if (req.query.company_id) {
      extra = ' AND i.company_id = ?';
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    const rows = db
      .prepare(
        `${INVOICE_SELECT}
          WHERE i.supplier_id = ? ${extra}
            AND i.status NOT IN ('CANCELLED')
            AND (i.total_amount - IFNULL(paid.amt, 0)) > 0.005
          ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date, i.id`
      )
      .all(...params)
      .map((r) => enrichInvoice(r));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ helpers

function readInvoice(req, existing) {
  const b = req.body;
  const companyId = assertCompanyAccess(req, b.company_id ?? (existing && existing.company_id));
  const supplierId = Number(b.supplier_id ?? (existing && existing.supplier_id));
  if (!supplierId) throw badRequest('Choose a supplier');

  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) throw badRequest('That supplier no longer exists');

  const invoiceNo = text(b.invoice_no ?? (existing && existing.invoice_no));
  if (!invoiceNo) throw badRequest("Enter the supplier's invoice reference number");

  const invoiceDate = toDate(b.invoice_date ?? (existing && existing.invoice_date));
  if (!invoiceDate) throw badRequest('Enter the invoice date');

  const submittedDate = b.submitted_date === undefined
    ? (existing ? existing.submitted_date : null)
    : toDate(b.submitted_date);

  if (submittedDate && submittedDate < invoiceDate) {
    throw badRequest('The submitted date cannot be before the invoice date');
  }

  const terms = Number(
    b.payment_terms_days ?? (existing ? existing.payment_terms_days : supplier.payment_terms_days)
  );
  if (!Number.isFinite(terms) || terms < 0 || terms > 1095) {
    throw badRequest('Payment terms must be between 0 and 1095 days');
  }

  const subtotal = parseAmount(b.subtotal ?? (existing ? existing.subtotal : 0), 'Amount');
  const tax = parseAmount(b.tax_amount ?? (existing ? existing.tax_amount : 0), 'VAT amount');
  const total = b.total_amount !== undefined && b.total_amount !== null && b.total_amount !== ''
    ? parseAmount(b.total_amount, 'Total')
    : money(subtotal + tax);
  if (total <= 0) throw badRequest('The invoice total must be more than zero');

  return {
    company_id: companyId,
    supplier_id: supplierId,
    invoice_no: invoiceNo,
    invoice_date: invoiceDate,
    submitted_date: submittedDate,
    payment_terms_days: terms,
    due_date: submittedDate
      ? computeDueDate({ submitted_date: submittedDate, invoice_date: invoiceDate, payment_terms_days: terms })
      : null,
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

function summarise(rows) {
  const t = {
    count: rows.length,
    total: 0, paid: 0, pdc: 0, outstanding: 0, net_payable: 0,
    overdue_count: 0, overdue_amount: 0,
    due_soon_count: 0, due_soon_amount: 0,
    unsubmitted_count: 0, unsubmitted_amount: 0
  };
  for (const r of rows) {
    if (r.status === 'CANCELLED') continue;
    t.total += money(r.total_amount);
    t.paid += money(r.paid_amount);
    t.pdc += money(r.pdc_amount);
    t.outstanding += money(r.outstanding);
    t.net_payable += money(r.net_payable);
    if (r.is_overdue) {
      t.overdue_count += 1;
      t.overdue_amount += money(r.outstanding);
    }
    if (r.is_due_soon) {
      t.due_soon_count += 1;
      t.due_soon_amount += money(r.outstanding);
    }
    if (!r.is_submitted && r.is_open) {
      t.unsubmitted_count += 1;
      t.unsubmitted_amount += money(r.outstanding);
    }
  }
  Object.keys(t).forEach((k) => { t[k] = k.endsWith('count') ? t[k] : money(t[k]); });
  return t;
}

/** Turn SQLite constraint noise into something an accountant can act on. */
function dbError(err) {
  if (err && /UNIQUE constraint failed: purchase_invoices/.test(err.message)) {
    return badRequest('This invoice number is already recorded for that supplier in this company');
  }
  return err;
}

module.exports = router;
module.exports.summarise = summarise;
