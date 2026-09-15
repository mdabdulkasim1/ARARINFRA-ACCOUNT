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
const { hashPassword, checkPassword } = require('./auth');
const config = require('./config');

const COMPANIES = [
  { code: 'AIC', name: 'ARAR INFRA CONTRACTING' },
  { code: 'AIT', name: 'ARAR INFRA TRADING' },
  { code: 'AIE', name: 'ARAR INFRA ELECTROMECHANICAL' },
  { code: 'AIB', name: 'ARAR INFRA BUILDING MATERIALS' },
  { code: 'AIS', name: 'ARAR INFRA SERVICES' },
  { code: 'AIP', name: 'ARAR INFRA PROJECTS' }
];

// A username is not a secret, so it lives here. Passwords never do - they come
// from the environment, or are generated and printed once to the deploy log.
const STAFF = [
  { key: 'OWNER',       name: 'Owner',           username: 'admin',       email: 'owner@ararinfra.com',       role: 'OWNER' },
  { key: 'FINANCE',     name: 'Finance Manager', username: 'finance',     email: 'finance@ararinfra.com',     role: 'FINANCE_MANAGER' },
  { key: 'ACCOUNTANT1', name: 'Accountant One',  username: 'accountant1', email: 'accountant1@ararinfra.com', role: 'ACCOUNTANT' },
  { key: 'ACCOUNTANT2', name: 'Accountant Two',  username: 'accountant2', email: 'accountant2@ararinfra.com', role: 'ACCOUNTANT' }
];

/** The sign in name, overridable per deployment with e.g. OWNER_USERNAME. */
function usernameFor(person) {
  const supplied = (process.env[`${person.key}_USERNAME`] || '').trim();
  return supplied || person.username;
}

// The banks the group actually uses, from the purchase log. Each company gets a
// row per bank so a transfer can always say which account it came out of.
const BANKS = ['ADCB', 'Emirates NBD', 'RAK Bank'];

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

/**
 * Read a password out of the environment, forgiving the ways a value gets
 * mangled on the way into a hosting panel.
 *
 * Variables are usually handed over as `OWNER_PASSWORD=secret` lines, so the
 * whole line ends up pasted into the value box often enough to be worth
 * handling. Quotes and stray whitespace arrive the same way. Anything changed is
 * logged, because a password silently becoming something else is far worse than
 * one that simply does not work.
 */
function passwordFromEnv(key) {
  const raw = process.env[`${key}_PASSWORD`];
  if (!raw) return null;

  let value = raw.trim();
  const notes = [];

  if (value.startsWith(`${key}_PASSWORD=`)) {
    value = value.slice(`${key}_PASSWORD=`.length).trim();
    notes.push('dropped the variable name that was pasted in with it');
  }
  if (value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
       (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1);
    notes.push('removed the surrounding quotes');
  }
  if (value !== raw && !notes.length) notes.push('trimmed the spaces around it');

  if (notes.length) {
    console.warn(`  [auth] ${key}_PASSWORD: ${notes.join(', ')}.`);
  }
  if (value.length < 8) {
    console.warn(
      `  [auth] ${key}_PASSWORD is only ${value.length} character(s) - ignoring it. ` +
      'It needs at least 8.'
    );
    return null;
  }
  return value;
}

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

    const companies = db.prepare('SELECT id, name FROM companies').all();

    const insBank = db.prepare(
      `INSERT INTO bank_accounts (company_id, bank_name, account_name, currency, active)
       VALUES (?, ?, ?, ?, 1)`
    );
    companies.forEach((c) => {
      BANKS.forEach((bank) => insBank.run(c.id, bank, c.name, config.currency));
    });

    const insUser = db.prepare(
      `INSERT INTO users (name, username, email, password_hash, role, active, must_change_password)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    );
    const insAccess = db.prepare(
      'INSERT OR IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)'
    );

    STAFF.forEach((person) => {
      const email = (process.env[`${person.key}_EMAIL`] || person.email).trim().toLowerCase();
      const supplied = passwordFromEnv(person.key);
      const password = supplied || generatePassword();
      if (!supplied) generated.push({ ...person, email, password });

      const info = insUser.run(
        person.name, usernameFor(person), email, hashPassword(password), person.role,
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
      console.log(
        `  ${g.role.padEnd(16)} ${String(usernameFor(g)).padEnd(14)} ${g.email.padEnd(30)} ${g.password}`
      );
    });
    console.log('  ================================================================');
    console.log('');
  }

  return { created: true, users: STAFF.length, companies: COMPANIES.length };
}

/**
 * Apply passwords declared in the environment to accounts that already exist.
 *
 * The first-run bootstrap only fires on an empty database, so without this a
 * password set in the host's variables after the first deploy would never take
 * effect - and on a hosted box there is no terminal to run set-password in.
 *
 * Declaring a password makes it authoritative: it is reapplied on every start.
 * Remove the variable once people manage their own passwords in the app,
 * otherwise the next deploy puts the declared one back.
 */
function applyEnvPasswords() {
  const applied = [];

  // Keep the sign in names in step too, so a deployment can rename them.
  const setUsername = db.prepare(
    'UPDATE users SET username = ? WHERE lower(email) = ? AND IFNULL(username, \'\') <> ?'
  );
  STAFF.forEach((person) => {
    try { setUsername.run(usernameFor(person), person.email.toLowerCase(), usernameFor(person)); }
    catch { /* another account already uses that name; leave this one alone */ }
  });

  STAFF.forEach((person) => {
    const supplied = passwordFromEnv(person.key);
    if (!supplied) return;

    const email = (process.env[`${person.key}_EMAIL`] || person.email).trim().toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
    if (!user) return;

    // Only write when it has actually changed, so the hash is not churned on
    // every restart and "last changed" stays meaningful.
    if (checkPassword(supplied, user.password_hash)) return;

    db.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, active = 1 WHERE id = ?'
    ).run(hashPassword(supplied), user.id);
    applied.push(email);
  });

  if (applied.length) {
    console.log(`  [auth] applied the password from the environment for: ${applied.join(', ')}`);
  }
  return applied;
}

module.exports = {
  bootstrap, applyEnvPasswords, generatePassword, passwordFromEnv, usernameFor, STAFF
};
