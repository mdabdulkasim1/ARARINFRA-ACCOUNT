'use strict';

const express = require('express');
const { db, audit, nextDocNo } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess, can } = require('../auth');
const { text, money, toDate, today, badRequest, notFound, parseAmount, isBlank } = require('../util');

const router = express.Router();
router.use(requireAuth);

/**
 * Petty cash follows one path:
 *
 *   accounts raise it  ->  PENDING
 *   finance manager    ->  VERIFIED   (optional step, the owner can approve straight away)
 *   owner              ->  APPROVED   or REJECTED
 *   accounts pay it    ->  PAID
 *
 * Nobody approves a request they raised themselves.
 */
const PC_SELECT = `
  SELECT r.*,
         e.name AS employee_name, e.code AS employee_code, e.department AS employee_department,
         e.designation AS employee_designation,
         c.name AS company_name, c.code AS company_code,
         cat.name AS category_name,
         ru.name AS requested_by_name,
         vu.name AS verified_by_name,
         au.name AS approved_by_name,
         ju.name AS rejected_by_name,
         pu.name AS paid_by_name
    FROM petty_cash_requests r
    JOIN employees e  ON e.id = r.employee_id
    JOIN companies c  ON c.id = r.company_id
    LEFT JOIN categories cat ON cat.id = r.category_id
    LEFT JOIN users ru ON ru.id = r.requested_by
    LEFT JOIN users vu ON vu.id = r.verified_by
    LEFT JOIN users au ON au.id = r.approved_by
    LEFT JOIN users ju ON ju.id = r.rejected_by
    LEFT JOIN users pu ON pu.id = r.paid_by
`;

router.get('/', requirePermission('petty.view'), (req, res, next) => {
  try {
    const where = [`r.company_id IN (${req.companyIds.map(() => '?').join(',') || '-1'})`];
    const params = [...req.companyIds];

    if (req.query.company_id) {
      where.push('r.company_id = ?');
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    if (req.query.status) {
      where.push('r.status = ?');
      params.push(String(req.query.status).toUpperCase());
    }
    if (req.query.employee_id) {
      where.push('r.employee_id = ?');
      params.push(Number(req.query.employee_id));
    }
    if (req.query.requested_by) {
      where.push('r.requested_by = ?');
      params.push(Number(req.query.requested_by));
    }
    if (req.query.from) {
      where.push('r.request_date >= ?');
      params.push(toDate(req.query.from));
    }
    if (req.query.to) {
      where.push('r.request_date <= ?');
      params.push(toDate(req.query.to));
    }
    const q = text(req.query.q);
    if (q) {
      where.push(`(r.request_no LIKE '%' || ? || '%' OR r.purpose LIKE '%' || ? || '%'
                   OR e.name LIKE '%' || ? || '%' OR r.bill_ref LIKE '%' || ? || '%')`);
      params.push(q, q, q, q);
    }
    if (String(req.query.view || '').toLowerCase() === 'awaiting_me') {
      if (can(req.user, 'petty.approve')) {
        where.push("r.status IN ('PENDING','VERIFIED')");
      } else if (can(req.user, 'petty.verify')) {
        where.push("r.status = 'PENDING'");
      } else {
        where.push('r.requested_by = ?');
        params.push(req.user.id);
      }
    }

    const rows = db
      .prepare(`${PC_SELECT} WHERE ${where.join(' AND ')} ORDER BY
                  CASE r.status WHEN 'PENDING' THEN 0 WHEN 'VERIFIED' THEN 1 WHEN 'APPROVED' THEN 2
                                ELSE 3 END, r.request_date DESC, r.id DESC`)
      .all(...params)
      .map((r) => decorate(r, req.user));

    res.json({ rows, totals: summarise(rows) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('petty.view'), (req, res, next) => {
  try {
    const row = db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(req.params.id);
    if (!row) throw notFound('Petty cash request not found');
    assertCompanyAccess(req, row.company_id);
    res.json(decorate(row, req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/', requirePermission('petty.create'), (req, res, next) => {
  try {
    const b = req.body;
    const companyId = assertCompanyAccess(req, b.company_id);
    const employeeId = Number(b.employee_id);
    if (!employeeId) throw badRequest('Choose the employee who is requesting the cash');
    const employee = db.prepare('SELECT * FROM employees WHERE id = ?').get(employeeId);
    if (!employee) throw badRequest('That employee no longer exists');

    const amount = parseAmount(b.amount, 'Amount');
    if (amount <= 0) throw badRequest('The amount must be more than zero');
    const purpose = text(b.purpose);
    if (!purpose) throw badRequest('Say what the petty cash is for');

    const company = db.prepare('SELECT code FROM companies WHERE id = ?').get(companyId);
    const requestDate = toDate(b.request_date) || today();

    const id = db.transaction(() => {
      const requestNo = nextDocNo('PC', company.code, requestDate);
      const info = db
        .prepare(
          `INSERT INTO petty_cash_requests
             (company_id, request_no, request_date, employee_id, requested_by, amount, currency,
              category_id, purpose, bill_ref, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`
        )
        .run(
          companyId, requestNo, requestDate, employeeId, req.user.id, amount,
          text(b.currency) || process.env.DEFAULT_CURRENCY || 'AED',
          isBlank(b.category_id) ? null : Number(b.category_id), purpose, text(b.bill_ref)
        );
      return info.lastInsertRowid;
    })();

    const row = db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(id);
    audit(req, {
      action: 'CREATE', entity: 'petty_cash', entity_id: id,
      summary: `${row.request_no}: ${money(amount)} for ${row.employee_name} - ${purpose}`
    });
    res.status(201).json(decorate(row, req.user));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requirePermission('petty.create'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM petty_cash_requests WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Petty cash request not found');
    assertCompanyAccess(req, existing.company_id);
    if (existing.status !== 'PENDING') {
      throw badRequest('Only a request that is still pending can be edited');
    }
    if (existing.requested_by !== req.user.id && !can(req.user, 'petty.approve')) {
      throw badRequest('You can only edit requests you raised');
    }
    const b = req.body;
    const amount = parseAmount(b.amount ?? existing.amount, 'Amount');
    if (amount <= 0) throw badRequest('The amount must be more than zero');

    db.prepare(
      `UPDATE petty_cash_requests SET employee_id = ?, amount = ?, category_id = ?, purpose = ?,
              bill_ref = ?, request_date = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(
      Number(b.employee_id || existing.employee_id), amount,
      isBlank(b.category_id) ? existing.category_id : Number(b.category_id),
      text(b.purpose) || existing.purpose, text(b.bill_ref),
      toDate(b.request_date) || existing.request_date, existing.id
    );
    audit(req, {
      action: 'UPDATE', entity: 'petty_cash', entity_id: existing.id,
      summary: `Edited petty cash request ${existing.request_no}`
    });
    res.json(decorate(db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(existing.id), req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/verify', requirePermission('petty.verify'), (req, res, next) => {
  try {
    const row = load(req);
    if (row.status !== 'PENDING') throw badRequest('Only a pending request can be verified');
    if (row.requested_by === req.user.id) {
      throw badRequest('You raised this request, so somebody else has to check it');
    }
    db.prepare(
      `UPDATE petty_cash_requests SET status = 'VERIFIED', verified_by = ?, verified_at = datetime('now'),
              verify_remarks = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(req.user.id, text(req.body.remarks), row.id);
    audit(req, {
      action: 'VERIFY', entity: 'petty_cash', entity_id: row.id,
      summary: `Verified petty cash ${row.request_no} (${money(row.amount)})`
    });
    res.json(decorate(db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(row.id), req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', requirePermission('petty.approve'), (req, res, next) => {
  try {
    const row = load(req);
    if (!['PENDING', 'VERIFIED'].includes(row.status)) {
      throw badRequest(`This request is already ${row.status.toLowerCase()}`);
    }
    if (row.requested_by === req.user.id) {
      throw badRequest('You raised this request, so somebody else has to approve it');
    }
    db.prepare(
      `UPDATE petty_cash_requests SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now'),
              approve_remarks = ?, rejected_by = NULL, rejected_at = NULL, reject_reason = NULL,
              updated_at = datetime('now') WHERE id = ?`
    ).run(req.user.id, text(req.body.remarks), row.id);
    audit(req, {
      action: 'APPROVE', entity: 'petty_cash', entity_id: row.id,
      summary: `Approved petty cash ${row.request_no} of ${money(row.amount)} for ${row.employee_name}`
    });
    res.json(decorate(db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(row.id), req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/reject', (req, res, next) => {
  try {
    if (!can(req.user, 'petty.approve') && !can(req.user, 'petty.verify')) {
      throw badRequest('Your role cannot reject petty cash requests');
    }
    const row = load(req);
    if (!['PENDING', 'VERIFIED'].includes(row.status)) {
      throw badRequest(`This request is already ${row.status.toLowerCase()}`);
    }
    const reason = text(req.body.reason);
    if (!reason) throw badRequest('Enter the reason for rejecting');
    db.prepare(
      `UPDATE petty_cash_requests SET status = 'REJECTED', rejected_by = ?, rejected_at = datetime('now'),
              reject_reason = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(req.user.id, reason, row.id);
    audit(req, {
      action: 'REJECT', entity: 'petty_cash', entity_id: row.id,
      summary: `Rejected petty cash ${row.request_no}: ${reason}`
    });
    res.json(decorate(db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(row.id), req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pay', requirePermission('petty.pay'), (req, res, next) => {
  try {
    const row = load(req);
    if (row.status !== 'APPROVED') {
      throw badRequest('Petty cash can only be paid out after the owner has approved it');
    }
    const mode = String(req.body.paid_mode || 'CASH').toUpperCase();
    if (!['CASH', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE', 'OTHER'].includes(mode)) {
      throw badRequest('Choose how the petty cash was handed over');
    }
    db.prepare(
      `UPDATE petty_cash_requests SET status = 'PAID', paid_date = ?, paid_mode = ?, paid_ref = ?,
              paid_by = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(toDate(req.body.paid_date) || today(), mode, text(req.body.paid_ref), req.user.id, row.id);
    audit(req, {
      action: 'PAY', entity: 'petty_cash', entity_id: row.id,
      summary: `Paid petty cash ${row.request_no} of ${money(row.amount)} by ${mode.toLowerCase().replace('_', ' ')}`
    });
    res.json(decorate(db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(row.id), req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/cancel', requirePermission('petty.create'), (req, res, next) => {
  try {
    const row = load(req);
    if (row.status === 'PAID') throw badRequest('A paid request cannot be cancelled');
    if (row.requested_by !== req.user.id && !can(req.user, 'petty.approve')) {
      throw badRequest('You can only cancel requests you raised');
    }
    db.prepare("UPDATE petty_cash_requests SET status = 'CANCELLED', updated_at = datetime('now') WHERE id = ?")
      .run(row.id);
    audit(req, {
      action: 'CANCEL', entity: 'petty_cash', entity_id: row.id,
      summary: `Cancelled petty cash ${row.request_no}`
    });
    res.json(decorate(db.prepare(`${PC_SELECT} WHERE r.id = ?`).get(row.id), req.user));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('petty.delete'), (req, res, next) => {
  try {
    const row = load(req);
    db.prepare('DELETE FROM petty_cash_requests WHERE id = ?').run(row.id);
    audit(req, {
      action: 'DELETE', entity: 'petty_cash', entity_id: row.id,
      summary: `Deleted petty cash ${row.request_no}`, details: row
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function load(req) {
  const row = db.prepare('SELECT * FROM petty_cash_requests WHERE id = ?').get(req.params.id);
  if (!row) throw notFound('Petty cash request not found');
  assertCompanyAccess(req, row.company_id);
  const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(row.employee_id);
  row.employee_name = emp ? emp.name : '';
  return row;
}

/** Tell the screen which buttons this user should see on this row. */
function decorate(row, user) {
  if (!row) return row;
  const mine = row.requested_by === user.id;
  return {
    ...row,
    can_verify: can(user, 'petty.verify') && row.status === 'PENDING' && !mine,
    can_approve: can(user, 'petty.approve') && ['PENDING', 'VERIFIED'].includes(row.status) && !mine,
    can_reject: (can(user, 'petty.approve') || can(user, 'petty.verify')) &&
                ['PENDING', 'VERIFIED'].includes(row.status),
    can_pay: can(user, 'petty.pay') && row.status === 'APPROVED',
    can_edit: row.status === 'PENDING' && (mine || can(user, 'petty.approve')),
    can_cancel: row.status !== 'PAID' && row.status !== 'CANCELLED' && (mine || can(user, 'petty.approve')),
    is_mine: mine
  };
}

function summarise(rows) {
  const t = {
    count: rows.length, total: 0,
    pending: 0, pending_count: 0,
    verified: 0, verified_count: 0,
    approved: 0, approved_count: 0,
    paid: 0, paid_count: 0,
    rejected_count: 0
  };
  for (const r of rows) {
    if (r.status === 'CANCELLED') continue;
    t.total += money(r.amount);
    if (r.status === 'PENDING') { t.pending += money(r.amount); t.pending_count += 1; }
    if (r.status === 'VERIFIED') { t.verified += money(r.amount); t.verified_count += 1; }
    if (r.status === 'APPROVED') { t.approved += money(r.amount); t.approved_count += 1; }
    if (r.status === 'PAID') { t.paid += money(r.amount); t.paid_count += 1; }
    if (r.status === 'REJECTED') { t.rejected_count += 1; }
  }
  Object.keys(t).forEach((k) => { if (!k.endsWith('count')) t[k] = money(t[k]); });
  return t;
}

module.exports = router;
