'use strict';

/**
 * First boot on a hosted deployment.
 *
 * A fresh container has an empty database and nobody who can sign in, so this
 * creates the companies, the categories and the four staff accounts. It runs on
 * every start but only ever does something when the database has no users, so a
 * redeploy never touches live data.
 *
 * Passwords come from environment variables. Anything not supplied is generated,
 * printed once to the deploy log, and flagged so the person has to change it when
 * they first sign in. The weak demo passwords in `npm run seed` are never used
 * here - this database is reachable from the internet.
 */

const crypto = require('crypto');
const { db } = require('./db');
const { hashPassword } = require('./auth');
const config = require('./config');

const COMPANIES = [
  { code: 'AIC', name: 'ARAR INFRA CONTRACTING' },
  { code: 'AIT', name: 'ARAR INFRA TRADING' },
  { code: 'AIE', name: 'ARAR INFRA ELECTROMECHANICAL' },
  { code: 'AIB', name: 'ARAR INFRA BUILDING MATERIALS' },
  { code: 'AIS', name: 'ARAR INFRA SERVICES' },
  { code: 'AIP', name: 'ARAR INFRA PROJECTS' }
];

const STAFF = [
  { key: 'OWNER',       name: 'Owner',           email: 'owner@ararinfra.com',       role: 'OWNER' },
  { key: 'FINANCE',     name: 'Finance Manager', email: 'finance@ararinfra.com',     role: 'FINANCE_MANAGER' },
  { key: 'ACCOUNTANT1', name: 'Accountant One',  email: 'accountant1@ararinfra.com', role: 'ACCOUNTANT' },
  { key: 'ACCOUNTANT2', name: 'Accountant Two',  email: 'accountant2@ararinfra.com', role: 'ACCOUNTANT' }
];

const CATEGORIES = [
  ['Materials', 'EXPENSE'], ['Subcontractor', 'EXPENSE'], ['Equipment hire', 'EXPENSE'],
  ['Transport', 'EXPENSE'], ['Fuel', 'EXPENSE'], ['Manpower supply', 'EXPENSE'],
  ['Rent', 'EXPENSE'], ['Utilities', 'EXPENSE'], ['Government fees', 'EXPENSE'],
  ['Insurance', 'EXPENSE'], ['Professional fees', 'EXPENSE'], ['Repairs & maintenance', 'EXPENSE'],
  ['Office supplies', 'PETTY'], ['Local transport', 'PETTY'], ['Site refreshments', 'PETTY'],
  ['Courier & postage', 'PETTY'], ['Minor tools', 'PETTY'], ['Staff welfare', 'PETTY'],
  ['Parking & tolls', 'PETTY'], ['Miscellaneous', 'PETTY'],
  ['Project income', 'INCOME'], ['Material sales', 'INCOME'], ['Service income', 'INCOME'],
  ['Equipment rental income', 'INCOME'], ['Other income', 'INCOME']
];

/** Readable but strong: 4 groups of 5 from an alphabet with no lookalike characters. */
function generatePassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const pick = (n) => Array.from(crypto.randomBytes(n))
    .map((b) => alphabet[b % alphabet.length])
    .join('');
  return [pick(5), pick(5), pick(5), pick(5)].join('-');
}

function bootstrap() {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) {
    return { created: false };
  }

  const generated = [];

  db.transaction(() => {
    const insCompany = db.prepare(
      'INSERT OR IGNORE INTO companies (code, name, currency, active) VALUES (?, ?, ?, 1)'
    );
    COMPANIES.forEach((c) => insCompany.run(c.code, c.name, config.currency));

    const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, kind, active) VALUES (?, ?, 1)');
    CATEGORIES.forEach(([name, kind]) => insCat.run(name, kind));

    const companies = db.prepare('SELECT id FROM companies').all();
    const insUser = db.prepare(
      `INSERT INTO users (name, email, password_hash, role, active, must_change_password)
       VALUES (?, ?, ?, ?, 1, ?)`
    );
    const insAccess = db.prepare(
      'INSERT OR IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)'
    );

    STAFF.forEach((person) => {
      const email = (process.env[`${person.key}_EMAIL`] || person.email).trim().toLowerCase();
      const supplied = process.env[`${person.key}_PASSWORD`];
      const password = supplied && supplied.length >= 8 ? supplied : generatePassword();
      if (!supplied) generated.push({ ...person, email, password });

      const info = insUser.run(
        person.name, email, hashPassword(password), person.role,
        // A supplied password is the owner's own choice; a generated one must be changed.
        supplied ? 0 : 1
      );
      companies.forEach((c) => insAccess.run(info.lastInsertRowid, c.id));
    });
  })();

  if (generated.length) {
    console.log('');
    console.log('  ================================================================');
    console.log('  FIRST RUN - accounts created. Save these now, they are not');
    console.log('  shown again. Everyone is asked to change theirs at first sign in.');
    console.log('  ----------------------------------------------------------------');
    generated.forEach((g) => {
      console.log(`  ${g.role.padEnd(16)} ${g.email.padEnd(30)} ${g.password}`);
    });
    console.log('  ================================================================');
    console.log('');
  }

  return { created: true, users: STAFF.length, companies: COMPANIES.length };
}

module.exports = { bootstrap, generatePassword };
