'use strict';

/**
 * End to end check of the rules that matter:
 *   - payment terms run from the submitted date
 *   - an overdue invoice is flagged
 *   - a PDC is a commitment until it clears, and money once it does
 *   - nobody can allocate more than an invoice owes
 *   - an advance can sit unallocated and be applied later
 *   - petty cash needs somebody other than the requester to approve
 *   - an accountant cannot approve, delete or manage users
 *
 * Run with:  npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arar-test-')), 'test.db');
process.env.DB_FILE = tmpDb;
process.env.JWT_SECRET = 'test-secret-for-the-smoke-test-only';
process.env.DEFAULT_CURRENCY = 'AED';
process.env.DEFAULT_PAYMENT_TERMS_DAYS = '90';
process.env.AUTO_BOOTSTRAP = 'false';   // this file builds its own fixtures

const app = require('../src/server');
const { db } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { addDays, today, money } = require('../src/util');

let base;
let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

/** Minimal client that keeps the session cookie, like a browser would. */
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}

function seedFixtures() {
  db.prepare("INSERT INTO companies (code, name, currency) VALUES ('TST', 'Test Company', 'AED')").run();
  db.prepare("INSERT INTO companies (code, name, currency) VALUES ('TS2', 'Second Company', 'AED')").run();
  const users = [
    ['Owner', 'owner@test.local', 'OWNER'],
    ['Finance', 'finance@test.local', 'FINANCE_MANAGER'],
    ['Acc One', 'acc1@test.local', 'ACCOUNTANT'],
    ['Acc Two', 'acc2@test.local', 'ACCOUNTANT']
  ];
  users.forEach(([name, email, role]) => {
    db.prepare(
      'INSERT INTO users (name, email, password_hash, role, active) VALUES (?, ?, ?, ?, 1)'
    ).run(name, email, hashPassword('Password@123'), role);
  });
  db.prepare('INSERT INTO user_companies (user_id, company_id) SELECT id, 1 FROM users').run();
  db.prepare('INSERT INTO user_companies (user_id, company_id) SELECT id, 2 FROM users').run();
  db.prepare(
    "INSERT INTO suppliers (code, name, bank_name, payment_terms_days) VALUES ('SUP1', 'Test Supplier', 'Emirates NBD', 90)"
  ).run();
  db.prepare(
    "INSERT INTO employees (code, name, designation, company_id) VALUES ('EMP1', 'Site Engineer', 'Engineer', 1)"
  ).run();
  db.prepare("INSERT INTO categories (name, kind) VALUES ('Materials', 'EXPENSE')").run();
  db.prepare("INSERT INTO categories (name, kind) VALUES ('Site refreshments', 'PETTY')").run();
}

async function main() {
  seedFixtures();
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const owner = client();
  const finance = client();
  const acc1 = client();
  const acc2 = client();

  await check('owner signs in', async () => {
    const r = await owner('POST', '/api/auth/login', { email: 'owner@test.local', password: 'Password@123' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.user.role, 'OWNER');
  });

  await check('a wrong password is refused', async () => {
    const r = await client()('POST', '/api/auth/login', { email: 'owner@test.local', password: 'nope' });
    assert.strictEqual(r.status, 401);
  });

  await check('the other three sign in', async () => {
    for (const [c, email] of [[finance, 'finance@test.local'], [acc1, 'acc1@test.local'], [acc2, 'acc2@test.local']]) {
      const r = await c('POST', '/api/auth/login', { email, password: 'Password@123' });
      assert.strictEqual(r.status, 200, `${email} could not sign in`);
    }
  });

  await check('an unauthenticated request is refused', async () => {
    const r = await client()('GET', '/api/purchase-invoices');
    assert.strictEqual(r.status, 401);
  });

  // ---------------------------------------------------------------- invoices

  let invoiceId;
  await check('payment terms run from the submitted date, not the invoice date', async () => {
    const invoiceDate = addDays(today(), -100);
    const submittedDate = addDays(today(), -95);
    const r = await acc1('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 1, invoice_no: 'INV-001',
      invoice_date: invoiceDate, submitted_date: submittedDate,
      payment_terms_days: 90, subtotal: 10000, tax_amount: 500
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.due_date, addDays(submittedDate, 90));
    assert.strictEqual(r.data.total_amount, 10500);
    invoiceId = r.data.id;
  });

  await check('an invoice past its due date is flagged as overdue', async () => {
    const r = await acc1('GET', `/api/purchase-invoices/${invoiceId}`);
    assert.strictEqual(r.data.is_overdue, true);
    assert.strictEqual(r.data.days_overdue, 5);
    assert.strictEqual(r.data.ageing_bucket, 'D1_30');
  });

  await check('an invoice that has not been submitted has no due date', async () => {
    const r = await acc1('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 1, invoice_no: 'INV-NOSUB',
      invoice_date: today(), payment_terms_days: 90, subtotal: 2000
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.due_date, null);
    assert.strictEqual(r.data.is_overdue, false);
  });

  await check('the same invoice number cannot be entered twice for one supplier', async () => {
    const r = await acc1('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 1, invoice_no: 'INV-001',
      invoice_date: today(), submitted_date: today(), subtotal: 100
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /already recorded/i);
  });

  await check('a submitted date before the invoice date is refused', async () => {
    const r = await acc1('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 1, invoice_no: 'INV-BAD',
      invoice_date: today(), submitted_date: addDays(today(), -5), subtotal: 100
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /cannot be before/i);
  });

  // ---------------------------------------------------------------- PDC

  let pdcId;
  await check('a PDC needs a cheque number, a cheque date and a bank', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 5000, mode: 'PDC',
      allocations: [{ invoice_id: invoiceId, amount: 5000 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /cheque number/i);
  });

  await check('a PDC is recorded and gets its own number', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 5000, mode: 'PDC',
      cheque_no: '100501', cheque_date: addDays(today(), 45), cheque_bank_name: 'Emirates NBD',
      allocations: [{ invoice_id: invoiceId, amount: 5000 }]
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.match(r.data.payment_no, /^PDC\/TST\/\d{4}\/0001$/);
    assert.strictEqual(r.data.pdc_status, 'ISSUED');
    pdcId = r.data.id;
  });

  await check('an issued cheque is a commitment, not money that has gone out', async () => {
    const r = await acc1('GET', `/api/purchase-invoices/${invoiceId}`);
    assert.strictEqual(r.data.paid_amount, 0, 'nothing should be paid yet');
    assert.strictEqual(r.data.pdc_amount, 5000, 'the cheque should show as committed');
    assert.strictEqual(r.data.outstanding, 10500, 'the supplier is still owed the full amount');
    assert.strictEqual(r.data.net_payable, 5500, 'only the uncovered part still needs arranging');
    assert.strictEqual(r.data.status, 'OPEN');
  });

  await check('clearing the cheque turns it into money paid', async () => {
    const r = await finance('POST', `/api/payments/${pdcId}/pdc-status`, {
      status: 'CLEARED', cleared_date: today()
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const inv = await acc1('GET', `/api/purchase-invoices/${invoiceId}`);
    assert.strictEqual(inv.data.paid_amount, 5000);
    assert.strictEqual(inv.data.pdc_amount, 0);
    assert.strictEqual(inv.data.outstanding, 5500);
    assert.strictEqual(inv.data.status, 'PARTIALLY_PAID');
  });

  await check('a bounced cheque puts the money back on the payable', async () => {
    await finance('POST', `/api/payments/${pdcId}/pdc-status`, { status: 'BOUNCED', reason: 'Insufficient funds' });
    const inv = await acc1('GET', `/api/purchase-invoices/${invoiceId}`);
    assert.strictEqual(inv.data.paid_amount, 0);
    assert.strictEqual(inv.data.pdc_amount, 0);
    assert.strictEqual(inv.data.outstanding, 10500);
    // put it back so the rest of the run continues from a cleared cheque
    await finance('POST', `/api/payments/${pdcId}/pdc-status`, { status: 'CLEARED', cleared_date: today() });
  });

  await check('a bounced cheque must say why', async () => {
    const r = await finance('POST', `/api/payments/${pdcId}/pdc-status`, { status: 'BOUNCED' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /reason/i);
  });

  // ---------------------------------------------------------------- allocation limits

  await check('a payment cannot settle more than the invoice still owes', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 99000, mode: 'CASH',
      allocations: [{ invoice_id: invoiceId, amount: 99000 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /only has 5500\.00 left/i);
  });

  await check('the invoice lines cannot add up to more than the payment', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 100, mode: 'CASH',
      allocations: [{ invoice_id: invoiceId, amount: 500 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /more than the payment/i);
  });

  await check('a bank transfer must name the supplier bank', async () => {
    db.prepare('UPDATE suppliers SET bank_name = NULL WHERE id = 1').run();
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 100, mode: 'BANK_TRANSFER',
      allocations: [{ invoice_id: invoiceId, amount: 100 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /bank name/i);
    db.prepare("UPDATE suppliers SET bank_name = 'Emirates NBD' WHERE id = 1").run();
  });

  await check('a bank transfer picks up the supplier bank by default', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 500, mode: 'BANK_TRANSFER',
      transfer_ref: 'UTR-TEST-1',
      allocations: [{ invoice_id: invoiceId, amount: 500 }]
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.party_bank_name, 'Emirates NBD');
  });

  await check('an invoice paid in full is marked paid', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 5000, mode: 'CASH',
      allocations: [{ invoice_id: invoiceId, amount: 5000 }]
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    const inv = await acc1('GET', `/api/purchase-invoices/${invoiceId}`);
    assert.strictEqual(inv.data.outstanding, 0);
    assert.strictEqual(inv.data.status, 'PAID');
    assert.strictEqual(inv.data.is_overdue, false, 'a settled invoice is not overdue any more');
  });

  // ---------------------------------------------------------------- advances

  let advanceId;
  let secondInvoiceId;
  await check('an advance can be paid before any invoice exists', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 20000,
      mode: 'BANK_TRANSFER', payment_type: 'ADVANCE', transfer_ref: 'UTR-ADV-1',
      narration: 'Advance before material delivery'
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.unallocated_amount, 20000);
    assert.strictEqual(r.data.is_advance, true);
    advanceId = r.data.id;
  });

  await check('a payment against an invoice must name the invoice', async () => {
    const r = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 100, mode: 'CASH'
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /or record it as an advance/i);
  });

  await check('the advance is applied to the invoice when the material arrives', async () => {
    const created = await acc1('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 1, invoice_no: 'INV-002',
      invoice_date: today(), submitted_date: today(), payment_terms_days: 90, subtotal: 30000
    });
    secondInvoiceId = created.data.id;
    const r = await acc1('POST', `/api/payments/${advanceId}/allocate`, {
      allocations: [{ invoice_id: secondInvoiceId, amount: 12000 }]
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.unallocated_amount, 8000, 'the rest of the advance stays on account');
    const inv = await acc1('GET', `/api/purchase-invoices/${secondInvoiceId}`);
    assert.strictEqual(inv.data.paid_amount, 12000);
    assert.strictEqual(inv.data.outstanding, 18000);
  });

  await check('an advance cannot be set against another supplier invoice', async () => {
    db.prepare("INSERT INTO suppliers (code, name, payment_terms_days) VALUES ('SUP2', 'Other Supplier', 60)").run();
    const other = await acc1('POST', '/api/purchase-invoices', {
      company_id: 1, supplier_id: 2, invoice_no: 'OTH-1',
      invoice_date: today(), submitted_date: today(), subtotal: 1000
    });
    const r = await acc1('POST', `/api/payments/${advanceId}/allocate`, {
      allocations: [{ invoice_id: other.data.id, amount: 500 }]
    });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /different supplier/i);
  });

  // ---------------------------------------------------------------- petty cash

  let pettyId;
  await check('an accountant raises a petty cash request for an employee', async () => {
    const r = await acc1('POST', '/api/petty-cash', {
      company_id: 1, employee_id: 1, amount: 350, category_id: 2,
      purpose: 'Site refreshments for the concrete pour', bill_ref: 'BILL-77'
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'PENDING');
    assert.strictEqual(r.data.employee_name, 'Site Engineer');
    assert.strictEqual(r.data.requested_by_name, 'Acc One');
    assert.match(r.data.request_no, /^PC\/TST\/\d{4}\/0001$/);
    pettyId = r.data.id;
  });

  await check('an accountant cannot approve a petty cash request', async () => {
    const r = await acc1('POST', `/api/petty-cash/${pettyId}/approve`, {});
    assert.strictEqual(r.status, 403);
  });

  await check('the finance manager verifies it', async () => {
    const r = await finance('POST', `/api/petty-cash/${pettyId}/verify`, { remarks: 'Bill checked' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'VERIFIED');
    assert.strictEqual(r.data.verified_by_name, 'Finance');
  });

  await check('the owner approves it', async () => {
    const r = await owner('POST', `/api/petty-cash/${pettyId}/approve`, { remarks: 'Go ahead' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'APPROVED');
    assert.strictEqual(r.data.approved_by_name, 'Owner');
  });

  await check('petty cash cannot be paid before it is approved', async () => {
    const raised = await acc1('POST', '/api/petty-cash', {
      company_id: 1, employee_id: 1, amount: 90, purpose: 'Courier charges'
    });
    const r = await finance('POST', `/api/petty-cash/${raised.data.id}/pay`, { paid_mode: 'CASH' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /approved/i);
  });

  await check('an approved request is paid out and recorded', async () => {
    const r = await finance('POST', `/api/petty-cash/${pettyId}/pay`, { paid_mode: 'CASH' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.status, 'PAID');
    assert.strictEqual(r.data.paid_date, today());
  });

  await check('nobody approves a request they raised themselves', async () => {
    const raised = await owner('POST', '/api/petty-cash', {
      company_id: 1, employee_id: 1, amount: 75, purpose: 'Owner raised this one'
    });
    const r = await owner('POST', `/api/petty-cash/${raised.data.id}/approve`, {});
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /somebody else/i);
  });

  await check('a rejection has to give a reason', async () => {
    const raised = await acc2('POST', '/api/petty-cash', {
      company_id: 1, employee_id: 1, amount: 60, purpose: 'To be rejected'
    });
    const noReason = await owner('POST', `/api/petty-cash/${raised.data.id}/reject`, {});
    assert.strictEqual(noReason.status, 400);
    const withReason = await owner('POST', `/api/petty-cash/${raised.data.id}/reject`, { reason: 'No supporting bill' });
    assert.strictEqual(withReason.status, 200);
    assert.strictEqual(withReason.data.status, 'REJECTED');
  });

  // ---------------------------------------------------------------- permissions

  await check('an accountant cannot delete a payment', async () => {
    const r = await acc1('DELETE', `/api/payments/${advanceId}`);
    assert.strictEqual(r.status, 403);
  });

  await check('an accountant cannot change a cheque status', async () => {
    const r = await acc1('POST', `/api/payments/${pdcId}/pdc-status`, { status: 'PRESENTED' });
    assert.strictEqual(r.status, 403);
  });

  await check('an accountant cannot manage users', async () => {
    const r = await acc1('GET', '/api/users');
    assert.strictEqual(r.status, 403);
  });

  await check('the finance manager cannot approve petty cash', async () => {
    const raised = await acc1('POST', '/api/petty-cash', {
      company_id: 1, employee_id: 1, amount: 40, purpose: 'Finance should not approve this'
    });
    const r = await finance('POST', `/api/petty-cash/${raised.data.id}/approve`, {});
    assert.strictEqual(r.status, 403);
  });

  await check('a company an accountant has no access to is closed off', async () => {
    db.prepare('DELETE FROM user_companies WHERE user_id = 3 AND company_id = 2').run();
    const r = await acc1('POST', '/api/purchase-invoices', {
      company_id: 2, supplier_id: 1, invoice_no: 'X-1',
      invoice_date: today(), submitted_date: today(), subtotal: 100
    });
    assert.strictEqual(r.status, 403);
  });

  await check('the last owner cannot be switched off', async () => {
    const r = await owner('PUT', '/api/users/1', { role: 'ACCOUNTANT' });
    assert.strictEqual(r.status, 400);
    assert.match(r.data.error, /only active owner/i);
  });

  // ---------------------------------------------------------------- reports

  await check('the dashboard adds up', async () => {
    const r = await owner('GET', '/api/reports/dashboard');
    assert.strictEqual(r.status, 200);
    const k = r.data.kpi;
    assert.strictEqual(k.payable_total, money(18000 + 2000 + 1000), 'open payables');
    assert.strictEqual(k.advance_unallocated, 8000, 'the unused part of the advance');
    assert.strictEqual(k.petty_awaiting_approval_count, 3, 'requests still waiting on the owner');
    assert.ok(r.data.by_company.length >= 1);
  });

  await check('the supplier ageing report splits by bucket', async () => {
    const r = await owner('GET', '/api/reports/supplier-ageing');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.rows.length >= 1);
    const total = r.data.rows.reduce((s, x) => s + x.total, 0);
    assert.strictEqual(money(total), r.data.totals.total);
  });

  await check('each bucket says how many invoices are in it and since when', async () => {
    // This is what the dashboard shows when a bar of the ageing chart is opened
    // to see which suppliers are behind it.
    const r = await owner('GET', '/api/reports/supplier-ageing');
    const buckets = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS', 'NO_DUE_DATE'];

    r.data.rows.forEach((row) => {
      const counted = buckets.reduce((n, b) => n + row.counts[b], 0);
      assert.strictEqual(counted, row.invoices, `${row.supplier_name} counts add up to its invoices`);

      buckets.forEach((b) => {
        // An empty bucket has no invoices and no date; a bucket with money in it
        // has at least one invoice behind it.
        if (row[b] > 0.005) assert.ok(row.counts[b] >= 1, `${row.supplier_name} ${b} has invoices`);
        else assert.strictEqual(row.counts[b], 0, `${row.supplier_name} ${b} is empty`);
        if (row.oldest[b]) assert.ok(row.counts[b] >= 1, `${row.supplier_name} ${b} date belongs to an invoice`);
      });

      // Nothing without a due date can carry one.
      assert.strictEqual(row.oldest.NO_DUE_DATE, null);
    });

    // The amounts in one bucket are what the dashboard's bar for it shows.
    const dash = await owner('GET', '/api/reports/dashboard');
    dash.data.ageing.forEach((bar) => {
      const amount = r.data.rows.reduce((t, row) => money(t + row[bar.bucket]), 0);
      const count = r.data.rows.reduce((t, row) => t + row.counts[bar.bucket], 0);
      assert.strictEqual(amount, bar.amount, `${bar.bucket} amount matches the chart`);
      assert.strictEqual(count, bar.count, `${bar.bucket} count matches the chart`);
    });
  });

  await check('the PDC register lists cheques still to clear', async () => {
    const created = await acc1('POST', '/api/payments', {
      company_id: 1, supplier_id: 1, payment_date: today(), amount: 3000, mode: 'PDC',
      cheque_no: '100777', cheque_date: addDays(today(), 20), cheque_bank_name: 'Mashreq Bank',
      allocations: [{ invoice_id: secondInvoiceId, amount: 3000 }]
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.data));
    const r = await owner('GET', '/api/reports/pdc-register');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.rows.some((x) => x.cheque_no === '100777'));
    assert.ok(r.data.by_bank.some((b) => b.bank === 'Mashreq Bank'));
  });

  await check('the dashboard splits the cheques out by supplier', async () => {
    const r = await owner('GET', '/api/reports/dashboard');
    const suppliers = r.data.pdc_by_supplier;
    assert.ok(suppliers.length >= 1, 'the cheques entered above are in there');

    // Same money again, this time by who holds it, so it has to come back to the
    // PDC issued figure exactly.
    const amount = suppliers.reduce((t, x) => money(t + x.amount), 0);
    const count = suppliers.reduce((t, x) => t + x.count, 0);
    assert.strictEqual(amount, r.data.kpi.pdc_outstanding_total, 'suppliers add up to PDC issued');
    assert.strictEqual(count, r.data.kpi.pdc_outstanding_count, 'cheque counts add up');

    // Largest first, one line per supplier, each with the span its cheques cover.
    const amounts = suppliers.map((x) => x.amount);
    assert.deepStrictEqual(amounts, [...amounts].sort((a, b) => b - a), 'largest first');
    assert.strictEqual(new Set(suppliers.map((x) => x.supplier_id)).size, suppliers.length);
    suppliers.forEach((x) => {
      assert.ok(x.supplier_name, 'named');
      assert.ok(x.first_cheque_date <= x.last_cheque_date, 'the span runs forwards');
    });
  });

  await check('the cheque register agrees with the dashboard on who holds what', async () => {
    const dash = await owner('GET', '/api/reports/dashboard');
    const reg = await owner('GET', '/api/reports/pdc-register');

    assert.strictEqual(reg.data.by_supplier.length, dash.data.pdc_by_supplier.length);
    assert.strictEqual(
      money(reg.data.by_supplier.reduce((t, x) => t + x.amount, 0)),
      reg.data.total,
      'the supplier split adds up to the cheques listed'
    );
    // Same top supplier, same figure, whichever screen it is read from.
    assert.strictEqual(reg.data.by_supplier[0].supplier_id, dash.data.pdc_by_supplier[0].supplier_id);
    assert.strictEqual(reg.data.by_supplier[0].amount, dash.data.pdc_by_supplier[0].amount);
  });

  await check('the dashboard splits the cheque load by the month on the cheque', async () => {
    const r = await owner('GET', '/api/reports/dashboard');
    const months = r.data.pdc_by_month;
    assert.ok(months.length >= 1, 'the cheques entered above are in there');

    // Same money as the PDC issued figure, only split by when it lands - so the
    // months have to add back up to it, or the dashboard contradicts itself.
    const amount = months.reduce((t, m) => money(t + m.amount), 0);
    const count = months.reduce((t, m) => t + m.count, 0);
    assert.strictEqual(amount, r.data.kpi.pdc_outstanding_total, 'months add up to PDC issued');
    assert.strictEqual(count, r.data.kpi.pdc_outstanding_count, 'cheque counts add up');

    // Oldest first, one row per month, and each month knows if it is already past.
    const keys = months.map((m) => m.month);
    assert.deepStrictEqual(keys, [...keys].sort(), 'months are in order');
    assert.strictEqual(new Set(keys).size, keys.length, 'one row per month');
    months.forEach((m) => {
      assert.match(m.month, /^\d{4}-\d{2}$/);
      assert.strictEqual(m.is_past, m.month < today().slice(0, 7));
    });
  });

  await check('the supplier statement reconciles', async () => {
    const r = await owner('GET', '/api/reports/supplier-statement/1');
    assert.strictEqual(r.status, 200);
    const s = r.data.summary;
    assert.strictEqual(money(s.outstanding - s.pdc_pending), s.net_payable);
    assert.strictEqual(s.unallocated_advance, 8000);
  });

  await check('every change is written to the audit trail', async () => {
    const r = await owner('GET', '/api/reports/audit?entity=petty_cash');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.some((x) => x.action === 'APPROVE'));
    assert.ok(r.data.some((x) => x.action === 'PAY'));
  });

  server.close();

  console.log('');
  if (failures.length) {
    console.log(`  ${passed} passed, ${failures.length} FAILED`);
    failures.forEach((f) => console.log(`    - ${f.name}: ${f.err.message}`));
    process.exitCode = 1;
  } else {
    console.log(`  All ${passed} checks passed.`);
  }
  try { fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true }); } catch { /* temp folder */ }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
