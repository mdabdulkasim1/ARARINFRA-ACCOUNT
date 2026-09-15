'use strict';

const express = require('express');
const { db, audit } = require('../db');
const { requireAuth, requirePermission, hashPassword, ROLES, assertCompanyAccess } = require('../auth');
const { publicUser } = require('./auth');
const { text, bool, badRequest, notFound, isBlank } = require('../util');
const { unallocatedAdvances } = require('../queries');

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
        `INSERT INTO users (name, email, password_hash, role, phone, active, must_change_password)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        String(b.name).trim(), String(b.email).trim().toLowerCase(), hashPassword(b.password),
        b.role, text(b.phone), bool(b.active, true) ? 1 : 0
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
      'UPDATE users SET name = ?, email = ?, role = ?, phone = ?, active = ? WHERE id = ?'
    ).run(
      String(b.name || existing.name).trim(),
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
