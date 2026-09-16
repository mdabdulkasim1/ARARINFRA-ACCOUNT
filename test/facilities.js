'use strict';

/**
 * Checks for the monthly payments view and the bank facilities behind it:
 *
 *   - a vehicle loan needs a plate number, and builds its own instalment schedule
 *   - an instalment dated the 31st lands on the last day of a short month
 *   - an LC falls due once, on its maturity date
 *   - the monthly view adds up invoices, PDC, STL, EMI and LC for one month
 *   - money already covered by a cheque is not asked for twice
 *   - a transfer has to say which of our banks it came out of
 *
 * Run with:  npm run test:facilities
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arar-fac-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_FILE = path.join(tmpDir, 'test.db');
process.env.JWT_SECRET = 'facilities-test-secret';
process.env.AUTO_BOOTSTRAP = 'false';
process.env.DEFAULT_CURRENCY = 'AED';

const app = require('../src/server');
const { db } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { money } = require('../src/util');

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
  const call = async function call(method, url, body) {
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
    const t = await res.text();
    let data;
    try { data = t ? JSON.parse(t) : null; } catch { data = t; }
    return { status: res.status, data };
  };
  // Uploads go out as a raw body rather than JSON, so they need the session too.
  call.cookie = () => cookie;
  return call;
}

function seed() {
  db.prepare("INSERT INTO companies (code, name, currency) VALUES ('TST', 'Test Company', 'AED')").run();
  [['Owner', 'owner@t.local', 'OWNER'],
   ['Finance', 'finance@t.local', 'FINANCE_MANAGER'],
   ['Acc', 'acc@t.local', 'ACCOUNTANT']].forEach(([n, e, r]) => {
    db.prepare('INSERT INTO users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)')
      .run(n, e, hashPassword('Password@123'), r);
  });
  db.prepare('INSERT INTO user_companies (user_id, company_id) SELECT id, 1 FROM users').run();
  db.prepare("INSERT INTO suppliers (code, name, bank_name, payment_terms_days) VALUES ('S1', 'Test Supplier', 'ADCB', 90)").run();
  db.prepare("INSERT INTO bank_accounts (company_id, bank_name, account_name, currency) VALUES (1, 'ADCB', 'Test Company', 'AED')").run();
  db.prepare("INSERT INTO bank_accounts (company_id, bank_name, account_name, currency) VALUES (1, 'Emirates NBD', 'Test Company', 'AED')").run();
}

async function main() {
  seed();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = client();
  const acc = client();
  await owner('POST', '/api/auth/login', { email: 'owner@t.local', password: 'Password@123' });
  await acc('POST', '/api/auth/login', { email: 'acc@t.local', password: 'Password@123' });

  // ---------------------------------------------------------------- vehicle loans

  let loanId;
  await check('a vehicle loan must carry the vehicle number', async () => {
    const r = await owner('POST', '/api/facilities', {
      company_id: 1, type: 'VEHICLE_LOAN', bank_name: 'ADCB',
      emi_amount: 2500, start_date: '2026-01-05', end_date: '2026-12-05', due_day: 5
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /vehicle number/i);
  });

  await check('a vehicle loan builds its own monthly schedule', async () => {
    const r = await owner('POST', '/api/facilities', {
      company_id: 1, type: 'VEHICLE_LOAN', vehicle_no: 'DXB-A-12345',
      bank_account_id: 1, reference: 'VL-99',
      emi_amount: 2500, start_date: '2026-01-05', end_date: '2026-12-05', due_day: 5
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    loanId = r.data.id;
    assert.strictEqual(r.data.instalments, 12, 'expected twelve instalments');
    assert.strictEqual(r.data.scheduled_total, 30000);
    assert.strictEqual(r.data.remaining_total, 30000);
    assert.strictEqual(r.data.bank_name, 'ADCB', 'the bank should come from the chosen account');
  });

  await check('an instalment dated the 31st lands on the last day of a short month', async () => {
    const r = await owner('POST', '/api/facilities', {
      company_id: 1, type: 'EQUIPMENT_LOAN', reference: 'EQ-1', bank_name: 'ADCB',
      emi_amount: 1000, start_date: '2026-01-31', end_date: '2026-04-30', due_day: 31
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const detail = await owner('GET', `/api/facilities/${r.data.id}`);
    const dates = detail.data.dues.map((d) => d.due_date);
    assert.ok(dates.includes('2026-02-28'), `February instalment missing from ${dates.join(', ')}`);
    assert.ok(dates.includes('2026-04-30'), 'April instalment missing');
  });

  await check('a letter of credit falls due once, on its maturity date', async () => {
    const r = await owner('POST', '/api/facilities', {
      company_id: 1, type: 'LC', reference: 'LC-2026-01', bank_name: 'Emirates NBD',
      principal_amount: 75000, end_date: '2026-03-20', start_date: '2026-03-20'
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.instalments, 1);
    assert.strictEqual(r.data.remaining_total, 75000);
    assert.strictEqual(r.data.is_lc, true);
  });

  await check('an accountant can enter a facility but cannot mark one paid', async () => {
    const created = await acc('POST', '/api/facilities', {
      company_id: 1, type: 'TERM_LOAN', reference: 'TL-1', bank_name: 'ADCB',
      emi_amount: 500, start_date: '2026-01-10', end_date: '2026-03-10', due_day: 10
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.data));
    const detail = await acc('GET', `/api/facilities/${created.data.id}`);
    const due = detail.data.dues[0];
    const r = await acc('POST', `/api/facilities/dues/${due.id}/pay`, { paid_mode: 'AUTO_DEBIT' });
    assert.strictEqual(r.status, 403);
  });

  // ---------------------------------------------------------------- the monthly view

  await check('the monthly view shows the loan instalment and the LC in the right months', async () => {
    const march = await owner('GET', '/api/reports/monthly-commitments?month=2026-03');
    assert.strictEqual(march.status, 200);
    const s = march.data.sections;
    assert.strictEqual(s.emi.amount, money(2500 + 1000 + 500), 'March instalments');
    assert.strictEqual(s.lc.amount, 75000, 'the LC matures in March');

    const april = await owner('GET', '/api/reports/monthly-commitments?month=2026-04');
    assert.strictEqual(april.data.sections.lc.amount, 0, 'the LC should not repeat in April');
  });

  await check('marking an instalment paid takes it out of what is still owed', async () => {
    const detail = await owner('GET', `/api/facilities/${loanId}`);
    const march = detail.data.dues.find((d) => d.due_date === '2026-03-05');
    const before = await owner('GET', '/api/reports/monthly-commitments?month=2026-03');

    const r = await owner('POST', `/api/facilities/dues/${march.id}/pay`, {
      paid_mode: 'AUTO_DEBIT', paid_date: '2026-03-05'
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));

    const after = await owner('GET', '/api/reports/monthly-commitments?month=2026-03');
    assert.strictEqual(
      after.data.sections.emi.amount,
      money(before.data.sections.emi.amount - 2500),
      'the paid instalment should drop out of the amount still to pay'
    );
    assert.strictEqual(after.data.sections.emi.paid_amount, 2500);
  });

  // ---------------------------------------------------------------- banks on payments

  let invoiceId;
  await check('a bank transfer has to say which of our accounts it came from', async () => {
    const inv = await owner('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 1, invoice_no: 'INV-M1',
      invoice_date: '2026-02-01', submitted_date: '2026-02-01',
      payment_terms_days: 30, subtotal: 10000
    });
    assert.strictEqual(inv.status, 201, JSON.stringify(inv.data));
    invoiceId = inv.data.id;

    const r = await owner('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: '2026-02-05', amount: 1000,
      mode: 'BANK_TRANSFER', allocations: [{ invoice_id: invoiceId, amount: 1000 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /which of our bank accounts/i);
  });

  await check('naming the account lets the transfer through', async () => {
    const r = await owner('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: '2026-02-05', amount: 1000,
      mode: 'BANK_TRANSFER', from_bank_account_id: 2,
      allocations: [{ invoice_id: invoiceId, amount: 1000 }]
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.from_bank_name, 'Emirates NBD');
  });

  await check("a payment cannot be drawn on another company's account", async () => {
    db.prepare("INSERT INTO companies (code, name, currency) VALUES ('TS2', 'Other Co', 'AED')").run();
    db.prepare("INSERT INTO bank_accounts (company_id, bank_name, currency) VALUES (2, 'RAK Bank', 'AED')").run();
    const r = await owner('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: '2026-02-06', amount: 100,
      mode: 'BANK_TRANSFER', from_bank_account_id: 3,
      allocations: [{ invoice_id: invoiceId, amount: 100 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /different company/i);
  });

  // ---------------------------------------------------------------- PDC and STL

  await check('a cheque has to name the account it is drawn on', async () => {
    const r = await owner('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: '2026-02-10', amount: 4000,
      mode: 'PDC', cheque_no: '5001', cheque_date: '2026-03-15', cheque_bank_name: 'ADCB',
      allocations: [{ invoice_id: invoiceId, amount: 4000 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /drawn on/i);
  });

  await check('PDC and STL are counted separately in the same month', async () => {
    const pdc = await owner('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: '2026-02-10', amount: 4000,
      mode: 'PDC', cheque_no: '5001', cheque_date: '2026-03-15',
      from_bank_account_id: 1, cheque_bank_name: 'ADCB',
      allocations: [{ invoice_id: invoiceId, amount: 4000 }]
    });
    assert.strictEqual(pdc.status, 201, JSON.stringify(pdc.data));

    const stl = await owner('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: '2026-02-11', amount: 2000,
      mode: 'PDC', cheque_no: '5002', cheque_date: '2026-03-20',
      from_bank_account_id: 1, cheque_bank_name: 'ADCB', payment_type: 'ADVANCE'
    });
    assert.strictEqual(stl.status, 201, JSON.stringify(stl.data));
    const marked = await owner('POST', `/api/payments/${stl.data.id}/pdc-status`, { status: 'SETTLED' });
    assert.strictEqual(marked.status, 200, JSON.stringify(marked.data));

    const march = await owner('GET', '/api/reports/monthly-commitments?month=2026-03');
    assert.strictEqual(march.data.sections.pdc.amount, 4000, 'PDC total');
    assert.strictEqual(march.data.sections.stl.amount, 2000, 'STL total');
    assert.strictEqual(march.data.sections.pdc.count, 1);
    assert.strictEqual(march.data.sections.stl.count, 1);
  });

  await check('money already covered by a cheque is not asked for twice', async () => {
    // The invoice falls due in March and 4,000 of it is covered by the PDC above,
    // which the month already counts on its own.
    const march = await owner('GET', '/api/reports/monthly-commitments?month=2026-03');
    const d = march.data;
    assert.strictEqual(d.invoices_covered_by_cheques, 4000);
    assert.strictEqual(
      d.invoices_to_arrange,
      money(d.sections.supplier_invoices.amount - 4000),
      'the covered part should be taken off the invoice figure'
    );
    const expected = money(
      d.invoices_to_arrange + d.sections.pdc.amount + d.sections.stl.amount +
      d.sections.emi.amount + d.sections.lc.amount + d.sections.petty_cash.amount
    );
    assert.strictEqual(d.total, expected, 'the month total should be the parts added up');
  });

  await check('the calendar strip totals line up with the month it points at', async () => {
    const cal = await owner('GET', '/api/reports/commitment-calendar?from=2026-03-01&months=2');
    assert.strictEqual(cal.status, 200);
    const march = cal.data.months.find((m) => m.month === '2026-03');
    assert.ok(march, 'March missing from the calendar');
    assert.strictEqual(march.pdc, 4000);
    assert.strictEqual(march.stl, 2000);
    assert.strictEqual(march.pdc_count, 1);
    assert.strictEqual(march.stl_count, 1);
    assert.strictEqual(march.emi, money(1000 + 500), 'the paid instalment should be excluded');
  });

  await check('a facility with paid instalments cannot simply be deleted', async () => {
    const r = await owner('DELETE', `/api/facilities/${loanId}`);
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /already been paid/i);
  });

  await check('closing a facility stops its instalments appearing', async () => {
    const before = await owner('GET', '/api/reports/monthly-commitments?month=2026-06');
    assert.ok(before.data.sections.emi.amount > 0, 'expected June instalments to start with');
    await owner('POST', `/api/facilities/${loanId}/close`, { status: 'CLOSED' });
    const after = await owner('GET', '/api/reports/monthly-commitments?month=2026-06');
    assert.strictEqual(after.data.sections.emi.amount, 0);
  });

  // ---------------------------------------------------------------- merging suppliers

  await check('folding one supplier into another moves everything across', async () => {
    db.prepare("INSERT INTO suppliers (code, name, payment_terms_days) VALUES ('DUP', 'Test Supplier Duplicate', 30)").run();
    const dup = db.prepare("SELECT id FROM suppliers WHERE code = 'DUP'").get().id;
    db.prepare(
      `INSERT INTO purchase_invoices
         (company_id, supplier_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
          due_date, currency, subtotal, tax_amount, total_amount, status)
       VALUES (1, ?, 'DUP-1', '2026-02-01', '2026-02-01', 30, '2026-03-03', 'AED', 700, 0, 700, 'OPEN')`
    ).run(dup);

    const r = await owner('POST', '/api/suppliers/merge', {
      from_supplier_ids: [dup], into_supplier_id: 1
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.moved.invoices, 1);

    assert.strictEqual(
      db.prepare("SELECT supplier_id FROM purchase_invoices WHERE invoice_no = 'DUP-1'").get().supplier_id,
      1, 'the invoice did not move'
    );
    assert.strictEqual(
      db.prepare('SELECT active FROM suppliers WHERE id = ?').get(dup).active, 0,
      'the folded account should be switched off, not deleted'
    );
  });

  await check('a clashing invoice number is kept, not lost', async () => {
    db.prepare("INSERT INTO suppliers (code, name, payment_terms_days) VALUES ('DUP2', 'Another Duplicate', 30)").run();
    const dup = db.prepare("SELECT id FROM suppliers WHERE code = 'DUP2'").get().id;
    // Deliberately the same number as one already under supplier 1.
    db.prepare(
      `INSERT INTO purchase_invoices
         (company_id, supplier_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
          due_date, currency, subtotal, tax_amount, total_amount, status)
       VALUES (1, ?, 'INV-M1', '2026-02-01', '2026-02-01', 30, '2026-03-03', 'AED', 900, 0, 900, 'OPEN')`
    ).run(dup);

    const before = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;
    const r = await owner('POST', '/api/suppliers/merge', {
      from_supplier_ids: [dup], into_supplier_id: 1
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.moved.renamed, 1, 'the clash was not renamed');
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c, before,
      'an invoice went missing in the merge');
    assert.ok(
      db.prepare("SELECT 1 FROM purchase_invoices WHERE invoice_no = 'INV-M1 (DUP2)'").get(),
      'the clashing invoice should be kept under a distinguishable number'
    );
  });

  await check('a supplier cannot be folded into itself', async () => {
    const r = await owner('POST', '/api/suppliers/merge', {
      from_supplier_ids: [1], into_supplier_id: 1
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /into itself/i);
  });

  await check('an accountant cannot fold suppliers together', async () => {
    const r = await acc('POST', '/api/suppliers/merge', {
      from_supplier_ids: [2], into_supplier_id: 1
    });
    assert.strictEqual(r.status, 403);
  });

  await check('the bank EMI list totals the month and what has been missed', async () => {
    const r = await owner('GET', '/api/facilities?type=VEHICLE_LOAN');
    assert.strictEqual(r.status, 200);
    const t = r.data.totals;

    // Every figure the Bank EMI screen shows has to come back from the rows it
    // is showing, or the tiles and the table disagree.
    const active = r.data.rows.filter((f) => f.status === 'ACTIVE');
    assert.strictEqual(t.count, active.length);
    assert.strictEqual(
      t.monthly,
      money(active.reduce((n, f) => n + (f.is_instalment ? f.emi_amount : 0), 0))
    );
    assert.strictEqual(t.remaining, money(active.reduce((n, f) => n + f.remaining_total, 0)));
    assert.strictEqual(t.due_this_month, money(active.reduce((n, f) => n + f.due_this_month, 0)));
    assert.strictEqual(t.overdue_amount, money(active.reduce((n, f) => n + f.overdue_amount, 0)));
    assert.strictEqual(t.overdue_count, active.reduce((n, f) => n + f.overdue_instalments, 0));

    // A missed instalment is one that is due and dated before today, so what is
    // missed can never be more than what is left to pay.
    assert.ok(t.overdue_amount <= t.remaining + 0.005);
    r.data.rows.forEach((f) => {
      if (f.overdue_instalments === 0) assert.strictEqual(f.overdue_amount, 0);
      else assert.ok(f.overdue_amount > 0, `${f.vehicle_no} has a missed instalment with no amount`);
    });
  });

  await check('paying an instalment takes it out of this month and out of missed', async () => {
    const made = await owner('POST', '/api/facilities', {
      company_id: 1, type: 'VEHICLE_LOAN', vehicle_no: 'EMI-TEST-1', bank_name: 'ADCB',
      emi_amount: 1000, start_date: '2026-01-05', end_date: '2026-06-05', due_day: 5
    });
    assert.strictEqual(made.status, 201, JSON.stringify(made.data));

    const before = (await owner('GET', '/api/facilities?type=VEHICLE_LOAN')).data.totals;
    const facility = await owner('GET', `/api/facilities/${made.data.id}`);
    const due = facility.data.dues.find((d) => d.status === 'DUE');
    assert.ok(due, 'the new loan has an unpaid instalment');

    const paid = await owner('POST', `/api/facilities/dues/${due.id}/pay`, { paid_date: due.due_date });
    assert.strictEqual(paid.status, 200, JSON.stringify(paid.data));

    const after = (await owner('GET', '/api/facilities?type=VEHICLE_LOAN')).data.totals;
    assert.strictEqual(after.remaining, money(before.remaining - due.amount));
    // It only leaves this month's figure if that is the month it fell in.
    const inThisMonth = due.due_date.slice(0, 7) === new Date().toISOString().slice(0, 7);
    assert.strictEqual(after.due_this_month, money(before.due_this_month - (inThisMonth ? due.amount : 0)));
  });

  // ---------------------------------------------------------------- supplier upload

  const CSV = (rows) => Buffer.from(rows.map((r) => r.join(',')).join('\r\n'), 'utf8');

  async function upload(client, buffer, apply) {
    const res = await fetch(`${base}/api/suppliers/import${apply ? '?apply=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Cookie: client.cookie() },
      body: buffer
    });
    const t = await res.text();
    let data; try { data = t ? JSON.parse(t) : null; } catch { data = t; }
    return { status: res.status, data };
  }

  await check('a spreadsheet of suppliers is read before anything is written', async () => {
    const file = CSV([
      ['Our new suppliers', '', '', ''],
      ['', '', '', ''],
      ['Supplier Name', 'Mobile', 'Credit Period', 'Category'],
      ['NEW TRADING LLC', '050 111 2222', '60 days', 'Materials'],
      ['Test Supplier', '050 333 4444', '30', 'Materials'],
      ['', '', '', ''],
      ['ANOTHER ONE FZE', '', 'immediate', 'Service']
    ]);
    const before = (await owner('GET', '/api/suppliers?active_only=0')).data.length;

    const dry = await upload(owner, file, false);
    assert.strictEqual(dry.status, 200, JSON.stringify(dry.data));
    assert.strictEqual(dry.data.applied, false);
    assert.deepStrictEqual(dry.data.counts, { add: 2, update: 1, skip: 0 });
    // The heading is on the third line and a blank line sits in the middle, so
    // the row numbers have to be the ones the spreadsheet shows.
    assert.strictEqual(dry.data.header_row, 3);
    assert.deepStrictEqual(dry.data.rows.map((r) => r.row), [4, 5, 7]);
    assert.deepStrictEqual(dry.data.rows.map((r) => r.action), ['add', 'update', 'add']);
    // A column we do not understand is reported, never guessed at.
    assert.deepStrictEqual(dry.data.ignored, ['Category']);
    assert.deepStrictEqual(dry.data.rows.map((r) => r.terms), [60, 30, 0]);

    assert.strictEqual((await owner('GET', '/api/suppliers?active_only=0')).data.length, before,
      'a dry run writes nothing');
  });

  await check('importing adds the new ones and updates the one already on file', async () => {
    const file = CSV([
      ['Supplier Name', 'Mobile', 'Credit Period', 'Bank'],
      ['NEW TRADING LLC', '050 111 2222', '60 days', 'ADCB'],
      ['Test Supplier', '050 333 4444', '30', '']
    ]);
    const res = await upload(owner, file, true);
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    assert.strictEqual(res.data.applied, true);
    assert.deepStrictEqual(res.data.counts, { add: 1, update: 1, skip: 0 });

    const all = (await owner('GET', '/api/suppliers?active_only=0')).data;
    const added = all.find((s) => s.name === 'NEW TRADING LLC');
    assert.ok(added, 'the new supplier is there');
    assert.strictEqual(added.payment_terms_days, 60);
    assert.strictEqual(added.bank_name, 'ADCB');
    assert.ok(added.code, 'it was given a code');

    // The existing one keeps the bank it already had, because that column was
    // blank in the upload rather than absent.
    const existing = all.find((s) => s.id === 1);
    assert.strictEqual(existing.payment_terms_days, 30);
    assert.strictEqual(existing.bank_name, 'ADCB');
  });

  await check('the same supplier twice in one file is added once', async () => {
    const file = CSV([
      ['Supplier Name', 'Credit Period'],
      ['TWICE OVER LLC', '90'],
      ['TWICE OVER LLC', '90']
    ]);
    const res = await upload(owner, file, true);
    assert.deepStrictEqual(res.data.counts, { add: 1, update: 0, skip: 1 });
    assert.match(res.data.rows[1].reason, /same supplier as row 2/i);

    const all = (await owner('GET', '/api/suppliers?active_only=0')).data;
    assert.strictEqual(all.filter((s) => s.name === 'TWICE OVER LLC').length, 1);
  });

  await check('a file with no supplier name column is refused', async () => {
    const res = await upload(owner, CSV([['Amount', 'Date'], ['100', '2026-01-01']]), false);
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /supplier name/i);
  });

  await check('an empty upload is refused', async () => {
    const res = await upload(owner, Buffer.alloc(0), false);
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /no file/i);
  });

  await check('an accountant can upload, because they may already add suppliers by hand', async () => {
    const res = await upload(acc, CSV([['Supplier Name'], ['ACCOUNTANT ADDED LLC']]), true);
    assert.strictEqual(res.status, 200, JSON.stringify(res.data));
    const all = (await owner('GET', '/api/suppliers?active_only=0')).data;
    assert.ok(all.some((s) => s.name === 'ACCOUNTANT ADDED LLC'));
  });

  await check('somebody who cannot touch master data cannot upload either', async () => {
    // The upload is held to the same permission as the New supplier form, so a
    // signed-out request gets no further than one.
    const res = await fetch(`${base}/api/suppliers/import?apply=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: CSV([['Supplier Name'], ['NOBODY LLC']])
    });
    assert.strictEqual(res.status, 401);
    const all = (await owner('GET', '/api/suppliers?active_only=0')).data;
    assert.ok(!all.some((s) => s.name === 'NOBODY LLC'));
  });

  // ---------------------------------------------------------------- companies

  let spareCompanyId;
  await check('a second company can be added and then removed again while it is empty', async () => {
    const made = await owner('POST', '/api/companies', { code: 'SPR', name: 'Spare Company' });
    assert.strictEqual(made.status, 201);
    spareCompanyId = made.data.id;

    const gone = await owner('DELETE', `/api/companies/${spareCompanyId}`);
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) c FROM companies WHERE id = ?').get(spareCompanyId).c, 0
    );
  });

  await check('removing a company takes its own bank accounts with it', async () => {
    const made = await owner('POST', '/api/companies', { code: 'SP2', name: 'Spare Two' });
    const id = made.data.id;
    db.prepare(
      "INSERT INTO bank_accounts (company_id, bank_name, account_name, currency) VALUES (?, 'ADCB', 'Spare Two', 'AED')"
    ).run(id);

    const gone = await owner('DELETE', `/api/companies/${id}`);
    assert.strictEqual(gone.status, 200);
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) c FROM bank_accounts WHERE company_id = ?').get(id).c, 0
    );
  });

  await check('a company that has been traded through is not removed', async () => {
    const made = await owner('POST', '/api/companies', { code: 'SP3', name: 'Spare Three' });
    const spare = made.data.id;

    // Everything so far was entered against company 1, so it cannot go.
    const r = await owner('DELETE', '/api/companies/1');
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /still holds/i);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM companies WHERE id = 1').get().c, 1);

    const cleared = await owner('DELETE', `/api/companies/${spare}`);
    assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.data));
  });

  await check('the last company standing cannot be removed', async () => {
    // Clear out the spare companies the earlier checks left behind, so only the
    // one everything was entered against is left.
    const spares = db.prepare('SELECT id FROM companies WHERE id <> 1').all();
    for (const c of spares) {
      const gone = await owner('DELETE', `/api/companies/${c.id}`);
      assert.strictEqual(gone.status, 200, JSON.stringify(gone.data));
    }
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM companies').get().c, 1);
    const r = await owner('DELETE', '/api/companies/1');
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /only company/i);
  });

  await check('an accountant cannot remove a company', async () => {
    const made = await owner('POST', '/api/companies', { code: 'SP4', name: 'Spare Four' });
    const r = await acc('DELETE', `/api/companies/${made.data.id}`);
    assert.strictEqual(r.status, 403);
    await owner('DELETE', `/api/companies/${made.data.id}`);
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
