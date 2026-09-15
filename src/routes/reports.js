'use strict';

const express = require('express');
const { db } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess } = require('../auth');
const {
  money, today, addDays, toDate, notFound, text,
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
          NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, D90_PLUS: 0, NO_DUE_DATE: 0
        };
      }
      const s = bySupplier[k];
      s.total = money(s.total + inv.outstanding);
      s.pdc = money(s.pdc + inv.pdc_amount);
      s.net_payable = money(s.total - s.pdc);
      s.invoices += 1;
      s[inv.ageing_bucket] = money(s[inv.ageing_bucket] + inv.outstanding);
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
