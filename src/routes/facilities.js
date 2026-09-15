'use strict';

/**
 * Money owed to a bank on a date rather than to a supplier against an invoice:
 * vehicle and equipment loans paid by monthly instalment, and letters of credit
 * that fall due on their maturity date.
 *
 * A facility is entered once with its instalment amount, and the monthly dues are
 * worked out from it. Accounts can correct an individual month when the bank
 * takes a different figure, without disturbing the rest of the schedule.
 */

const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requirePermission, assertCompanyAccess } = require('../auth');
const {
  text, money, toDate, today, badRequest, notFound, parseAmount, isBlank,
  monthlyDueDate, monthsBetween, monthRange
} = require('../util');

const router = express.Router();
router.use(requireAuth);

const TYPES = ['VEHICLE_LOAN', 'EQUIPMENT_LOAN', 'TERM_LOAN', 'LC', 'TRUST_RECEIPT', 'OTHER'];
/** Types that repay monthly. The rest fall due once, on their maturity date. */
const INSTALMENT_TYPES = ['VEHICLE_LOAN', 'EQUIPMENT_LOAN', 'TERM_LOAN'];

const FACILITY_SELECT = `
  SELECT f.*,
         c.name AS company_name, c.code AS company_code,
         s.name AS supplier_name,
         ba.bank_name AS account_bank_name, ba.account_no AS account_no,
         u.name AS created_by_name,
         ROUND(IFNULL(d.total, 0), 2)     AS scheduled_total,
         ROUND(IFNULL(d.paid, 0), 2)      AS paid_total,
         ROUND(IFNULL(d.remaining, 0), 2) AS remaining_total,
         IFNULL(d.count, 0)               AS instalments,
         IFNULL(d.paid_count, 0)          AS instalments_paid,
         d.next_due_date,
         d.next_due_amount
    FROM bank_facilities f
    JOIN companies c ON c.id = f.company_id
    LEFT JOIN suppliers s ON s.id = f.supplier_id
    LEFT JOIN bank_accounts ba ON ba.id = f.bank_account_id
    LEFT JOIN users u ON u.id = f.created_by
    LEFT JOIN (
      SELECT facility_id,
             COUNT(*) AS count,
             SUM(amount) AS total,
             SUM(CASE WHEN status = 'PAID' THEN amount END) AS paid,
             SUM(CASE WHEN status = 'DUE'  THEN amount END) AS remaining,
             SUM(CASE WHEN status = 'PAID' THEN 1 ELSE 0 END) AS paid_count,
             MIN(CASE WHEN status = 'DUE' THEN due_date END) AS next_due_date,
             NULL AS next_due_amount
        FROM facility_dues
       GROUP BY facility_id
    ) d ON d.facility_id = f.id
`;

// ------------------------------------------------------------------ list

router.get('/', requirePermission('facility.view'), (req, res, next) => {
  try {
    const where = [`f.company_id IN (${req.companyIds.map(() => '?').join(',') || '-1'})`];
    const params = [...req.companyIds];

    if (req.query.company_id) {
      where.push('f.company_id = ?');
      params.push(assertCompanyAccess(req, req.query.company_id));
    }
    if (req.query.type) {
      where.push('f.type = ?');
      params.push(String(req.query.type).toUpperCase());
    }
    if (req.query.status) {
      where.push('f.status = ?');
      params.push(String(req.query.status).toUpperCase());
    } else {
      where.push("f.status <> 'CANCELLED'");
    }
    const q = text(req.query.q);
    if (q) {
      where.push(`(f.reference LIKE '%' || ? || '%' OR f.vehicle_no LIKE '%' || ? || '%'
                   OR f.bank_name LIKE '%' || ? || '%' OR f.description LIKE '%' || ? || '%')`);
      params.push(q, q, q, q);
    }

    const rows = db
      .prepare(`${FACILITY_SELECT} WHERE ${where.join(' AND ')}
                 ORDER BY f.status, f.type, f.vehicle_no, f.id`)
      .all(...params)
      .map(decorate);

    const totals = rows.reduce((t, r) => {
      if (r.status !== 'ACTIVE') return t;
      t.count += 1;
      t.monthly = money(t.monthly + (r.is_instalment ? r.emi_amount : 0));
      t.remaining = money(t.remaining + r.remaining_total);
      if (r.type === 'LC' || r.type === 'TRUST_RECEIPT') t.lc = money(t.lc + r.remaining_total);
      t.due_this_month = money(t.due_this_month + r.due_this_month);
      t.overdue_amount = money(t.overdue_amount + r.overdue_amount);
      t.overdue_count += r.overdue_instalments;
      return t;
    }, { count: 0, monthly: 0, remaining: 0, lc: 0, due_this_month: 0, overdue_amount: 0, overdue_count: 0 });

    res.json({ rows, totals });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', requirePermission('facility.view'), (req, res, next) => {
  try {
    const row = db.prepare(`${FACILITY_SELECT} WHERE f.id = ?`).get(req.params.id);
    if (!row) throw notFound('Facility not found');
    assertCompanyAccess(req, row.company_id);
    const dues = db
      .prepare(
        `SELECT d.*, u.name AS paid_by_name FROM facility_dues d
           LEFT JOIN users u ON u.id = d.paid_by
          WHERE d.facility_id = ? ORDER BY d.due_date`
      )
      .all(row.id);
    res.json({ ...decorate(row), dues });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ create / edit

router.post('/', requirePermission('facility.edit'), (req, res, next) => {
  try {
    const data = read(req);
    const id = db.transaction(() => {
      const info = db
        .prepare(
          `INSERT INTO bank_facilities
             (company_id, type, reference, vehicle_no, description, bank_name, bank_account_id,
              supplier_id, currency, principal_amount, emi_amount, due_day, start_date, end_date,
              status, notes, created_by)
           VALUES (@company_id, @type, @reference, @vehicle_no, @description, @bank_name,
                   @bank_account_id, @supplier_id, @currency, @principal_amount, @emi_amount,
                   @due_day, @start_date, @end_date, 'ACTIVE', @notes, @user)`
        )
        .run({ ...data, user: req.user.id });
      buildSchedule(info.lastInsertRowid);
      return info.lastInsertRowid;
    })();

    const row = db.prepare(`${FACILITY_SELECT} WHERE f.id = ?`).get(id);
    audit(req, {
      action: 'CREATE', entity: 'bank_facility', entity_id: id,
      summary: `${label(data.type)}${data.vehicle_no ? ` ${data.vehicle_no}` : ''} with ${data.bank_name}` +
               (data.emi_amount ? `, ${money(data.emi_amount)} a month` : ''),
      details: data
    });
    res.status(201).json(decorate(row));
  } catch (err) {
    next(err);
  }
});

router.put('/:id', requirePermission('facility.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM bank_facilities WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Facility not found');
    assertCompanyAccess(req, existing.company_id);

    const data = read(req, existing);
    db.transaction(() => {
      db.prepare(
        `UPDATE bank_facilities SET
           company_id = @company_id, type = @type, reference = @reference, vehicle_no = @vehicle_no,
           description = @description, bank_name = @bank_name, bank_account_id = @bank_account_id,
           supplier_id = @supplier_id, currency = @currency, principal_amount = @principal_amount,
           emi_amount = @emi_amount, due_day = @due_day, start_date = @start_date,
           end_date = @end_date, notes = @notes, updated_at = datetime('now')
         WHERE id = @id`
      ).run({ ...data, id: existing.id });
      // Instalments already paid are history; only the unpaid ones are rebuilt.
      buildSchedule(existing.id, { rebuildUnpaid: true });
    })();

    audit(req, {
      action: 'UPDATE', entity: 'bank_facility', entity_id: existing.id,
      summary: `Edited ${label(data.type)}${data.vehicle_no ? ` ${data.vehicle_no}` : ''}`,
      details: data
    });
    res.json(decorate(db.prepare(`${FACILITY_SELECT} WHERE f.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/close', requirePermission('facility.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM bank_facilities WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Facility not found');
    assertCompanyAccess(req, existing.company_id);
    const status = String(req.body.status || 'CLOSED').toUpperCase();
    if (!['ACTIVE', 'CLOSED', 'CANCELLED'].includes(status)) throw badRequest('Invalid status');

    db.prepare("UPDATE bank_facilities SET status = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, existing.id);
    if (status !== 'ACTIVE') {
      // Nothing more is owed on a facility that has been settled or cancelled.
      db.prepare("UPDATE facility_dues SET status = 'SKIPPED' WHERE facility_id = ? AND status = 'DUE'")
        .run(existing.id);
    }
    audit(req, {
      action: status === 'ACTIVE' ? 'REOPEN' : 'CLOSE', entity: 'bank_facility',
      entity_id: existing.id, summary: `Marked facility ${status.toLowerCase()}`
    });
    res.json(decorate(db.prepare(`${FACILITY_SELECT} WHERE f.id = ?`).get(existing.id)));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', requirePermission('facility.delete'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM bank_facilities WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Facility not found');
    assertCompanyAccess(req, existing.company_id);
    const paid = db
      .prepare("SELECT COUNT(*) c FROM facility_dues WHERE facility_id = ? AND status = 'PAID'")
      .get(existing.id).c;
    if (paid > 0) {
      throw badRequest(
        `${paid} instalment(s) have already been paid, so this cannot be deleted. Close it instead.`
      );
    }
    db.prepare('DELETE FROM bank_facilities WHERE id = ?').run(existing.id);
    audit(req, {
      action: 'DELETE', entity: 'bank_facility', entity_id: existing.id,
      summary: `Deleted ${label(existing.type)}${existing.vehicle_no ? ` ${existing.vehicle_no}` : ''}`,
      details: existing
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ instalments

/** Add or correct a single month, for when the bank takes a different figure. */
router.post('/:id/dues', requirePermission('facility.edit'), (req, res, next) => {
  try {
    const facility = db.prepare('SELECT * FROM bank_facilities WHERE id = ?').get(req.params.id);
    if (!facility) throw notFound('Facility not found');
    assertCompanyAccess(req, facility.company_id);

    const dueDate = toDate(req.body.due_date);
    if (!dueDate) throw badRequest('Enter the date it falls due');
    const amount = parseAmount(req.body.amount, 'Amount');
    if (amount <= 0) throw badRequest('The amount must be more than zero');

    db.prepare(
      `INSERT INTO facility_dues (facility_id, company_id, due_date, amount, notes)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(facility_id, due_date) DO UPDATE SET
         amount = excluded.amount, notes = excluded.notes`
    ).run(facility.id, facility.company_id, dueDate, amount, text(req.body.notes));

    audit(req, {
      action: 'UPDATE', entity: 'facility_due', entity_id: facility.id,
      summary: `Set the instalment due ${dueDate} to ${money(amount)}`
    });
    res.json(decorate(db.prepare(`${FACILITY_SELECT} WHERE f.id = ?`).get(facility.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/dues/:dueId/pay', requirePermission('facility.pay'), (req, res, next) => {
  try {
    const due = db.prepare('SELECT * FROM facility_dues WHERE id = ?').get(req.params.dueId);
    if (!due) throw notFound('Instalment not found');
    assertCompanyAccess(req, due.company_id);
    if (due.status === 'PAID') throw badRequest('That instalment is already marked paid');

    const mode = String(req.body.paid_mode || 'AUTO_DEBIT').toUpperCase();
    if (!['BANK_TRANSFER', 'CASH', 'CHEQUE', 'AUTO_DEBIT', 'ONLINE', 'OTHER'].includes(mode)) {
      throw badRequest('Choose how it was paid');
    }
    db.prepare(
      `UPDATE facility_dues SET status = 'PAID', paid_date = ?, paid_mode = ?, paid_ref = ?,
              paid_by = ?, amount = ? WHERE id = ?`
    ).run(
      toDate(req.body.paid_date) || today(), mode, text(req.body.paid_ref), req.user.id,
      isBlank(req.body.amount) ? due.amount : parseAmount(req.body.amount, 'Amount'),
      due.id
    );
    audit(req, {
      action: 'PAY', entity: 'facility_due', entity_id: due.id,
      summary: `Paid the instalment due ${due.due_date} of ${money(due.amount)}`
    });
    res.json(db.prepare('SELECT * FROM facility_dues WHERE id = ?').get(due.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/dues/:dueId', requirePermission('facility.edit'), (req, res, next) => {
  try {
    const due = db.prepare('SELECT * FROM facility_dues WHERE id = ?').get(req.params.dueId);
    if (!due) throw notFound('Instalment not found');
    assertCompanyAccess(req, due.company_id);
    if (due.status === 'PAID') throw badRequest('A paid instalment cannot be removed');
    db.prepare('DELETE FROM facility_dues WHERE id = ?').run(due.id);
    audit(req, {
      action: 'DELETE', entity: 'facility_due', entity_id: due.id,
      summary: `Removed the instalment due ${due.due_date}`
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ helpers

/** Title case, but acronyms stay shouting: "LC", not "Lc". */
function label(v) {
  const acronyms = ['LC', 'PDC', 'STL', 'EMI'];
  return String(v || '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w+\b/g, (word) => {
      const up = word.toUpperCase();
      return acronyms.includes(up) ? up : word.charAt(0).toUpperCase() + word.slice(1);
    });
}

function read(req, existing) {
  const b = req.body;
  const companyId = assertCompanyAccess(req, b.company_id ?? (existing && existing.company_id));

  const type = String(b.type ?? (existing && existing.type) ?? '').toUpperCase();
  if (!TYPES.includes(type)) throw badRequest(`Choose a type: ${TYPES.map(label).join(', ')}`);

  const bankName = text(b.bank_name) ||
    (b.bank_account_id
      ? (db.prepare('SELECT bank_name FROM bank_accounts WHERE id = ?').get(Number(b.bank_account_id)) || {}).bank_name
      : null) ||
    (existing && existing.bank_name);
  if (!bankName) throw badRequest('Enter the bank');

  const isInstalment = INSTALMENT_TYPES.includes(type);
  const vehicleNo = text(b.vehicle_no);
  if (type === 'VEHICLE_LOAN' && !vehicleNo) {
    throw badRequest('Enter the vehicle number for a vehicle loan');
  }

  const emi = parseAmount(b.emi_amount ?? (existing ? existing.emi_amount : 0), 'Monthly instalment');
  const principal = parseAmount(b.principal_amount ?? (existing ? existing.principal_amount : 0), 'Amount');

  if (isInstalment && emi <= 0) throw badRequest('Enter the monthly instalment amount');
  if (!isInstalment && principal <= 0 && emi <= 0) throw badRequest('Enter the amount');

  const startDate = toDate(b.start_date ?? (existing && existing.start_date));
  const endDate = toDate(b.end_date ?? (existing && existing.end_date));
  if (isInstalment) {
    if (!startDate) throw badRequest('Enter the date the instalments start');
    if (!endDate) throw badRequest('Enter the date the last instalment falls');
    if (endDate < startDate) throw badRequest('The last instalment cannot fall before the first');
    if (monthsBetween(startDate, endDate) > 600) throw badRequest('That schedule is longer than 50 years');
  } else if (!endDate) {
    throw badRequest('Enter the date it falls due');
  }

  const dueDay = Number(b.due_day ?? (existing ? existing.due_day : 0)) ||
    (startDate ? Number(startDate.slice(8, 10)) : 1);
  if (dueDay < 1 || dueDay > 31) throw badRequest('The due day must be between 1 and 31');

  return {
    company_id: companyId,
    type,
    reference: text(b.reference),
    vehicle_no: vehicleNo,
    description: text(b.description),
    bank_name: bankName,
    bank_account_id: isBlank(b.bank_account_id) ? null : Number(b.bank_account_id),
    supplier_id: isBlank(b.supplier_id) ? null : Number(b.supplier_id),
    currency: text(b.currency) || (existing && existing.currency) || process.env.DEFAULT_CURRENCY || 'AED',
    principal_amount: principal,
    emi_amount: emi,
    due_day: dueDay,
    start_date: startDate,
    end_date: endDate,
    notes: text(b.notes)
  };
}

/**
 * Work the monthly dues out from the facility. Anything already paid is left
 * alone - the schedule is a plan, and what has been paid is history.
 */
function buildSchedule(facilityId, opts) {
  const f = db.prepare('SELECT * FROM bank_facilities WHERE id = ?').get(facilityId);
  if (!f) return;

  if (opts && opts.rebuildUnpaid) {
    db.prepare("DELETE FROM facility_dues WHERE facility_id = ? AND status = 'DUE'").run(f.id);
  }

  const ins = db.prepare(
    `INSERT INTO facility_dues (facility_id, company_id, due_date, amount)
     VALUES (?, ?, ?, ?) ON CONFLICT(facility_id, due_date) DO NOTHING`
  );

  if (!INSTALMENT_TYPES.includes(f.type)) {
    // One payment, on its maturity date.
    ins.run(f.id, f.company_id, f.end_date, money(f.principal_amount || f.emi_amount));
    return;
  }

  const count = monthsBetween(f.start_date, f.end_date);
  for (let i = 0; i <= count; i += 1) {
    const dueDate = monthlyDueDate(f.start_date, i, f.due_day);
    if (!dueDate || dueDate > f.end_date) break;
    ins.run(f.id, f.company_id, dueDate, money(f.emi_amount));
  }
}

/** The month we are in, as a first and last day. */
function thisMonth() {
  return monthRange(today().slice(0, 7));
}

function decorate(row) {
  if (!row) return row;
  const isInstalment = INSTALMENT_TYPES.includes(row.type);
  return {
    ...row,
    type_label: label(row.type),
    is_instalment: isInstalment,
    is_lc: row.type === 'LC' || row.type === 'TRUST_RECEIPT',
    overdue_instalments: db
      .prepare(
        "SELECT COUNT(*) c FROM facility_dues WHERE facility_id = ? AND status = 'DUE' AND due_date < ?"
      )
      .get(row.id, today()).c,
    // What this facility still has to be paid inside the current month, so the
    // Bank EMI screen can total the month without fetching every schedule.
    due_this_month: money(db
      .prepare(
        `SELECT IFNULL(SUM(amount), 0) a FROM facility_dues
          WHERE facility_id = ? AND status = 'DUE' AND due_date BETWEEN ? AND ?`
      )
      .get(row.id, thisMonth().from, thisMonth().to).a),
    overdue_amount: money(db
      .prepare(
        "SELECT IFNULL(SUM(amount), 0) a FROM facility_dues WHERE facility_id = ? AND status = 'DUE' AND due_date < ?"
      )
      .get(row.id, today()).a)
  };
}

module.exports = router;
module.exports.TYPES = TYPES;
module.exports.INSTALMENT_TYPES = INSTALMENT_TYPES;
module.exports.monthRange = monthRange;
