'use strict';

/**
 * Checks for the things that only matter once the app is hosted rather than
 * sitting on an office machine:
 *
 *   - a fresh deployment creates its own companies and staff accounts
 *   - those accounts never get the starter passwords printed in the README
 *   - a redeploy does not touch live data
 *   - the sign in form stops answering after repeated failures
 *   - the owner can take a backup and nobody else can
 *
 * Run with:  npm run test:hosted
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arar-hosted-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = path.join(tmpDir, 'test.db');
process.env.AUTO_BOOTSTRAP = 'false';       // this file calls bootstrap itself
process.env.DEFAULT_CURRENCY = 'AED';
delete process.env.JWT_SECRET;              // exercise the generated-secret path

const app = require('../src/server');
const { db } = require('../src/db');
const config = require('../src/config');
const { bootstrap, generatePassword } = require('../src/bootstrap');
const { checkPassword } = require('../src/auth');

let passed = 0;
const failures = [];
let base;

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function client() {
  let cookie = '';
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) {
      return { status: res.status, cookie, raw: Buffer.from(await res.arrayBuffer()) };
    }
    return { status: res.status, cookie, data: await res.json() };
  };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // ---------------------------------------------------------------- bootstrap

  let result;
  await check('a fresh deployment creates the companies and the staff accounts', () => {
    result = bootstrap();
    assert.strictEqual(result.created, true);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM companies').get().c, 6);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users').get().c, 4);
    assert.ok(db.prepare('SELECT COUNT(*) c FROM categories').get().c > 20);
  });

  await check('the owner account is reachable as "admin"', () => {
    const owner = db.prepare("SELECT * FROM users WHERE role = 'OWNER'").get();
    assert.strictEqual(owner.username, 'admin');
    assert.strictEqual(owner.email, 'owner@ararinfra.com');
  });

  await check('signing in works with the username as well as the email', async () => {
    const { hashPassword } = require('../src/auth');
    db.prepare("UPDATE users SET password_hash = ? WHERE role = 'OWNER'")
      .run(hashPassword('Known@Password1'));

    const byUsername = await client()('POST', '/api/auth/login', {
      email: 'admin', password: 'Known@Password1'
    });
    assert.strictEqual(byUsername.status, 200, JSON.stringify(byUsername.data));
    assert.strictEqual(byUsername.data.user.username, 'admin');

    const byEmail = await client()('POST', '/api/auth/login', {
      email: 'owner@ararinfra.com', password: 'Known@Password1'
    });
    assert.strictEqual(byEmail.status, 200, JSON.stringify(byEmail.data));

    const mixedCase = await client()('POST', '/api/auth/login', {
      email: '  ADMIN  ', password: 'Known@Password1'
    });
    assert.strictEqual(mixedCase.status, 200, 'the username should not be case sensitive');
  });

  await check('an unknown username is refused like any other bad sign in', async () => {
    const r = await client()('POST', '/api/auth/login', {
      email: 'administrator', password: 'Known@Password1'
    });
    assert.strictEqual(r.status, 401);
  });

  await check('all three roles exist, with one owner', () => {
    const roles = db.prepare('SELECT role, COUNT(*) c FROM users GROUP BY role').all();
    const byRole = Object.fromEntries(roles.map((r) => [r.role, r.c]));
    assert.strictEqual(byRole.OWNER, 1);
    assert.strictEqual(byRole.FINANCE_MANAGER, 1);
    assert.strictEqual(byRole.ACCOUNTANT, 2);
  });

  await check('every account can reach every company', () => {
    const rows = db.prepare('SELECT user_id, COUNT(*) c FROM user_companies GROUP BY user_id').all();
    assert.strictEqual(rows.length, 4);
    rows.forEach((r) => assert.strictEqual(r.c, 6));
  });

  await check('the starter passwords from the README are never used on a deployment', () => {
    const weak = ['Owner@2026', 'Finance@2026', 'Accounts@2026', 'password', 'admin'];
    const users = db.prepare('SELECT email, password_hash FROM users').all();
    users.forEach((u) => {
      weak.forEach((w) => {
        assert.ok(!checkPassword(w, u.password_hash), `${u.email} accepted the weak password ${w}`);
      });
    });
  });

  await check('a generated password has to be changed at first sign in', () => {
    const rows = db.prepare('SELECT must_change_password FROM users').all();
    rows.forEach((r) => assert.strictEqual(r.must_change_password, 1));
  });

  await check('a password pasted in with its variable name still works', () => {
    const { passwordFromEnv } = require('../src/bootstrap');
    const before = process.env.OWNER_PASSWORD;
    try {
      process.env.OWNER_PASSWORD = 'OWNER_PASSWORD=owner@123';
      assert.strictEqual(passwordFromEnv('OWNER'), 'owner@123');
      process.env.OWNER_PASSWORD = '  owner@123  ';
      assert.strictEqual(passwordFromEnv('OWNER'), 'owner@123');
      process.env.OWNER_PASSWORD = '"owner@123"';
      assert.strictEqual(passwordFromEnv('OWNER'), 'owner@123');
      process.env.OWNER_PASSWORD = 'tiny';
      assert.strictEqual(passwordFromEnv('OWNER'), null, 'a short password should be ignored');
    } finally {
      if (before === undefined) delete process.env.OWNER_PASSWORD;
      else process.env.OWNER_PASSWORD = before;
    }
  });

  await check('a password set in the environment later replaces a generated one', async () => {
    const { applyEnvPasswords } = require('../src/bootstrap');
    const before = process.env.FINANCE_PASSWORD;
    try {
      // Exactly the case a hosted deployment hits: accounts already exist with
      // generated passwords, and the variables are added afterwards.
      process.env.FINANCE_PASSWORD = 'finance@123';
      const applied = applyEnvPasswords();
      assert.ok(applied.includes('finance@ararinfra.com'), 'finance was not updated');

      const signIn = await client()('POST', '/api/auth/login', {
        email: 'finance@ararinfra.com', password: 'finance@123'
      });
      assert.strictEqual(signIn.status, 200, JSON.stringify(signIn.data));

      // Running again changes nothing, because it already matches.
      assert.strictEqual(applyEnvPasswords().length, 0, 'it rewrote a password that already matched');
    } finally {
      if (before === undefined) delete process.env.FINANCE_PASSWORD;
      else process.env.FINANCE_PASSWORD = before;
    }
  });

  await check('generated passwords are long and all different', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i += 1) {
      const p = generatePassword();
      assert.ok(p.length >= 20, `too short: ${p}`);
      assert.ok(!seen.has(p), 'generated the same password twice');
      seen.add(p);
    }
  });

  await check('a redeploy leaves the existing data alone', () => {
    db.prepare("INSERT INTO suppliers (code, name, payment_terms_days) VALUES ('KEEP', 'Real Supplier', 90)").run();
    const again = bootstrap();
    assert.strictEqual(again.created, false, 'bootstrap ran a second time');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM users').get().c, 4);
    assert.strictEqual(db.prepare("SELECT COUNT(*) c FROM suppliers WHERE code = 'KEEP'").get().c, 1);
  });

  // ---------------------------------------------------------------- storage

  await check('the database sits in the data directory, not next to the code', () => {
    assert.ok(config.dbFile.startsWith(tmpDir), `${config.dbFile} is outside ${tmpDir}`);
    assert.ok(fs.existsSync(config.dbFile));
  });

  await check('a session secret is generated and kept, so a restart does not sign everyone out', () => {
    const secretFile = path.join(config.dataDir, '.session-secret');
    const first = config.sessionSecret();
    assert.ok(fs.existsSync(secretFile), 'the secret was not written to the data directory');
    assert.ok(first.length >= 32);
    assert.strictEqual(fs.readFileSync(secretFile, 'utf8').trim(), first);
  });

  // ---------------------------------------------------------------- sign in

  await check('the health check answers without a login, so the host can probe it', async () => {
    const r = await client()('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
  });

  await check('a wrong password does not reveal whether the email exists', async () => {
    const real = await client()('POST', '/api/auth/login', { email: 'finance@ararinfra.com', password: 'nope' });
    const fake = await client()('POST', '/api/auth/login', { email: 'ghost@nowhere.com', password: 'nope' });
    assert.strictEqual(real.status, 401);
    assert.strictEqual(real.data.error, fake.data.error);
  });

  await check('repeated failures stop the sign in form answering', async () => {
    const guess = client();
    let blocked = null;
    for (let i = 0; i < 14; i += 1) {
      const r = await guess('POST', '/api/auth/login', {
        email: 'target@ararinfra.com', password: `wrong-${i}`
      });
      if (r.status === 429) { blocked = i; break; }
      assert.strictEqual(r.status, 401);
    }
    assert.ok(blocked !== null, 'never blocked after 14 wrong passwords');
    assert.ok(blocked <= 11, `took ${blocked} attempts to block`);
  });

  // ---------------------------------------------------------------- backup

  // Give these two a known password so the rest of the run can sign in.
  const { hashPassword } = require('../src/auth');
  db.prepare("UPDATE users SET password_hash = ? WHERE role = 'OWNER'").run(hashPassword('Known@Password1'));
  db.prepare("UPDATE users SET password_hash = ? WHERE role = 'ACCOUNTANT'").run(hashPassword('Known@Password1'));

  const owner = client();
  const accountant = client();
  // The raw-body restore calls go through fetch directly, so the cookies the
  // clients picked up at sign in have to be reachable.
  let ownerCookieValue = '';
  let accountantCookieValue = '';
  const ownerCookie = () => ownerCookieValue;
  const accountantCookie = () => accountantCookieValue;

  await check('locking one account does not lock out everybody else on the same connection', async () => {
    // The whole office shares one public address, so this is the case that
    // matters: somebody guessing at one account must not stop the rest working.
    const stillBlocked = await client()('POST', '/api/auth/login', {
      email: 'target@ararinfra.com', password: 'wrong-again'
    });
    assert.strictEqual(stillBlocked.status, 429, 'the guessed account should still be blocked');

    const r = await owner('POST', '/api/auth/login', {
      email: 'owner@ararinfra.com', password: 'Known@Password1'
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    ownerCookieValue = r.cookie;
  });

  await check('the owner can download a backup of the whole database', async () => {
    const r = await owner('GET', '/api/admin/backup');
    assert.strictEqual(r.status, 200);
    assert.ok(r.raw && r.raw.length > 1000, `backup was only ${r.raw ? r.raw.length : 0} bytes`);
    assert.strictEqual(r.raw.slice(0, 15).toString('utf8'), 'SQLite format 3');
  });

  await check('the backup is recorded in the audit trail', () => {
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'BACKUP' ORDER BY id DESC").get();
    assert.ok(row, 'no backup entry was written');
    assert.match(row.summary, /downloaded a database backup/);
  });

  await check('an accountant cannot download the database', async () => {
    const login = await accountant('POST', '/api/auth/login', {
      email: 'accountant1@ararinfra.com', password: 'Known@Password1'
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.data));
    accountantCookieValue = login.cookie;
    const r = await accountant('GET', '/api/admin/backup');
    assert.strictEqual(r.status, 403);
  });

  // ---------------------------------------------------------------- restore

  await check('a file that is not a database is refused', async () => {
    const res = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: ownerCookie() },
      body: Buffer.from('this is definitely not a database')
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /not a database file/i);
  });

  await check('restoring a backup replaces what is in the app', async () => {
    // Build a backup that holds one recognisable invoice.
    const fixture = path.join(tmpDir, 'fixture.db');
    db.prepare('VACUUM INTO ?').run(fixture);
    const src = new (require('better-sqlite3'))(fixture);
    src.prepare(
      "INSERT INTO suppliers (code, name, payment_terms_days) VALUES ('RST', 'Restored Supplier', 60)"
    ).run();
    const supplierId = src.prepare("SELECT id FROM suppliers WHERE code = 'RST'").get().id;
    const companyId = src.prepare('SELECT id FROM companies ORDER BY id').get().id;
    src.prepare(
      `INSERT INTO purchase_invoices
         (company_id, supplier_id, invoice_no, invoice_date, submitted_date,
          payment_terms_days, due_date, currency, subtotal, tax_amount, total_amount, status)
       VALUES (?, ?, 'RESTORED-1', '2026-01-01', '2026-01-01', 60, '2026-03-02', 'AED', 500, 0, 500, 'OPEN')`
    ).run(companyId, supplierId);
    src.close();

    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM purchase_invoices WHERE invoice_no = 'RESTORED-1'").get().c,
      0, 'the invoice should not be there before the restore'
    );

    const res = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: ownerCookie() },
      body: fs.readFileSync(fixture)
    });
    const data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.strictEqual(data.invoices_after, 1);
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM purchase_invoices WHERE invoice_no = 'RESTORED-1'").get().c,
      1, 'the restored invoice is missing'
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) c FROM suppliers WHERE code = 'RST'").get().c, 1
    );
  });

  await check('the app is still usable after a restore', async () => {
    // Accounts come across with the backup, so signing in has to still work.
    const after = client();
    const login = await after('POST', '/api/auth/login', {
      email: 'owner@ararinfra.com', password: 'Known@Password1'
    });
    assert.strictEqual(login.status, 200, JSON.stringify(login.data));
    const dash = await after('GET', '/api/reports/dashboard');
    assert.strictEqual(dash.status, 200);
    assert.ok(dash.data.kpi.payable_total >= 500);
  });

  await check('a copy of what was there is kept before the restore', () => {
    const backupDir = path.join(config.dataDir, 'backups');
    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('before-restore-'));
    assert.ok(files.length >= 1, 'no safety copy was written');
  });

  await check('the restore is recorded in the audit trail', () => {
    const row = db.prepare("SELECT * FROM audit_log WHERE action = 'RESTORE' ORDER BY id DESC").get();
    assert.ok(row, 'no restore entry was written');
    assert.match(row.summary, /restored the database/i);
  });

  await check('an accountant cannot restore the database', async () => {
    const res = await fetch(`${base}/api/admin/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: accountantCookie() },
      body: Buffer.from('SQLite format 3\u0000padding')
    });
    assert.strictEqual(res.status, 403);
  });

  await check('the owner can see whether storage will survive a redeploy', async () => {
    const r = await owner('GET', '/api/admin/system');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(typeof r.data.storage_is_persistent, 'boolean');
    assert.strictEqual(r.data.counts.companies, 6);
  });

  server.close();

  console.log('');
  if (failures.length) {
    console.log(`  ${passed} passed, ${failures.length} FAILED`);
    failures.forEach((f) => console.log(`    - ${f}`));
    process.exitCode = 1;
  } else {
    console.log(`  All ${passed} checks passed.`);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp folder */ }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
