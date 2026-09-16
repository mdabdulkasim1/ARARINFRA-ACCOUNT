'use strict';

const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requirePermission, hashPassword, ROLES, assertCompanyAccess } = require('../auth');
const { publicUser } = require('./auth');
const { text, bool, badRequest, notFound, isBlank } = require('../util');
const { unallocatedAdvances } = require('../queries');
const { readSuppliers, templateCsv } = require('../supplier-sheet');

const router = express.Router();
router.use(requireAuth);

// ------------------------------------------------------------------ companies

router.get('/companies', (req, res) => {
  const all = bool(req.query.all);
  const ids = req.companyIds;
  const rows = db
    .prepare(
      `SELECT * FROM companies
        WHERE (${all ? '1=1' : `id IN (${ids.map(() => '?').join(',') || '-1'})`})
        ORDER BY name`
    )
    .all(...(all ? [] : ids));
  res.json(rows);
});

router.post('/companies', requirePermission('company.edit'), (req, res, next) => {
  try {
    const b = req.body;
    if (isBlank(b.code) || isBlank(b.name)) throw badRequest('Company code and name are required');
    const info = db
      .prepare(
        `INSERT INTO companies (code, name, legal_name, trn, currency, address, phone, email, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(b.code).trim().toUpperCase(), String(b.name).trim(), text(b.legal_name), text(b.trn),
        text(b.currency) || process.env.DEFAULT_CURRENCY || 'AED',
        text(b.address), text(b.phone), text(b.email), bool(b.active, true) ? 1 : 0
      );
    audit(req, { action: 'CREATE', entity: 'company', entity_id: info.lastInsertRowid, summary: `Added company ${b.name}` });
    res.status(201).json(db.prepare('SELECT * FROM companies WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    next(err);
  }
});

router.put('/companies/:id', requirePermission('company.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const existing = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Company not found');
    db.prepare(
      `UPDATE companies SET code = ?, name = ?, legal_name = ?, trn = ?, currency = ?,
              address = ?, phone = ?, email = ?, active = ? WHERE id = ?`
    ).run(
      String(b.code || existing.code).trim().toUpperCase(), String(b.name || existing.name).trim(),
      text(b.legal_name), text(b.trn), text(b.currency) || existing.currency,
      text(b.address), text(b.phone), text(b.email), bool(b.active, true) ? 1 : 0, existing.id
    );
    audit(req, { action: 'UPDATE', entity: 'company', entity_id: existing.id, summary: `Updated company ${b.name || existing.name}` });
    res.json(db.prepare('SELECT * FROM companies WHERE id = ?').get(existing.id));
  } catch (err) {
    next(err);
  }
});

/**
 * What is stopping this company from being removed, if anything.
 *
 * A company is only ever removed while it is empty - deleting one that has been
 * traded through would take its invoices and payments with it, and the figures
 * the owner watches would quietly change. So everything that points at it is
 * counted first and the answer is shown before anything happens.
 */
const COMPANY_HOLDINGS = [
  ['purchase_invoices', 'supplier invoice'],
  ['payments',          'payment'],
  ['sales_invoices',    'sales invoice'],
  ['receipts',          'receipt'],
  ['petty_cash_requests', 'petty cash request'],
  ['bank_facilities',   'loan or facility'],
  ['facility_dues',     'instalment'],
  ['employees',         'employee']
];

function companyHoldings(companyId) {
  return COMPANY_HOLDINGS
    .map(([table, label]) => ({
      label,
      count: db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE company_id = ?`).get(companyId).c
    }))
    .filter((h) => h.count > 0);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Remove a company outright.
 *
 * Its own bank accounts and the staff access rows go with it, because those are
 * only ever set up for the company itself. Anything else is a refusal with the
 * reason spelled out - deactivating from the edit screen is the way to retire a
 * company that has been used.
 */
router.delete('/companies/:id', requirePermission('company.edit'), (req, res, next) => {
  try {
    const existing = db.prepare('SELECT * FROM companies WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Company not found');

    if (db.prepare('SELECT COUNT(*) c FROM companies').get().c <= 1) {
      throw badRequest('This is the only company left, so it cannot be removed.');
    }

    const holdings = companyHoldings(existing.id);
    if (holdings.length) {
      throw badRequest(
        `${existing.name} still holds ${holdings.map((h) => plural(h.count, h.label)).join(', ')}. ` +
        'Untick "Active" on the company instead - that hides it everywhere without losing anything.'
      );
    }

    // A bank account belongs to its company, but a transfer may have been paid
    // out of it before the company was emptied, and those rows are kept.
    const bankIds = db
      .prepare('SELECT id FROM bank_accounts WHERE company_id = ?')
      .all(existing.id)
      .map((r) => r.id);
    if (bankIds.length) {
      const list = bankIds.map(() => '?').join(',');
      const used =
        db.prepare(`SELECT COUNT(*) c FROM payments WHERE from_bank_account_id IN (${list})`).get(...bankIds).c +
        db.prepare(`SELECT COUNT(*) c FROM receipts WHERE to_bank_account_id IN (${list})`).get(...bankIds).c;
      if (used) {
        throw badRequest(
          `${existing.name} has bank accounts that money has moved through. ` +
          'Untick "Active" on the company instead.'
        );
      }
    }

    db.transaction(() => {
      db.prepare('DELETE FROM bank_accounts WHERE company_id = ?').run(existing.id);
      db.prepare('DELETE FROM user_companies WHERE company_id = ?').run(existing.id);
      db.prepare('DELETE FROM companies WHERE id = ?').run(existing.id);
    })();

    audit(req, {
      action: 'DELETE', entity: 'company', entity_id: existing.id,
      summary: `Removed company ${existing.name}`,
      details: { code: existing.code, bank_accounts: bankIds.length }
    });
    res.json({ ok: true, removed: existing.name });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ suppliers

router.get('/suppliers', (req, res) => {
  const q = text(req.query.q);
  const rows = db
    .prepare(
      `SELECT * FROM suppliers
        WHERE (? IS NULL OR name LIKE '%' || ? || '%' OR code LIKE '%' || ? || '%')
          AND (? = 0 OR active = 1)
        ORDER BY name`
    )
    .all(q, q, q, bool(req.query.active_only, true) ? 1 : 0);
  res.json(rows);
});

/** A blank sheet in the shape the upload expects. */
router.get('/suppliers/import-template', requirePermission('master.edit'), (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="supplier-upload-template.csv"');
  res.send(templateCsv());
});

/**
 * Add a batch of suppliers from a spreadsheet.
 *
 * Suppliers arrive a site at a time, and typing forty of them one form at a time
 * is nobody's afternoon. A row that names a supplier already on file updates it
 * rather than making a second one, and only the columns the sheet actually
 * carries are touched - an upload with no phone column does not wipe the phone
 * numbers already recorded.
 *
 * Nothing is written unless `apply` is asked for, so the same call answers both
 * "what would this do" and "do it".
 */
router.post(
  '/suppliers/import',
  requirePermission('master.edit'),
  express.raw({ type: () => true, limit: '12mb' }),
  async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || !body.length) throw badRequest('No file was uploaded');

      const { suppliers, matched, ignored, header_row: headerRow } = await readSuppliers(body);
      if (!suppliers.length) {
        throw badRequest('That file has a heading row but no suppliers under it.');
      }

      const apply = bool(req.query.apply);
      const defaultTerms = Number(process.env.DEFAULT_PAYMENT_TERMS_DAYS || 90);

      const byCode = db.prepare('SELECT * FROM suppliers WHERE upper(code) = ?');
      const byName = db.prepare('SELECT * FROM suppliers WHERE lower(trim(name)) = ?');

      // Two rows in the same file for one supplier would otherwise both look new.
      const seen = new Map();
      const plan = suppliers.map((row) => {
        const existing = (row.code && byCode.get(row.code)) ||
                         byName.get(row.name.toLowerCase()) || null;
        const dupKey = (row.code || row.name).toLowerCase();
        const item = {
          row: row.row,
          name: row.name,
          code: row.code || (existing ? existing.code : null),
          action: seen.has(dupKey) ? 'skip' : (existing ? 'update' : 'add'),
          reason: seen.has(dupKey) ? `Same supplier as row ${seen.get(dupKey)}` : null,
          existing_id: existing ? existing.id : null,
          terms: row.payment_terms_days === null
            ? (existing ? existing.payment_terms_days : defaultTerms)
            : row.payment_terms_days,
          data: row
        };
        if (!seen.has(dupKey)) seen.set(dupKey, row.row);
        return item;
      });

      const counts = plan.reduce((c, p) => { c[p.action] += 1; return c; },
        { add: 0, update: 0, skip: 0 });

      if (!apply) {
        return res.json({
          applied: false, counts, matched, ignored, header_row: headerRow,
          rows: plan.map(({ data, ...rest }) => rest)
        });
      }

      const insert = db.prepare(
        `INSERT INTO suppliers (code, name, contact_person, phone, email, trn, address,
                                payment_terms_days, bank_name, bank_account_no, iban, notes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      db.transaction(() => {
        plan.forEach((p) => {
          const d = p.data;
          if (p.action === 'skip') return;
          if (p.action === 'add') {
            const code = d.code || nextCode('suppliers', 'SUP');
            const info = insert.run(
              code, d.name, d.contact_person, d.phone, d.email, d.trn, d.address,
              p.terms, d.bank_name, d.bank_account_no, d.iban, d.notes, d.active ? 1 : 0
            );
            p.existing_id = info.lastInsertRowid;
            p.code = code;
            return;
          }
          // Only what the sheet actually carries, so an upload missing a column
          // leaves what is already recorded alone.
          const keep = (fresh, current) => (fresh === null || fresh === '' ? current : fresh);
          const was = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(p.existing_id);
          db.prepare(
            `UPDATE suppliers SET name = ?, contact_person = ?, phone = ?, email = ?, trn = ?,
                    address = ?, payment_terms_days = ?, bank_name = ?, bank_account_no = ?,
                    iban = ?, notes = ?, active = ? WHERE id = ?`
          ).run(
            d.name,
            keep(d.contact_person, was.contact_person), keep(d.phone, was.phone),
            keep(d.email, was.email), keep(d.trn, was.trn), keep(d.address, was.address),
            p.terms, keep(d.bank_name, was.bank_name),
            keep(d.bank_account_no, was.bank_account_no), keep(d.iban, was.iban),
            keep(d.notes, was.notes), d.active ? 1 : 0, was.id
          );
        });
      })();

      audit(req, {
        action: 'IMPORT', entity: 'supplier', entity_id: null,
        summary: `${req.user.name} uploaded suppliers: ${counts.add} added, ${counts.update} updated` +
                 (counts.skip ? `, ${counts.skip} skipped` : ''),
        details: { counts, matched, ignored }
      });

      res.json({
        applied: true, counts, matched, ignored, header_row: headerRow,
        rows: plan.map(({ data, ...rest }) => rest)
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/suppliers/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!row) throw notFound('Supplier not found');
    row.unallocated_advance = unallocatedAdvances(row.id, req.query.company_id || null);
    res.json(row);
  } catch (err) {
    next(err);
  }
});

router.post('/suppliers', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    if (isBlank(b.name)) throw badRequest('Supplier name is required');
    const code = text(b.code) || nextCode('suppliers', 'SUP');
    const info = db
      .prepare(
        `INSERT INTO suppliers (code, name, contact_person, phone, email, trn, address,
                                payment_terms_days, bank_name, bank_account_no, iban, notes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code.toUpperCase(), String(b.name).trim(), text(b.contact_person), text(b.phone), text(b.email),
        text(b.trn), text(b.address),
        Number(b.payment_terms_days || process.env.DEFAULT_PAYMENT_TERMS_DAYS || 90),
        text(b.bank_name), text(b.bank_account_no), text(b.iban), text(b.notes),
        bool(b.active, true) ? 1 : 0
      );
    audit(req, { action: 'CREATE', entity: 'supplier', entity_id: info.lastInsertRowid, summary: `Added supplier ${b.name}` });
    res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    next(err);
  }
});

router.put('/suppliers/:id', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Supplier not found');
    db.prepare(
      `UPDATE suppliers SET code = ?, name = ?, contact_person = ?, phone = ?, email = ?, trn = ?,
              address = ?, payment_terms_days = ?, bank_name = ?, bank_account_no = ?, iban = ?,
              notes = ?, active = ? WHERE id = ?`
    ).run(
      (text(b.code) || existing.code).toUpperCase(), String(b.name || existing.name).trim(),
      text(b.contact_person), text(b.phone), text(b.email), text(b.trn), text(b.address),
      Number(b.payment_terms_days || existing.payment_terms_days),
      text(b.bank_name), text(b.bank_account_no), text(b.iban), text(b.notes),
      bool(b.active, true) ? 1 : 0, existing.id
    );
    audit(req, { action: 'UPDATE', entity: 'supplier', entity_id: existing.id, summary: `Updated supplier ${b.name || existing.name}` });
    res.json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(existing.id));
  } catch (err) {
    next(err);
  }
});

/**
 * Fold one or more supplier accounts into another.
 *
 * A supplier list grown by hand collects the same company several times under
 * different spellings, and internal cost pools that turn out to be one related
 * company. Everything moves across - invoices, payments, bank facilities - so the
 * balances follow, and the old accounts are kept but switched off rather than
 * deleted, because their codes appear in entries people may remember.
 */
router.post('/suppliers/merge', requirePermission('supplier.merge'), (req, res, next) => {
  try {
    const fromIds = (Array.isArray(req.body.from_supplier_ids) ? req.body.from_supplier_ids : [])
      .map(Number)
      .filter(Boolean);
    if (!fromIds.length) throw badRequest('Choose the supplier account(s) to fold in');

    // The target is either one that exists, or a new one named here.
    let target;
    if (!isBlank(req.body.into_supplier_id)) {
      target = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(Number(req.body.into_supplier_id));
      if (!target) throw badRequest('That supplier no longer exists');
    } else {
      const name = text(req.body.into_name);
      if (!name) throw badRequest('Name the supplier everything should sit under');
      const existing = db
        .prepare('SELECT * FROM suppliers WHERE upper(name) = upper(?)')
        .get(name);
      if (existing) {
        target = existing;
      } else {
        const first = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(fromIds[0]);
        const info = db
          .prepare(
            `INSERT INTO suppliers (code, name, payment_terms_days, bank_name, active)
             VALUES (?, ?, ?, ?, 1)`
          )
          .run(
            (text(req.body.into_code) || nextCode('suppliers', 'SUP')).toUpperCase(),
            name,
            Number(req.body.payment_terms_days || (first ? first.payment_terms_days : 90)),
            text(req.body.bank_name),
            );
        target = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid);
      }
    }

    if (fromIds.includes(target.id)) {
      throw badRequest('A supplier cannot be folded into itself');
    }

    const sources = fromIds
      .map((id) => db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id))
      .filter(Boolean);
    if (!sources.length) throw badRequest('None of those supplier accounts exist any more');

    const moved = { invoices: 0, payments: 0, facilities: 0, renamed: 0 };

    db.transaction(() => {
      sources.forEach((source) => {
        // An invoice number only has to be unique per supplier, so folding two
        // accounts together can collide. Keep both, and say which came from where.
        const clashes = db
          .prepare(
            `SELECT a.id, a.invoice_no, a.company_id
               FROM purchase_invoices a
               JOIN purchase_invoices b
                 ON b.supplier_id = ? AND b.company_id = a.company_id AND b.invoice_no = a.invoice_no
              WHERE a.supplier_id = ?`
          )
          .all(target.id, source.id);
        clashes.forEach((row) => {
          db.prepare('UPDATE purchase_invoices SET invoice_no = ? WHERE id = ?')
            .run(`${row.invoice_no} (${source.code})`, row.id);
          moved.renamed += 1;
        });

        moved.invoices += db
          .prepare('UPDATE purchase_invoices SET supplier_id = ? WHERE supplier_id = ?')
          .run(target.id, source.id).changes;
        moved.payments += db
          .prepare('UPDATE payments SET supplier_id = ? WHERE supplier_id = ?')
          .run(target.id, source.id).changes;
        moved.facilities += db
          .prepare('UPDATE bank_facilities SET supplier_id = ? WHERE supplier_id = ?')
          .run(target.id, source.id).changes;

        db.prepare(
          `UPDATE suppliers
              SET active = 0,
                  notes = TRIM(IFNULL(notes, '') || ' Folded into ' || ? || ' on ' || date('now'))
            WHERE id = ?`
        ).run(target.name, source.id);
      });
    })();

    audit(req, {
      action: 'MERGE', entity: 'supplier', entity_id: target.id,
      summary: `Folded ${sources.map((s) => s.name).join(', ')} into ${target.name}` +
               ` (${moved.invoices} invoice(s), ${moved.payments} payment(s))`,
      details: { from: sources.map((s) => ({ id: s.id, name: s.name })), into: target.id, moved }
    });

    res.json({
      ok: true,
      into: db.prepare('SELECT * FROM suppliers WHERE id = ?').get(target.id),
      folded: sources.map((s) => s.name),
      moved
    });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ customers

router.get('/customers', (req, res) => {
  const q = text(req.query.q);
  res.json(
    db.prepare(
      `SELECT * FROM customers
        WHERE (? IS NULL OR name LIKE '%' || ? || '%' OR code LIKE '%' || ? || '%')
          AND (? = 0 OR active = 1)
        ORDER BY name`
    ).all(q, q, q, bool(req.query.active_only, true) ? 1 : 0)
  );
});

router.post('/customers', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    if (isBlank(b.name)) throw badRequest('Customer name is required');
    const code = (text(b.code) || nextCode('customers', 'CUS')).toUpperCase();
    const info = db
      .prepare(
        `INSERT INTO customers (code, name, contact_person, phone, email, trn, address,
                                payment_terms_days, notes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code, String(b.name).trim(), text(b.contact_person), text(b.phone), text(b.email),
        text(b.trn), text(b.address), Number(b.payment_terms_days || 60), text(b.notes),
        bool(b.active, true) ? 1 : 0
      );
    audit(req, { action: 'CREATE', entity: 'customer', entity_id: info.lastInsertRowid, summary: `Added customer ${b.name}` });
    res.status(201).json(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    next(err);
  }
});

router.put('/customers/:id', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Customer not found');
    db.prepare(
      `UPDATE customers SET code = ?, name = ?, contact_person = ?, phone = ?, email = ?, trn = ?,
              address = ?, payment_terms_days = ?, notes = ?, active = ? WHERE id = ?`
    ).run(
      (text(b.code) || existing.code).toUpperCase(), String(b.name || existing.name).trim(),
      text(b.contact_person), text(b.phone), text(b.email), text(b.trn), text(b.address),
      Number(b.payment_terms_days || existing.payment_terms_days), text(b.notes),
      bool(b.active, true) ? 1 : 0, existing.id
    );
    audit(req, { action: 'UPDATE', entity: 'customer', entity_id: existing.id, summary: `Updated customer ${b.name || existing.name}` });
    res.json(db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ employees

router.get('/employees', (req, res) => {
  res.json(
    db.prepare(
      `SELECT e.*, c.name AS company_name, c.code AS company_code
         FROM employees e LEFT JOIN companies c ON c.id = e.company_id
        WHERE (? = 0 OR e.active = 1) ORDER BY e.name`
    ).all(bool(req.query.active_only, true) ? 1 : 0)
  );
});

router.post('/employees', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    if (isBlank(b.name)) throw badRequest('Employee name is required');
    const code = (text(b.code) || nextCode('employees', 'EMP')).toUpperCase();
    const info = db
      .prepare(
        `INSERT INTO employees (code, name, designation, department, company_id, phone, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code, String(b.name).trim(), text(b.designation), text(b.department),
        b.company_id ? Number(b.company_id) : null, text(b.phone), bool(b.active, true) ? 1 : 0
      );
    audit(req, { action: 'CREATE', entity: 'employee', entity_id: info.lastInsertRowid, summary: `Added employee ${b.name}` });
    res.status(201).json(db.prepare('SELECT * FROM employees WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    next(err);
  }
});

router.put('/employees/:id', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const existing = db.prepare('SELECT * FROM employees WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Employee not found');
    db.prepare(
      `UPDATE employees SET code = ?, name = ?, designation = ?, department = ?, company_id = ?,
              phone = ?, active = ? WHERE id = ?`
    ).run(
      (text(b.code) || existing.code).toUpperCase(), String(b.name || existing.name).trim(),
      text(b.designation), text(b.department), b.company_id ? Number(b.company_id) : null,
      text(b.phone), bool(b.active, true) ? 1 : 0, existing.id
    );
    audit(req, { action: 'UPDATE', entity: 'employee', entity_id: existing.id, summary: `Updated employee ${b.name || existing.name}` });
    res.json(db.prepare('SELECT * FROM employees WHERE id = ?').get(existing.id));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ categories

router.get('/categories', (req, res) => {
  const kind = text(req.query.kind);
  res.json(
    db.prepare(
      `SELECT * FROM categories WHERE (? IS NULL OR kind = ?) AND active = 1 ORDER BY kind, name`
    ).all(kind, kind)
  );
});

router.post('/categories', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    if (isBlank(b.name) || isBlank(b.kind)) throw badRequest('Category name and kind are required');
    const info = db.prepare('INSERT INTO categories (name, kind, active) VALUES (?, ?, 1)')
      .run(String(b.name).trim(), String(b.kind).trim().toUpperCase());
    audit(req, { action: 'CREATE', entity: 'category', entity_id: info.lastInsertRowid, summary: `Added category ${b.name}` });
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    next(err);
  }
});

router.delete('/categories/:id', requirePermission('master.edit'), (req, res, next) => {
  try {
    db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(req.params.id);
    audit(req, { action: 'DELETE', entity: 'category', entity_id: Number(req.params.id), summary: 'Removed a category' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ bank accounts

router.get('/bank-accounts', (req, res) => {
  const ids = req.companyIds;
  res.json(
    db.prepare(
      `SELECT b.*, c.name AS company_name, c.code AS company_code
         FROM bank_accounts b JOIN companies c ON c.id = b.company_id
        WHERE b.company_id IN (${ids.map(() => '?').join(',') || '-1'})
          AND (? = 0 OR b.active = 1)
        ORDER BY c.name, b.bank_name`
    ).all(...ids, bool(req.query.active_only, true) ? 1 : 0)
  );
});

router.post('/bank-accounts', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const companyId = assertCompanyAccess(req, b.company_id);
    if (isBlank(b.bank_name)) throw badRequest('Bank name is required');
    const info = db
      .prepare(
        `INSERT INTO bank_accounts (company_id, bank_name, account_name, account_no, iban, currency, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        companyId, String(b.bank_name).trim(), text(b.account_name), text(b.account_no), text(b.iban),
        text(b.currency) || process.env.DEFAULT_CURRENCY || 'AED', bool(b.active, true) ? 1 : 0
      );
    audit(req, { action: 'CREATE', entity: 'bank_account', entity_id: info.lastInsertRowid, summary: `Added bank account ${b.bank_name}` });
    res.status(201).json(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(info.lastInsertRowid));
  } catch (err) {
    next(err);
  }
});

router.put('/bank-accounts/:id', requirePermission('master.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const existing = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('Bank account not found');
    assertCompanyAccess(req, existing.company_id);
    db.prepare(
      `UPDATE bank_accounts SET bank_name = ?, account_name = ?, account_no = ?, iban = ?,
              currency = ?, active = ? WHERE id = ?`
    ).run(
      String(b.bank_name || existing.bank_name).trim(), text(b.account_name), text(b.account_no),
      text(b.iban), text(b.currency) || existing.currency, bool(b.active, true) ? 1 : 0, existing.id
    );
    audit(req, { action: 'UPDATE', entity: 'bank_account', entity_id: existing.id, summary: 'Updated a bank account' });
    res.json(db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(existing.id));
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------------------ users

router.get('/users', requirePermission('user.view'), (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY role, name').all();
  res.json(
    rows.map((u) => ({
      ...publicUser(u),
      active: !!u.active,
      companies: db
        .prepare(
          `SELECT c.id, c.code, c.name FROM user_companies uc
             JOIN companies c ON c.id = uc.company_id WHERE uc.user_id = ? ORDER BY c.name`
        )
        .all(u.id)
    }))
  );
});

router.post('/users', requirePermission('user.edit'), (req, res, next) => {
  try {
    const b = req.body;
    if (isBlank(b.name) || isBlank(b.email) || isBlank(b.password)) {
      throw badRequest('Name, email and a starting password are required');
    }
    if (String(b.password).length < 8) throw badRequest('The password must be at least 8 characters');
    if (!ROLES[b.role]) throw badRequest('Choose a valid role');
    const info = db
      .prepare(
        `INSERT INTO users (name, username, email, password_hash, role, phone, active, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        String(b.name).trim(), text(b.username), String(b.email).trim().toLowerCase(),
        hashPassword(b.password), b.role, text(b.phone), bool(b.active, true) ? 1 : 0
      );
    setUserCompanies(info.lastInsertRowid, b.company_ids);
    audit(req, { action: 'CREATE', entity: 'user', entity_id: info.lastInsertRowid, summary: `Added user ${b.name} (${ROLES[b.role]})` });
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)));
  } catch (err) {
    next(err);
  }
});

router.put('/users/:id', requirePermission('user.edit'), (req, res, next) => {
  try {
    const b = req.body;
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!existing) throw notFound('User not found');
    if (b.role && !ROLES[b.role]) throw badRequest('Choose a valid role');

    // Do not let the last owner be demoted or switched off - somebody has to approve.
    const owners = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'OWNER' AND active = 1").get().c;
    const losingOwner = existing.role === 'OWNER' &&
      ((b.role && b.role !== 'OWNER') || bool(b.active, true) === false);
    if (losingOwner && owners <= 1) {
      throw badRequest('This is the only active owner - add another owner first');
    }

    db.prepare(
      'UPDATE users SET name = ?, username = ?, email = ?, role = ?, phone = ?, active = ? WHERE id = ?'
    ).run(
      String(b.name || existing.name).trim(),
      b.username === undefined ? existing.username : text(b.username),
      String(b.email || existing.email).trim().toLowerCase(),
      b.role || existing.role, text(b.phone), bool(b.active, true) ? 1 : 0, existing.id
    );
    if (!isBlank(b.password)) {
      if (String(b.password).length < 8) throw badRequest('The password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?')
        .run(hashPassword(b.password), existing.id);
    }
    if (b.company_ids !== undefined) setUserCompanies(existing.id, b.company_ids);
    audit(req, { action: 'UPDATE', entity: 'user', entity_id: existing.id, summary: `Updated user ${b.name || existing.name}` });
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(existing.id)));
  } catch (err) {
    next(err);
  }
});

function setUserCompanies(userId, companyIds) {
  db.prepare('DELETE FROM user_companies WHERE user_id = ?').run(userId);
  if (!Array.isArray(companyIds)) return;
  const ins = db.prepare('INSERT OR IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)');
  companyIds.forEach((cid) => ins.run(userId, Number(cid)));
}

/** Auto code like SUP0007 when the user does not type one. */
function nextCode(table, prefix) {
  const n = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c + 1;
  let code = `${prefix}${String(n).padStart(4, '0')}`;
  let i = n;
  while (db.prepare(`SELECT 1 FROM ${table} WHERE code = ?`).get(code)) {
    i += 1;
    code = `${prefix}${String(i).padStart(4, '0')}`;
  }
  return code;
}

module.exports = router;
