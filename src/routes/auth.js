'use strict';

const express = require('express');
const { db, audit } = require('../db');
const {
  hashPassword, checkPassword, issueToken, setSessionCookie, clearSessionCookie,
  requireAuth, permissionsFor, allowedCompanyIds, ROLES
} = require('../auth');
const { badRequest, isBlank } = require('../util');

const router = express.Router();

router.post('/login', (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) throw badRequest('Enter your email and password');

    const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
    if (!user || !checkPassword(password, user.password_hash)) {
      return res.status(401).json({ error: 'Email or password is not correct' });
    }
    if (!user.active) {
      return res.status(403).json({ error: 'This account has been deactivated' });
    }

    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    setSessionCookie(res, issueToken(user));
    audit({ user, ip: req.ip }, {
      action: 'LOGIN', entity: 'user', entity_id: user.id, summary: `${user.name} signed in`
    });

    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const companies = db
    .prepare(
      `SELECT id, code, name, currency FROM companies
        WHERE id IN (${allowedCompanyIds(req.user).map(() => '?').join(',') || '-1'})
        ORDER BY name`
    )
    .all(...allowedCompanyIds(req.user));
  res.json({
    user: publicUser(user),
    companies,
    permissions: permissionsFor(user.role),
    roles: ROLES,
    group_name: process.env.GROUP_NAME || 'ARAR INFRA GROUP',
    default_currency: process.env.DEFAULT_CURRENCY || 'AED',
    default_terms: Number(process.env.DEFAULT_PAYMENT_TERMS_DAYS || 90)
  });
});

router.post('/change-password', requireAuth, (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (isBlank(new_password) || String(new_password).length < 8) {
      throw badRequest('The new password must be at least 8 characters');
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!checkPassword(current_password || '', user.password_hash)) {
      throw badRequest('Your current password is not correct');
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(hashPassword(new_password), user.id);
    audit(req, {
      action: 'CHANGE_PASSWORD', entity: 'user', entity_id: user.id,
      summary: `${user.name} changed their password`
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    role_label: ROLES[u.role],
    phone: u.phone,
    must_change_password: !!u.must_change_password,
    last_login_at: u.last_login_at
  };
}

module.exports = { router, publicUser };
