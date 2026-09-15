'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const { migrate, DB_FILE, db } = require('./db');
const { requireAuth } = require('./auth');
const { bootstrap, applyEnvPasswords } = require('./bootstrap');

migrate();

// A hosted deployment starts with an empty database and nobody who can sign in.
// This only does anything when there are no users at all.
const firstRun = config.autoBootstrap ? bootstrap() : { created: false };
if (config.autoBootstrap) applyEnvPasswords();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Modest hardening. The app is meant to sit on an internal network or behind a
// company VPN, so this is a floor rather than a full security posture.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/purchase-invoices', require('./routes/purchases'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/petty-cash', require('./routes/pettycash'));
app.use('/api/facilities', require('./routes/facilities'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'ARAR INFRA - Accounts',
    time: new Date().toISOString(),
    companies: db.prepare('SELECT COUNT(*) c FROM companies').get().c
  });
});

/** Everything the entry screens need, in one call. */
app.get('/api/bootstrap', requireAuth, (req, res) => {
  const ids = req.companyIds;
  const inList = ids.map(() => '?').join(',') || '-1';
  res.json({
    companies: db.prepare(`SELECT * FROM companies WHERE id IN (${inList}) ORDER BY name`).all(...ids),
    suppliers: db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all(),
    customers: db.prepare('SELECT * FROM customers WHERE active = 1 ORDER BY name').all(),
    employees: db.prepare('SELECT * FROM employees WHERE active = 1 ORDER BY name').all(),
    categories: db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY kind, name').all(),
    bank_accounts: db
      .prepare(`SELECT * FROM bank_accounts WHERE active = 1 AND company_id IN (${inList}) ORDER BY bank_name`)
      .all(...ids)
  });
});

// The master data router sits on the bare /api prefix, so it is mounted last:
// its blanket auth check would otherwise run for every route declared after it.
app.use('/api', require('./routes/masters'));

app.use(express.static(path.join(__dirname, '..', 'public')));

// The front end is a single page, so anything that is not an API call gets it.
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'That address does not exist' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ error: err.message || 'Something went wrong' });
});

const PORT = config.port;
if (require.main === module) {
  // 0.0.0.0 so the container's proxy can reach it; on a desktop this is localhost.
  app.listen(PORT, '0.0.0.0', () => {
    const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    console.log('');
    console.log('  ARAR INFRA - ACCOUNTS');
    console.log(`  listening on port ${PORT}`);
    console.log(`  database          ${DB_FILE}`);
    if (firstRun.created) {
      console.log(`  first run         created ${firstRun.companies} companies and ${firstRun.users} users`);
    }
    // Who can sign in, and where each password came from. Without this the only
    // way to work out why a sign in is refused is guesswork - the accounts are
    // created by the app, so nobody outside the log knows what they are.
    const accounts = db
      .prepare('SELECT email, role FROM users WHERE active = 1 ORDER BY role, email')
      .all();
    if (accounts.length) {
      console.log('');
      console.log('  Accounts that can sign in:');
      accounts.forEach((a) => {
        const key = {
          OWNER: 'OWNER',
          FINANCE_MANAGER: 'FINANCE',
          ACCOUNTANT: null
        }[a.role];
        const fromEnv = key
          ? !!process.env[`${key}_PASSWORD`]
          : !!(process.env.ACCOUNTANT1_PASSWORD || process.env.ACCOUNTANT2_PASSWORD);
        console.log(
          `    ${a.role.padEnd(16)} ${a.email.padEnd(32)} ` +
          `password ${fromEnv ? 'set from the environment' : 'generated - see the FIRST RUN box above'}`
        );
      });
    }

    if (!config.storageIsPersistent) {
      console.log('');
      console.log('  ****************************************************************');
      console.log('  WARNING: this container has no persistent volume attached.');
      console.log('  Everything entered will be LOST on the next deploy or restart.');
      console.log('  Attach a volume and set its mount path before entering real data.');
      console.log('  ****************************************************************');
    }
    if (count === 0) {
      console.log('');
      console.log('  No users yet. Run:  npm run seed');
    }
    console.log('');
  });
}

module.exports = app;
