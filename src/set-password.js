'use strict';

/**
 * Set or reset somebody's password from the command line.
 *
 *   npm run set-password -- owner@ararinfra.com "their new password"
 *   npm run set-password -- owner@ararinfra.com            (generates one)
 *   npm run set-password -- --list                         (who exists)
 *
 * The way back in when nobody can sign in - a forgotten owner password, or a
 * deployment whose generated passwords scrolled out of the log.
 */

require('dotenv').config();

const { db, migrate } = require('./db');
const { hashPassword } = require('./auth');
const { generatePassword } = require('./bootstrap');

migrate();

const args = process.argv.slice(2);

if (args.includes('--list') || args.length === 0) {
  const users = db.prepare(
    'SELECT name, email, role, active, last_login_at FROM users ORDER BY role, name'
  ).all();
  if (!users.length) {
    console.log('\n  There are no users yet. Start the app once, or run "npm run seed".\n');
    process.exit(0);
  }
  console.log('');
  users.forEach((u) => {
    console.log(
      `  ${u.role.padEnd(16)} ${u.email.padEnd(32)} ` +
      `${u.active ? 'active  ' : 'disabled'} ` +
      `${u.last_login_at ? `last signed in ${u.last_login_at}` : 'never signed in'}`
    );
  });
  console.log('\n  To set one:  npm run set-password -- <email> "<new password>"\n');
  process.exit(0);
}

const email = String(args[0]).trim().toLowerCase();
const supplied = args[1];
const password = supplied && supplied.length >= 8 ? supplied : generatePassword();

if (supplied && supplied.length < 8) {
  console.error('\n  That password is too short - it needs at least 8 characters.\n');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
if (!user) {
  const known = db.prepare('SELECT email FROM users ORDER BY email').all().map((u) => u.email);
  console.error(`\n  No account with the email "${email}".`);
  console.error(known.length ? `  Accounts: ${known.join(', ')}\n` : '  There are no accounts yet.\n');
  process.exit(1);
}

db.prepare(
  // They chose it themselves, so do not force another change at sign in.
  'UPDATE users SET password_hash = ?, must_change_password = ?, active = 1 WHERE id = ?'
).run(hashPassword(password), supplied ? 0 : 1, user.id);

console.log('');
console.log(`  Password set for ${user.name} (${user.role})`);
console.log(`    email     ${user.email}`);
console.log(`    password  ${password}`);
if (!supplied) console.log('    They will be asked to change it at first sign in.');
console.log('');
