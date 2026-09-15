'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./db');
const { forbidden } = require('./util');

const COOKIE = 'arar_session';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s === 'change-this-to-a-long-random-secret-string') {
    // Works out of the box, but every restart logs everybody out - which is the
    // nudge to set a real secret in .env before going live.
    if (!global.__ARAR_DEV_SECRET) {
      global.__ARAR_DEV_SECRET = require('crypto').randomBytes(48).toString('hex');
      console.warn(
        '[auth] JWT_SECRET is not set in .env - using a temporary one. ' +
          'Everyone will be logged out when the server restarts.'
      );
    }
    return global.__ARAR_DEV_SECRET;
  }
  return s;
}

function sessionHours() {
  const h = Number(process.env.SESSION_HOURS || 12);
  return Number.isFinite(h) && h > 0 ? h : 12;
}

function hashPassword(plain) {
  return bcrypt.hashSync(String(plain), 10);
}

function checkPassword(plain, hash) {
  try {
    return bcrypt.compareSync(String(plain), String(hash));
  } catch {
    return false;
  }
}

function issueToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, name: user.name },
    secret(),
    { expiresIn: `${sessionHours()}h` }
  );
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionHours() * 3600 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE);
}

// ------------------------------------------------------------------ permissions

const ROLES = {
  OWNER: 'Owner',
  FINANCE_MANAGER: 'Finance Manager',
  ACCOUNTANT: 'Accountant'
};

/**
 * What each role is allowed to do.
 *
 *  - Accountants do the day to day entry: invoices, payments, petty cash requests.
 *    They cannot delete anything and cannot approve their own requests.
 *  - The finance manager does everything the accountants do, plus cheque status
 *    updates, deletions and verification of petty cash.
 *  - The owner additionally approves petty cash, manages users and companies,
 *    and can void records.
 */
const PERMISSIONS = {
  OWNER: [
    'invoice.view', 'invoice.create', 'invoice.edit', 'invoice.delete', 'invoice.hold',
    'payment.view', 'payment.create', 'payment.edit', 'payment.delete', 'payment.pdcstatus',
    'sales.view', 'sales.create', 'sales.edit', 'sales.delete',
    'receipt.view', 'receipt.create', 'receipt.edit', 'receipt.delete',
    'petty.view', 'petty.create', 'petty.verify', 'petty.approve', 'petty.pay', 'petty.delete',
    'master.view', 'master.edit',
    'company.view', 'company.edit',
    'user.view', 'user.edit',
    'report.view', 'report.group',
    'audit.view',
    'settings.edit'
  ],
  FINANCE_MANAGER: [
    'invoice.view', 'invoice.create', 'invoice.edit', 'invoice.delete', 'invoice.hold',
    'payment.view', 'payment.create', 'payment.edit', 'payment.delete', 'payment.pdcstatus',
    'sales.view', 'sales.create', 'sales.edit', 'sales.delete',
    'receipt.view', 'receipt.create', 'receipt.edit', 'receipt.delete',
    'petty.view', 'petty.create', 'petty.verify', 'petty.pay',
    'master.view', 'master.edit',
    'company.view',
    'user.view',
    'report.view', 'report.group',
    'audit.view'
  ],
  ACCOUNTANT: [
    'invoice.view', 'invoice.create', 'invoice.edit',
    'payment.view', 'payment.create', 'payment.edit',
    'sales.view', 'sales.create', 'sales.edit',
    'receipt.view', 'receipt.create', 'receipt.edit',
    'petty.view', 'petty.create',
    'master.view', 'master.edit',
    'company.view',
    'report.view'
  ]
};

function can(user, permission) {
  if (!user) return false;
  const list = PERMISSIONS[user.role] || [];
  return list.includes(permission);
}

function permissionsFor(role) {
  return PERMISSIONS[role] || [];
}

/** Company ids this user may touch. Owner and finance manager see the whole group. */
function allowedCompanyIds(user) {
  if (!user) return [];
  if (user.role === 'OWNER' || user.role === 'FINANCE_MANAGER') {
    return db.prepare('SELECT id FROM companies WHERE active = 1 ORDER BY id').all().map((r) => r.id);
  }
  const rows = db
    .prepare(
      `SELECT c.id FROM user_companies uc
       JOIN companies c ON c.id = uc.company_id AND c.active = 1
       WHERE uc.user_id = ? ORDER BY c.id`
    )
    .all(user.id);
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------------ middleware

function readToken(req) {
  if (req.cookies && req.cookies[COOKIE]) return req.cookies[COOKIE];
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

/** Populates req.user, or 401s. */
function requireAuth(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Please sign in' });
  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch {
    return res.status(401).json({ error: 'Your session has expired, please sign in again' });
  }
  const user = db
    .prepare('SELECT id, name, email, role, active, must_change_password FROM users WHERE id = ?')
    .get(payload.uid);
  if (!user || !user.active) {
    return res.status(401).json({ error: 'This account is no longer active' });
  }
  req.user = user;
  req.companyIds = allowedCompanyIds(user);
  next();
}

/** Guards a route behind one permission. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!can(req.user, permission)) {
      return next(forbidden(`Your role (${ROLES[req.user.role]}) cannot perform this action`));
    }
    next();
  };
}

/** Throws unless the user is allowed to work in this company. */
function assertCompanyAccess(req, companyId) {
  const id = Number(companyId);
  if (!req.companyIds.includes(id)) {
    throw forbidden('You do not have access to this company');
  }
  return id;
}

module.exports = {
  COOKIE,
  ROLES,
  PERMISSIONS,
  hashPassword,
  checkPassword,
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  can,
  permissionsFor,
  allowedCompanyIds,
  requireAuth,
  requirePermission,
  assertCompanyAccess
};
