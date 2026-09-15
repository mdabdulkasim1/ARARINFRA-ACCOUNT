'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess } = require('../auth');
const {
  money, today, addDays, toDate, notFound, text, monthRange,
  AGEING_BUCKETS, AGEING_LABELS, SQL_SETTLED, SQL_PDC_OUTSTANDING
} = require('../util');
const { INVOICE_SELECT, PAYMENT_SELECT, enrichInvoice } = require('../queries');

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission('report.view'));

/** The companies this request covers - all of the user's, or the one they picked. */
function scope(req) {
  if (req.query.company_id) return [assertCompanyAccess(req, req.query.company_id)];
  return req.companyIds.length ? req.companyIds : [-1];
}

function inList(ids) {
  return ids.map(() => '?').join(',') || '-1';
}

/** Every open supplier invoice in scope, already enriched with ageing. */
function openInvoices(ids, asOf) {
  return db
    .prepare(
      `${INVOICE_SELECT}
        WHERE i.company_id IN (${inList(ids)})
          AND i.status <> 'CANCELLED'
          AND (i.total_amount - IFNULL(paid.amt, 0)) > 0.005
        ORDER BY CASE WHEN i.due_date IS NULL THEN 1 ELSE 0 END, i.due_date`
    )
    .all(...ids)
    .map((r) => enrichInvoice(r, asOf));
}

// ------------------------------------------------------------------ dashboard

router.get('/dashboard', (req, res, next) => {
  try {
    const ids = scope(req);
    const asOf = toDate(req.query.as_of) || today();
    const invoices = openInvoices(ids, asOf);

    const kpi = {
      payable_total: 0,          // what suppliers are still owed
      pdc_issued: 0,             // cheques handed over, not yet cleared
      net_payable: 0,            // still to be arranged, after the cheques out there
      overdue_amount: 0,
      overdue_count: 0,
      due_7_amount: 0,
      due_7_count: 0,
      due_30_amount: 0,
      due_30_count: 0,
      not_submitted_amount: 0,
      not_submitted_count: 0,
      open_invoice_count: invoices.length,
      supplier_count: new Set(invoices.map((i) => i.supplier_id)).size
    };

    const in7 = addDays(asOf, 7);
    const in30 = addDays(asOf, 30);

    for (const inv of invoices) {
      kpi.payable_total = money(kpi.payable_total + inv.outstanding);
      kpi.pdc_issued = money(kpi.pdc_issued + inv.pdc_amount);
      if (inv.is_overdue) {
        kpi.overdue_amount = money(kpi.overdue_amount + inv.outstanding);
        kpi.overdue_count += 1;
      } else if (inv.due_date) {
        if (inv.due_date <= in7) {
          kpi.due_7_amount = money(kpi.due_7_amount + inv.outstanding);
          kpi.due_7_count += 1;
        }
        if (inv.due_date <= in30) {
          kpi.due_30_amount = money(kpi.due_30_amount + inv.outstanding);
          kpi.due_30_count += 1;
        }
      }
      if (!inv.is_submitted) {
        kpi.not_submitted_amount = money(kpi.not_submitted_amount + inv.outstanding);
        kpi.not_submitted_count += 1;
      }
    }
    kpi.net_payable = money(kpi.payable_total - kpi.pdc_issued);

    // Cheques written but not yet cleared, counted on their own - some are for
    // advances and never touch an invoice, so this is not the same as the figure above.
    const pdcTotals = db
      .prepare(
        `SELECT COUNT(*) AS cnt, ROUND(IFNULL(SUM(p.amount), 0), 2) AS amt
           FROM payments p WHERE p.company_id IN (${inList(ids)}) AND ${SQL_PDC_OUTSTANDING}`
      )
      .get(...ids);
    kpi.pdc_outstanding_total = money(pdcTotals.amt);
    kpi.pdc_outstanding_count = pdcTotals.cnt;

    const pdcNext30 = db
      .prepare(
        `SELECT COUNT(*) AS cnt, ROUND(IFNULL(SUM(p.amount), 0), 2) AS amt
           FROM payments p
          WHERE p.company_id IN (${inList(ids)}) AND ${SQL_PDC_OUTSTANDING}
            AND p.cheque_date <= ?`
      )
      .get(...ids, in30);
    kpi.pdc_due_30_amount = money(pdcNext30.amt);
    kpi.pdc_due_30_count = pdcNext30.cnt;

    const pdcOverdue = db
      .prepare(
        `SELECT COUNT(*) AS cnt, ROUND(IFNULL(SUM(p.amount), 0), 2) AS amt
           FROM payments p
          WHERE p.company_id IN (${inList(ids)}) AND ${SQL_PDC_OUTSTANDING} AND p.cheque_date < ?`
      )
      .get(...ids, asOf);
    kpi.pdc_past_date_amount = money(pdcOverdue.amt);
    kpi.pdc_past_date_count = pdcOverdue.cnt;

    // Advances paid that are not set against any invoice yet.
    const adv = db
      .prepare(
        `SELECT ROUND(IFNULL(SUM(p.amount - IFNULL(al.amt, 0)), 0), 2) AS amt, COUNT(*) AS cnt
           FROM payments p
           LEFT JOIN (SELECT payment_id, SUM(amount) amt FROM payment_allocations GROUP BY payment_id) al
                  ON al.payment_id = p.id
          WHERE p.company_id IN (${inList(ids)}) AND ${SQL_SETTLED}
            AND (p.amount - IFNULL(al.amt, 0)) > 0.005`
      )
      .get(...ids);
    kpi.advance_unallocated = money(adv.amt);
    kpi.advance_count = adv.cnt;

    // Petty cash waiting for the owner.
    const petty = db
      .prepare(
        `SELECT status, COUNT(*) AS cnt, ROUND(IFNULL(SUM(amount), 0), 2) AS amt
           FROM petty_cash_requests WHERE company_id IN (${inList(ids)})
            AND status IN ('PENDING','VERIFIED','APPROVED')
          GROUP BY status`
      )
      .all(...ids);
    kpi.petty_awaiting_approval_count = petty
      .filter((p) => p.status === 'PENDING' || p.status === 'VERIFIED')
      .reduce((s, p) => s + p.cnt, 0);
    kpi.petty_awaiting_approval_amount = money(
      petty.filter((p) => p.status === 'PENDING' || p.status === 'VERIFIED')
        .reduce((s, p) => s + p.amt, 0)
    );
    const approvedUnpaid = petty.find((p) => p.status === 'APPROVED');
    kpi.petty_approved_unpaid_count = approvedUnpaid ? approvedUnpaid.cnt : 0;
    kpi.petty_approved_unpaid_amount = money(approvedUnpaid ? approvedUnpaid.amt : 0);

    // The income side, kept short.
    const recv = db
      .prepare(
        `SELECT ROUND(IFNULL(SUM(i.total_amount - IFNULL(rec.amt, 0)), 0), 2) AS amt, COUNT(*) AS cnt
           FROM sales_invoices i
           LEFT JOIN (
             SELECT a.invoice_id, SUM(a.amount) amt FROM receipt_allocations a
               JOIN receipts p ON p.id = a.receipt_id WHERE ${SQL_SETTLED} GROUP BY a.invoice_id
           ) rec ON rec.invoice_id = i.id
          WHERE i.company_id IN (${inList(ids)}) AND i.status <> 'CANCELLED'
            AND (i.total_amount - IFNULL(rec.amt, 0)) > 0.005`
      )
      .get(...ids);
    kpi.receivable_total = money(recv.amt);
    kpi.receivable_count = recv.cnt;

    // Ageing of what is owed.
    const ageing = {};
    AGEING_BUCKETS.forEach((b) => { ageing[b] = { bucket: b, label: AGEING_LABELS[b], amount: 0, count: 0 }; });
    invoices.forEach((inv) => {
      const b = ageing[inv.ageing_bucket] || ageing.NOT_DUE;
      b.amount = money(b.amount + inv.outstanding);
      b.count += 1;
    });

    // Company by company, so the owner can see where the pressure is.
    const byCompany = db
      .prepare(`SELECT id, code, name, currency FROM companies WHERE id IN (${inList(ids)}) ORDER BY name`)
      .all(...ids)
      .map((c) => {
        const own = invoices.filter((i) => i.company_id === c.id);
        const payable = money(own.reduce((s, i) => s + i.outstanding, 0));
        const pdc = money(
          db.prepare(
            `SELECT ROUND(IFNULL(SUM(p.amount), 0), 2) a FROM payments p
              WHERE p.company_id = ? AND ${SQL_PDC_OUTSTANDING}`
          ).get(c.id).a
        );
        return {
          ...c,
          payable,
          pdc_issued: pdc,
          net_payable: money(payable - pdc),
          overdue: money(own.filter((i) => i.is_overdue).reduce((s, i) => s + i.outstanding, 0)),
          overdue_count: own.filter((i) => i.is_overdue).length,
          open_invoices: own.length
        };
      });

    // Who we owe the most to.
    const bySupplier = Object.values(
      invoices.reduce((acc, i) => {
        const k = i.supplier_id;
        acc[k] = acc[k] || {
          supplier_id: k, supplier_name: i.supplier_name, supplier_code: i.supplier_code,
          outstanding: 0, pdc: 0, overdue: 0, overdue_count: 0, invoices: 0
        };
        acc[k].outstanding = money(acc[k].outstanding + i.outstanding);
        acc[k].pdc = money(acc[k].pdc + i.pdc_amount);
        acc[k].invoices += 1;
        if (i.is_overdue) {
          acc[k].overdue = money(acc[k].overdue + i.outstanding);
          acc[k].overdue_count += 1;
        }
        return acc;
      }, {})
    )
      .map((s) => ({ ...s, net_payable: money(s.outstanding - s.pdc) }))
      .sort((a, b) => b.outstanding - a.outstanding);

    // The cheque load month by month, on the date written on the cheque. This is
    // the same money as the PDC issued figure above, split by when it lands, so
    // the months always add back up to it.
    const pdcByMonth = db
      .prepare(
        `SELECT substr(p.cheque_date, 1, 7) AS month,
                COUNT(*) AS count,
                ROUND(IFNULL(SUM(p.amount), 0), 2) AS amount
           FROM payments p
          WHERE p.company_id IN (${inList(ids)}) AND ${SQL_PDC_OUTSTANDING}
            AND p.cheque_date IS NOT NULL
          GROUP BY month
          ORDER BY month`
      )
      .all(...ids)
      .map((r) => ({ ...r, amount: money(r.amount), is_past: r.month < asOf.slice(0, 7) }));

    // The same cheques again, this time by who holds them, so the owner can see
    // which supplier is sitting on the most of the group's paper.
    const pdcBySupplier = db
      .prepare(
        `SELECT s.id   AS supplier_id,
                s.name AS supplier_name,
                s.code AS supplier_code,
                COUNT(*) AS count,
                ROUND(IFNULL(SUM(p.amount), 0), 2) AS amount,
                MIN(p.cheque_date) AS first_cheque_date,
                MAX(p.cheque_date) AS last_cheque_date
           FROM payments p
           JOIN suppliers s ON s.id = p.supplier_id
          WHERE p.company_id IN (${inList(ids)}) AND ${SQL_PDC_OUTSTANDING}
          GROUP BY s.id
          ORDER BY amount DESC`
      )
      .all(...ids)
      .map((r) => ({ ...r, amount: money(r.amount) }));

    // Cheques coming up, so nothing is presented against an empty account.
    const upcomingPdc = db
      .prepare(
        `${PAYMENT_SELECT}
          WHERE p.company_id IN (${inList(ids)}) AND ${SQL_PDC_OUTSTANDING}
          ORDER BY p.cheque_date ASC LIMIT 25`
      )
      .all(...ids);

    res.json({
      as_of: asOf,
      currency: byCompany[0] ? byCompany[0].currency : (process.env.DEFAULT_CURRENCY || 'AED'),
      kpi,
      ageing: AGEING_BUCKETS.map((b) => ageing[b]).filter((b) => b.count > 0 || b.bucket !== 'NO_DUE_DATE'),
      by_company: byCompany,
      top_suppliers: bySupplier.slice(0, 10),
      overdue_invoices: invoices.filter((i) => i.is_overdue).slice(0, 25),
      upcoming_pdc: upcomingPdc,
      pdc_by_month: pdcByMonth,
      pdc_by_supplier: pdcBySupplier,
      monthly_cash_out: monthlyCashOut(ids, 6),
      monthly_income: monthlyIncome(ids, 6)
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ supplier ageing

router.get('/supplier-ageing', (req, res, next) => {
  try {
    const ids = scope(req);
    const asOf = toDate(req.query.as_of) || today();
    const invoices = openInvoices(ids, asOf);

    const bySupplier = {};
    for (const inv of invoices) {
      const k = inv.supplier_id;
      if (!bySupplier[k]) {
        bySupplier[k] = {
          supplier_id: k, supplier_code: inv.supplier_code, supplier_name: inv.supplier_name,
          total: 0, pdc: 0, net_payable: 0, invoices: 0,
          NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0, NO_DUE_DATE: 0,
          // How many invoices sit in each bucket, so a bucket can be opened on
          // its own and still say how many bills make up the figure.
          counts: { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0, NO_DUE_DATE: 0 },
          // The date the bucket's earliest bill fell due, so a list of one bucket
          // can show how long the worst of it has been waiting.
          oldest: { NOT_DUE: null, D1_30: null, D31_60: null, D61_90: null, D90_PLUS: null, NO_DUE_DATE: null }
        };
      }
      const s = bySupplier[k];
      s.total = money(s.total + inv.outstanding);
      s.pdc = money(s.pdc + inv.pdc_amount);
      s.net_payable = money(s.total - s.pdc);
      s.invoices += 1;
      s[inv.ageing_bucket] = money(s[inv.ageing_bucket] + inv.outstanding);
      s.counts[inv.ageing_bucket] += 1;
      const oldest = s.oldest[inv.ageing_bucket];
      if (inv.due_date && (!oldest || inv.due_date < oldest)) {
        s.oldest[inv.ageing_bucket] = inv.due_date;
      }
    }

    const rows = Object.values(bySupplier).sort((a, b) => b.total - a.total);
    const totals = rows.reduce(
      (t, r) => {
        ['total', 'pdc', 'net_payable', 'NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS', 'NO_DUE_DATE']
          .forEach((k) => { t[k] = money(t[k] + r[k]); });
        t.invoices += r.invoices;
        return t;
      },
      { total: 0, pdc: 0, net_payable: 0, NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0, NO_DUE_DATE: 0, invoices: 0 }
    );

    res.json({ as_of: asOf, rows, totals, labels: AGEING_LABELS });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ PDC register

router.get('/pdc-register', (req, res, next) => {
  try {
    const ids = scope(req);
    const where = [`p.company_id IN (${inList(ids)})`, "p.mode IN ('PDC','CHEQUE')", "p.status <> 'CANCELLED'"];
    const params = [...ids];

    const status = text(req.query.pdc_status);
    if (status) {
      where.push('p.pdc_status = ?');
      params.push(status.toUpperCase());
    } else {
      where.push("p.pdc_status IN ('ISSUED','PRESENTED')");
    }
    if (req.query.from) {
      where.push('p.cheque_date >= ?');
      params.push(toDate(req.query.from));
    }
    if (req.query.to) {
      where.push('p.cheque_date <= ?');
      params.push(toDate(req.query.to));
    }

    const rows = db
      .prepare(`${PAYMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.cheque_date ASC, p.id ASC`)
      .all(...params);

    // Group by month so the owner sees the cheque load ahead.
    const byMonth = {};
    rows.forEach((r) => {
      const m = (r.cheque_date || '0000-00').slice(0, 7);
      byMonth[m] = byMonth[m] || { month: m, count: 0, amount: 0 };
      byMonth[m].count += 1;
      byMonth[m].amount = money(byMonth[m].amount + r.amount);
    });

    // Who is holding the cheques.
    const bySupplier = {};
    rows.forEach((r) => {
      const k = r.supplier_id;
      bySupplier[k] = bySupplier[k] || {
        supplier_id: k, supplier_name: r.supplier_name, supplier_code: r.supplier_code,
        count: 0, amount: 0, first_cheque_date: null, last_cheque_date: null
      };
      const b = bySupplier[k];
      b.count += 1;
      b.amount = money(b.amount + r.amount);
      if (r.cheque_date) {
        if (!b.first_cheque_date || r.cheque_date < b.first_cheque_date) b.first_cheque_date = r.cheque_date;
        if (!b.last_cheque_date || r.cheque_date > b.last_cheque_date) b.last_cheque_date = r.cheque_date;
      }
    });

    // Which of our own banks the cheques are drawn on.
    const byBank = {};
    rows.forEach((r) => {
      const b = r.cheque_bank_name || r.from_bank_name || 'Not recorded';
      byBank[b] = byBank[b] || { bank: b, count: 0, amount: 0 };
      byBank[b].count += 1;
      byBank[b].amount = money(byBank[b].amount + r.amount);
    });

    res.json({
      rows,
      total: money(rows.reduce((s, r) => s + r.amount, 0)),
      count: rows.length,
      by_month: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
      by_supplier: Object.values(bySupplier).sort((a, b) => b.amount - a.amount),
      by_bank: Object.values(byBank).sort((a, b) => b.amount - a.amount)
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ supplier statement

router.get('/supplier-statement/:supplierId', (req, res, next) => {
  try {
    const ids = scope(req);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.supplierId);
    if (!supplier) throw notFound('Supplier not found');

    const invoices = db
      .prepare(
        `${INVOICE_SELECT} WHERE i.supplier_id = ? AND i.company_id IN (${inList(ids)})
          ORDER BY i.invoice_date, i.id`
      )
      .all(supplier.id, ...ids)
      .map((r) => enrichInvoice(r));

    const payments = db
      .prepare(
        `${PAYMENT_SELECT} WHERE p.supplier_id = ? AND p.company_id IN (${inList(ids)})
          ORDER BY p.payment_date, p.id`
      )
      .all(supplier.id, ...ids);

    const invoiced = money(invoices.filter((i) => i.status !== 'CANCELLED')
      .reduce((s, i) => s + i.total_amount, 0));
    const settled = money(payments.filter((p) =>
      p.status !== 'CANCELLED' &&
      (['PDC', 'CHEQUE'].includes(p.mode) ? p.pdc_status === 'CLEARED' : p.status === 'COMPLETED')
    ).reduce((s, p) => s + p.amount, 0));
    const pdcPending = money(payments.filter((p) =>
      p.status !== 'CANCELLED' && ['PDC', 'CHEQUE'].includes(p.mode) &&
      ['ISSUED', 'PRESENTED'].includes(p.pdc_status)
    ).reduce((s, p) => s + p.amount, 0));
    const outstanding = money(invoices.filter((i) => i.status !== 'CANCELLED')
      .reduce((s, i) => s + i.outstanding, 0));

    res.json({
      supplier,
      invoices,
      payments,
      summary: {
        invoiced,
        settled,
        pdc_pending: pdcPending,
        outstanding,
        net_payable: money(outstanding - pdcPending),
        overdue: money(invoices.filter((i) => i.is_overdue).reduce((s, i) => s + i.outstanding, 0)),
        overdue_count: invoices.filter((i) => i.is_overdue).length,
        unallocated_advance: money(payments
          .filter((p) => p.status !== 'CANCELLED' && p.unallocated_amount > 0.005)
          .reduce((s, p) => s + p.unallocated_amount, 0))
      }
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ cash out register

router.get('/cash-out', (req, res, next) => {
  try {
    const ids = scope(req);
    const from = toDate(req.query.from) || addDays(today(), -30);
    const to = toDate(req.query.to) || today();

    const rows = db
      .prepare(
        `${PAYMENT_SELECT}
          WHERE p.company_id IN (${inList(ids)}) AND p.status <> 'CANCELLED'
            AND p.payment_date BETWEEN ? AND ?
          ORDER BY p.payment_date DESC, p.id DESC`
      )
      .all(...ids, from, to);

    const byMode = {};
    rows.forEach((r) => {
      byMode[r.mode] = byMode[r.mode] || { mode: r.mode, count: 0, amount: 0, settled: 0 };
      byMode[r.mode].count += 1;
      byMode[r.mode].amount = money(byMode[r.mode].amount + r.amount);
      const settled = ['PDC', 'CHEQUE'].includes(r.mode) ? r.pdc_status === 'CLEARED' : r.status === 'COMPLETED';
      if (settled) byMode[r.mode].settled = money(byMode[r.mode].settled + r.amount);
    });

    const petty = db
      .prepare(
        `SELECT ROUND(IFNULL(SUM(amount), 0), 2) amt, COUNT(*) cnt
           FROM petty_cash_requests
          WHERE company_id IN (${inList(ids)}) AND status = 'PAID' AND paid_date BETWEEN ? AND ?`
      )
      .get(...ids, from, to);

    res.json({
      from,
      to,
      rows,
      by_mode: Object.values(byMode).sort((a, b) => b.amount - a.amount),
      total: money(rows.reduce((s, r) => s + r.amount, 0)),
      petty_cash_paid: money(petty.amt),
      petty_cash_count: petty.cnt
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ petty cash summary

router.get('/petty-cash-summary', (req, res, next) => {
  try {
    const ids = scope(req);
    const from = toDate(req.query.from) || `${today().slice(0, 4)}-01-01`;
    const to = toDate(req.query.to) || today();

    const byEmployee = db
      .prepare(
        `SELECT e.id AS employee_id, e.code AS employee_code, e.name AS employee_name,
                e.department, COUNT(*) AS requests,
                ROUND(IFNULL(SUM(r.amount), 0), 2) AS requested,
                ROUND(IFNULL(SUM(CASE WHEN r.status = 'PAID' THEN r.amount END), 0), 2) AS paid,
                ROUND(IFNULL(SUM(CASE WHEN r.status IN ('PENDING','VERIFIED') THEN r.amount END), 0), 2) AS awaiting,
                ROUND(IFNULL(SUM(CASE WHEN r.status = 'APPROVED' THEN r.amount END), 0), 2) AS approved_unpaid,
                SUM(CASE WHEN r.status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected
           FROM petty_cash_requests r JOIN employees e ON e.id = r.employee_id
          WHERE r.company_id IN (${inList(ids)}) AND r.request_date BETWEEN ? AND ?
            AND r.status <> 'CANCELLED'
          GROUP BY e.id ORDER BY paid DESC, requested DESC`
      )
      .all(...ids, from, to);

    const byCategory = db
      .prepare(
        `SELECT IFNULL(c.name, 'Uncategorised') AS category, COUNT(*) AS requests,
                ROUND(IFNULL(SUM(r.amount), 0), 2) AS amount
           FROM petty_cash_requests r LEFT JOIN categories c ON c.id = r.category_id
          WHERE r.company_id IN (${inList(ids)}) AND r.request_date BETWEEN ? AND ?
            AND r.status = 'PAID'
          GROUP BY c.name ORDER BY amount DESC`
      )
      .all(...ids, from, to);

    const byMonth = db
      .prepare(
        `SELECT substr(r.request_date, 1, 7) AS month, COUNT(*) AS requests,
                ROUND(IFNULL(SUM(CASE WHEN r.status = 'PAID' THEN r.amount END), 0), 2) AS paid
           FROM petty_cash_requests r
          WHERE r.company_id IN (${inList(ids)}) AND r.request_date BETWEEN ? AND ?
            AND r.status <> 'CANCELLED'
          GROUP BY month ORDER BY month`
      )
      .all(...ids, from, to);

    res.json({ from, to, by_employee: byEmployee, by_category: byCategory, by_month: byMonth });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ group summary

router.get('/group-summary', requirePermission('report.group'), (req, res, next) => {
  try {
    const ids = scope(req);
    const asOf = toDate(req.query.as_of) || today();
    const invoices = openInvoices(ids, asOf);
    const year = req.query.year ? String(req.query.year) : today().slice(0, 4);

    const rows = db
      .prepare(`SELECT id, code, name, currency FROM companies WHERE id IN (${inList(ids)}) ORDER BY name`)
      .all(...ids)
      .map((c) => {
        const own = invoices.filter((i) => i.company_id === c.id);
        const payable = money(own.reduce((s, i) => s + i.outstanding, 0));
        const pdc = money(db.prepare(
          `SELECT ROUND(IFNULL(SUM(p.amount), 0), 2) a FROM payments p
            WHERE p.company_id = ? AND ${SQL_PDC_OUTSTANDING}`
        ).get(c.id).a);
        const spendYtd = money(db.prepare(
          `SELECT ROUND(IFNULL(SUM(p.amount), 0), 2) a FROM payments p
            WHERE p.company_id = ? AND p.status <> 'CANCELLED' AND substr(p.payment_date, 1, 4) = ?`
        ).get(c.id, year).a);
        const incomeYtd = money(db.prepare(
          `SELECT ROUND(IFNULL(SUM(r.amount), 0), 2) a FROM receipts r
            WHERE r.company_id = ? AND r.status <> 'CANCELLED' AND substr(r.receipt_date, 1, 4) = ?`
        ).get(c.id, year).a);
        const pettyYtd = money(db.prepare(
          `SELECT ROUND(IFNULL(SUM(amount), 0), 2) a FROM petty_cash_requests
            WHERE company_id = ? AND status = 'PAID' AND substr(paid_date, 1, 4) = ?`
        ).get(c.id, year).a);
        const receivable = money(db.prepare(
          `SELECT ROUND(IFNULL(SUM(i.total_amount - IFNULL(rec.amt, 0)), 0), 2) a
             FROM sales_invoices i
             LEFT JOIN (SELECT a.invoice_id, SUM(a.amount) amt FROM receipt_allocations a
                          JOIN receipts p ON p.id = a.receipt_id WHERE ${SQL_SETTLED}
                         GROUP BY a.invoice_id) rec ON rec.invoice_id = i.id
            WHERE i.company_id = ? AND i.status <> 'CANCELLED'
              AND (i.total_amount - IFNULL(rec.amt, 0)) > 0.005`
        ).get(c.id).a);

        return {
          ...c,
          payable,
          pdc_issued: pdc,
          net_payable: money(payable - pdc),
          overdue: money(own.filter((i) => i.is_overdue).reduce((s, i) => s + i.outstanding, 0)),
          overdue_count: own.filter((i) => i.is_overdue).length,
          open_invoices: own.length,
          receivable,
          spend_ytd: spendYtd,
          income_ytd: incomeYtd,
          petty_ytd: pettyYtd
        };
      });

    const totals = rows.reduce((t, r) => {
      ['payable', 'pdc_issued', 'net_payable', 'overdue', 'receivable', 'spend_ytd', 'income_ytd', 'petty_ytd']
        .forEach((k) => { t[k] = money(t[k] + r[k]); });
      t.overdue_count += r.overdue_count;
      t.open_invoices += r.open_invoices;
      return t;
    }, {
      payable: 0, pdc_issued: 0, net_payable: 0, overdue: 0, receivable: 0,
      spend_ytd: 0, income_ytd: 0, petty_ytd: 0, overdue_count: 0, open_invoices: 0
    });

    res.json({ as_of: asOf, year, rows, totals });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ what falls due in a month

/**
 * Everything the group has to pay in one month, in one place: supplier invoices
 * reaching their due date, cheques dated that month, settlement cheques, bank
 * instalments on the vehicle and equipment loans, and any LC maturing.
 *
 * This is the "how much do I need this month" answer, which otherwise means
 * looking in four different places.
 */
router.get('/monthly-commitments', (req, res, next) => {
  try {
    const ids = scope(req);
    const { month, from, to } = monthRange(req.query.month);
    const list = inList(ids);

    // Supplier invoices reaching their due date this month and still owed.
    const invoices = db
      .prepare(
        `${INVOICE_SELECT}
          WHERE i.company_id IN (${list})
            AND i.status NOT IN ('CANCELLED', 'ON_HOLD')
            AND i.due_date BETWEEN ? AND ?
            AND (i.total_amount - IFNULL(paid.amt, 0)) > 0.005
          ORDER BY i.due_date, s.name`
      )
      .all(...ids, from, to)
      .map((r) => enrichInvoice(r));

    // Cheques written against this month, split by where they have got to.
    const chequesIn = (statuses) => db
      .prepare(
        `${PAYMENT_SELECT}
          WHERE p.company_id IN (${list})
            AND p.mode IN ('PDC','CHEQUE')
            AND p.status <> 'CANCELLED'
            AND p.pdc_status IN (${statuses.map(() => '?').join(',')})
            AND p.cheque_date BETWEEN ? AND ?
          ORDER BY p.cheque_date, s.name`
      )
      .all(...ids, ...statuses, from, to);

    const pdc = chequesIn(['ISSUED', 'PRESENTED']);
    const stl = chequesIn(['SETTLED']);
    const clearedThisMonth = chequesIn(['CLEARED']);

    // Bank instalments and letters of credit falling due this month.
    const dues = db
      .prepare(
        `SELECT d.*, f.type, f.reference, f.vehicle_no, f.bank_name, f.description,
                c.code AS company_code, c.name AS company_name
           FROM facility_dues d
           JOIN bank_facilities f ON f.id = d.facility_id
           JOIN companies c ON c.id = d.company_id
          WHERE d.company_id IN (${list})
            AND d.status <> 'SKIPPED'
            AND d.due_date BETWEEN ? AND ?
          ORDER BY d.due_date, f.type, f.vehicle_no`
      )
      .all(...ids, from, to);

    const loanTypes = ['VEHICLE_LOAN', 'EQUIPMENT_LOAN', 'TERM_LOAN'];
    const emi = dues.filter((d) => loanTypes.includes(d.type));
    const lc = dues.filter((d) => !loanTypes.includes(d.type));

    // Petty cash the owner has approved but which has not been handed over yet.
    const petty = db
      .prepare(
        `SELECT r.*, e.name AS employee_name, c.code AS company_code
           FROM petty_cash_requests r
           JOIN employees e ON e.id = r.employee_id
           JOIN companies c ON c.id = r.company_id
          WHERE r.company_id IN (${list}) AND r.status = 'APPROVED'
          ORDER BY r.request_date`
      )
      .all(...ids);

    const sum = (rows, field) => money(rows.reduce((t, r) => t + Number(r[field] || 0), 0));
    const unpaid = (rows) => rows.filter((r) => r.status === 'DUE');

    const sections = {
      supplier_invoices: {
        label: 'Supplier invoices falling due',
        count: invoices.length,
        amount: sum(invoices, 'outstanding'),
        overdue_amount: sum(invoices.filter((i) => i.is_overdue), 'outstanding'),
        rows: invoices
      },
      pdc: {
        label: 'PDC issued, dated this month',
        count: pdc.length,
        amount: sum(pdc, 'amount'),
        rows: pdc
      },
      stl: {
        label: 'STL settlement cheques',
        count: stl.length,
        amount: sum(stl, 'amount'),
        rows: stl
      },
      emi: {
        label: 'Bank instalments (vehicle and equipment loans)',
        count: unpaid(emi).length,
        amount: sum(unpaid(emi), 'amount'),
        paid_amount: sum(emi.filter((d) => d.status === 'PAID'), 'amount'),
        rows: emi
      },
      lc: {
        label: 'LC and trust receipts maturing',
        count: unpaid(lc).length,
        amount: sum(unpaid(lc), 'amount'),
        paid_amount: sum(lc.filter((d) => d.status === 'PAID'), 'amount'),
        rows: lc
      },
      petty_cash: {
        label: 'Petty cash approved, not yet paid',
        count: petty.length,
        amount: sum(petty, 'amount'),
        rows: petty
      }
    };

    // A cheque already covers the invoice it was written against, so counting
    // both would ask for the same money twice. The cheques are the firm
    // commitment, so the invoice total here excludes whatever they cover.
    const invoicesCoveredByCheques = sum(invoices, 'pdc_amount');
    const invoicesToArrange = money(sections.supplier_invoices.amount - invoicesCoveredByCheques);

    const total = money(
      invoicesToArrange +
      sections.pdc.amount +
      sections.stl.amount +
      sections.emi.amount +
      sections.lc.amount +
      sections.petty_cash.amount
    );

    res.json({
      month, from, to,
      sections,
      invoices_covered_by_cheques: invoicesCoveredByCheques,
      invoices_to_arrange: invoicesToArrange,
      cleared_this_month: { count: clearedThisMonth.length, amount: sum(clearedThisMonth, 'amount') },
      total
    });
  } catch (err) {
    next(err);
  }
});

/** Month-by-month totals, for the strip of buttons above the monthly view. */
router.get('/commitment-calendar', (req, res, next) => {
  try {
    const ids = scope(req);
    const list = inList(ids);
    const months = Math.min(Math.max(Number(req.query.months || 12), 1), 36);
    const startMonth = toDate(req.query.from) || `${today().slice(0, 7)}-01`;

    const out = [];
    for (let i = 0; i < months; i += 1) {
      const d = new Date(`${startMonth.slice(0, 7)}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + i);
      const { month, from, to } = monthRange(d.toISOString().slice(0, 7));

      const inv = db.prepare(
        `SELECT COUNT(*) cnt, ROUND(IFNULL(SUM(i.total_amount - IFNULL(paid.amt, 0)), 0), 2) amt
           FROM purchase_invoices i
           LEFT JOIN (SELECT a.invoice_id, SUM(a.amount) amt FROM payment_allocations a
                        JOIN payments p ON p.id = a.payment_id WHERE ${SQL_SETTLED}
                       GROUP BY a.invoice_id) paid ON paid.invoice_id = i.id
          WHERE i.company_id IN (${list}) AND i.status NOT IN ('CANCELLED','ON_HOLD')
            AND i.due_date BETWEEN ? AND ?
            AND (i.total_amount - IFNULL(paid.amt, 0)) > 0.005`
      ).get(...ids, from, to);

      const chq = db.prepare(
        `SELECT
           ROUND(IFNULL(SUM(CASE WHEN pdc_status IN ('ISSUED','PRESENTED') THEN amount END), 0), 2) pdc,
           ROUND(IFNULL(SUM(CASE WHEN pdc_status = 'SETTLED' THEN amount END), 0), 2) stl,
           SUM(CASE WHEN pdc_status IN ('ISSUED','PRESENTED') THEN 1 ELSE 0 END) pdc_count,
           SUM(CASE WHEN pdc_status = 'SETTLED' THEN 1 ELSE 0 END) stl_count
           FROM payments
          WHERE company_id IN (${list}) AND mode IN ('PDC','CHEQUE') AND status <> 'CANCELLED'
            AND cheque_date BETWEEN ? AND ?`
      ).get(...ids, from, to);

      const fac = db.prepare(
        `SELECT
           ROUND(IFNULL(SUM(CASE WHEN f.type IN ('VEHICLE_LOAN','EQUIPMENT_LOAN','TERM_LOAN')
                                 THEN d.amount END), 0), 2) emi,
           ROUND(IFNULL(SUM(CASE WHEN f.type NOT IN ('VEHICLE_LOAN','EQUIPMENT_LOAN','TERM_LOAN')
                                 THEN d.amount END), 0), 2) lc
           FROM facility_dues d JOIN bank_facilities f ON f.id = d.facility_id
          WHERE d.company_id IN (${list}) AND d.status = 'DUE'
            AND d.due_date BETWEEN ? AND ?`
      ).get(...ids, from, to);

      out.push({
        month,
        invoices: money(inv.amt), invoice_count: inv.cnt,
        pdc: money(chq.pdc), pdc_count: chq.pdc_count || 0,
        stl: money(chq.stl), stl_count: chq.stl_count || 0,
        emi: money(fac.emi), lc: money(fac.lc),
        total: money(inv.amt + chq.pdc + chq.stl + fac.emi + fac.lc)
      });
    }

    res.json({ months: out });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ payable forecast

/**
 * What each supplier is owed, spread across the months the money actually falls
 * due - the shape the group already keeps by hand, supplier down the side and
 * month across the top.
 *
 * Two ways of deciding which month an invoice lands in:
 *
 *   assumed  invoices are treated as submitted on a fixed day of their submission
 *            month and paid a fixed number of days later. This is the planning
 *            view: "everything submitted in August, on 90 day terms, is due in
 *            November", regardless of what each individual bill says.
 *   actual   each invoice's own due date, worked out from its own terms.
 *
 * Only what is still outstanding is counted; a settled invoice needs no cash.
 */
router.get('/supplier-forecast', (req, res, next) => {
  try {
    const ids = scope(req);
    const basis = String(req.query.basis || 'assumed').toLowerCase() === 'actual' ? 'actual' : 'assumed';
    const terms = Math.min(Math.max(Number(req.query.terms || 90), 0), 365);
    const anchorDay = Math.min(Math.max(Number(req.query.day || 5), 1), 28);
    const monthCount = Math.min(Math.max(Number(req.query.months || 12), 1), 36);

    const invoices = openInvoices(ids);

    /** The month this invoice's money is needed in. */
    const dueMonthFor = (inv) => {
      if (basis === 'actual') {
        return inv.due_date ? inv.due_date.slice(0, 7) : null;
      }
      const base = inv.submitted_date || inv.invoice_date;
      if (!base) return null;
      // Treat it as submitted on the same day of that month, then add the terms.
      const anchor = `${base.slice(0, 7)}-${String(anchorDay).padStart(2, '0')}`;
      return addDays(anchor, terms).slice(0, 7);
    };

    const bySupplier = new Map();
    const monthsSeen = new Set();
    let unscheduled = 0;

    invoices.forEach((inv) => {
      const month = dueMonthFor(inv);
      const amount = money(inv.outstanding);
      if (!month) { unscheduled = money(unscheduled + amount); return; }
      monthsSeen.add(month);

      if (!bySupplier.has(inv.supplier_id)) {
        bySupplier.set(inv.supplier_id, {
          supplier_id: inv.supplier_id,
          supplier_code: inv.supplier_code,
          supplier_name: inv.supplier_name,
          months: {},
          total: 0,
          invoices: 0
        });
      }
      const row = bySupplier.get(inv.supplier_id);
      row.months[month] = money((row.months[month] || 0) + amount);
      row.total = money(row.total + amount);
      row.invoices += 1;
    });

    // Show a continuous run of months, so an empty one is visibly empty rather
    // than silently missing from the middle of the table.
    const sorted = [...monthsSeen].sort();
    let months = [];
    if (sorted.length) {
      const first = req.query.from ? String(req.query.from).slice(0, 7) : sorted[0];
      const cursor = new Date(`${first}-01T00:00:00Z`);
      for (let i = 0; i < monthCount; i += 1) {
        months.push(cursor.toISOString().slice(0, 7));
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      // Anything falling outside the window still has to be shown somewhere.
      const shown = new Set(months);
      const before = sorted.filter((m) => !shown.has(m) && m < months[0]);
      const after = sorted.filter((m) => !shown.has(m) && m > months[months.length - 1]);
      if (before.length) months = [...before, ...months];
      if (after.length) months = [...months, ...after];
    }

    const rows = [...bySupplier.values()].sort((a, b) => b.total - a.total);

    const monthTotals = {};
    months.forEach((m) => {
      monthTotals[m] = money(rows.reduce((t, r) => t + (r.months[m] || 0), 0));
    });

    res.json({
      basis,
      terms,
      anchor_day: anchorDay,
      months,
      rows,
      month_totals: monthTotals,
      total: money(rows.reduce((t, r) => t + r.total, 0)),
      supplier_count: rows.length,
      unscheduled
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ audit trail

router.get('/audit', requirePermission('audit.view'), (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit || 200), 1000);
    const where = [];
    const params = [];
    if (req.query.entity) {
      where.push('entity = ?');
      params.push(String(req.query.entity));
    }
    if (req.query.user_id) {
      where.push('user_id = ?');
      params.push(Number(req.query.user_id));
    }
    if (req.query.action) {
      where.push('action = ?');
      params.push(String(req.query.action).toUpperCase());
    }
    const rows = db
      .prepare(
        `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY id DESC LIMIT ?`
      )
      .all(...params, limit);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ helpers

function monthlyCashOut(ids, months) {
  const start = `${addDays(today(), -30 * months).slice(0, 7)}-01`;
  const rows = db
    .prepare(
      `SELECT substr(p.payment_date, 1, 7) AS month,
              ROUND(IFNULL(SUM(p.amount), 0), 2) AS amount,
              ROUND(IFNULL(SUM(CASE WHEN p.mode = 'CASH' THEN p.amount END), 0), 2) AS cash,
              ROUND(IFNULL(SUM(CASE WHEN p.mode IN ('BANK_TRANSFER','ONLINE') THEN p.amount END), 0), 2) AS transfer,
              ROUND(IFNULL(SUM(CASE WHEN p.mode IN ('PDC','CHEQUE') THEN p.amount END), 0), 2) AS cheque
         FROM payments p
        WHERE p.company_id IN (${inList(ids)}) AND p.status <> 'CANCELLED' AND p.payment_date >= ?
        GROUP BY month ORDER BY month`
    )
    .all(...ids, start);
  return rows;
}

function monthlyIncome(ids, months) {
  const start = `${addDays(today(), -30 * months).slice(0, 7)}-01`;
  return db
    .prepare(
      `SELECT substr(r.receipt_date, 1, 7) AS month, ROUND(IFNULL(SUM(r.amount), 0), 2) AS amount
         FROM receipts r
        WHERE r.company_id IN (${inList(ids)}) AND r.status <> 'CANCELLED' AND r.receipt_date >= ?
        GROUP BY month ORDER BY month`
    )
    .all(...ids, start);
}

module.exports = router;
