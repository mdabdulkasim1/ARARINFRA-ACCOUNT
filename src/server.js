'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { migrate, DB_FILE, db } = require('./db');
const { requireAuth } = require('./auth');

migrate();

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
app.use('/api', require('./routes/masters'));
app.use('/api/purchase-invoices', require('./routes/purchases'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/petty-cash', require('./routes/pettycash'));
app.use('/api/reports', require('./routes/reports'));

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

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, () => {
    const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    console.log('');
    console.log('  ARAR INFRA - ACCOUNTS');
    console.log(`  running on   http://localhost:${PORT}`);
    console.log(`  database     ${DB_FILE}`);
    if (count === 0) {
      console.log('');
      console.log('  No users yet. Run:  npm run seed');
    }
    console.log('');
  });
}

module.exports = app;
