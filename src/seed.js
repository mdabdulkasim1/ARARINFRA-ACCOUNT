'use strict';

/**
 * First-run setup.
 *
 *   npm run seed           create the company, the four users and the categories
 *   npm run seed -- --demo also load a few weeks of sample invoices, cheques and
 *                          petty cash so the dashboard has something to show
 *   npm run reset          wipe everything and start again  (asks for --force in a live db)
 */

require('dotenv').config();

const { db, migrate, nextDocNo } = require('./db');
const { hashPassword } = require('./auth');
const { generatePassword } = require('./bootstrap');
const config = require('./config');
const { money, today, addDays, computeDueDate } = require('./util');

const args = process.argv.slice(2);
const wantDemo = args.includes('--demo');
const wantReset = args.includes('--reset');
const force = args.includes('--force');

migrate();

if (wantReset) {
  const txns = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;
  if (txns > 0 && !force) {
    console.error(
      `\n  There are already ${txns} supplier invoices in this database.\n` +
      '  Add --force if you really want to erase everything:  npm run reset -- --force\n'
    );
    process.exit(1);
  }
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM payment_allocations; DELETE FROM payments; DELETE FROM purchase_invoices;
    DELETE FROM receipt_allocations; DELETE FROM receipts; DELETE FROM sales_invoices;
    DELETE FROM petty_cash_requests; DELETE FROM bank_accounts; DELETE FROM employees;
    DELETE FROM suppliers; DELETE FROM customers; DELETE FROM categories;
    DELETE FROM user_companies; DELETE FROM users; DELETE FROM companies;
    DELETE FROM audit_log; DELETE FROM doc_counters; DELETE FROM settings;
    PRAGMA foreign_keys = ON;
  `);
  console.log('  Cleared the existing data.');
}

const CURRENCY = process.env.DEFAULT_CURRENCY || 'AED';
const TERMS = Number(process.env.DEFAULT_PAYMENT_TERMS_DAYS || 90);

// ------------------------------------------------------------------ companies

// Rename this from Masters > Companies once you are in - the code appears in
// every document number, so keep it short. Add more there if the group grows.
const COMPANIES = [
  { code: 'AIC', name: 'ARAR INFRA CONTRACTING' }
];

const insCompany = db.prepare(
  'INSERT OR IGNORE INTO companies (code, name, currency, active) VALUES (?, ?, ?, 1)'
);
COMPANIES.forEach((c) => insCompany.run(c.code, c.name, CURRENCY));
const companies = db.prepare('SELECT * FROM companies ORDER BY id').all();

// ------------------------------------------------------------------ users

// These starter passwords are published in the README, which is fine on a laptop
// or an office machine and not fine on anything reachable from the internet. On a
// hosted deployment they are replaced with generated ones.
const USERS = [
  { name: 'Owner',              email: 'owner@ararinfra.com',       role: 'OWNER',           password: 'Owner@2026' },
  { name: 'Finance Manager',    email: 'finance@ararinfra.com',     role: 'FINANCE_MANAGER', password: 'Finance@2026' },
  { name: 'Accountant One',     email: 'accountant1@ararinfra.com', role: 'ACCOUNTANT',      password: 'Accounts@2026' },
  { name: 'Accountant Two',     email: 'accountant2@ararinfra.com', role: 'ACCOUNTANT',      password: 'Accounts@2026' }
];

if (config.isProduction) {
  USERS.forEach((u) => { u.password = generatePassword(); });
  console.log('');
  console.log('  This looks like a hosted deployment, so the starter passwords from the');
  console.log('  README were not used. Generated ones are printed below - save them.');
}

const insUser = db.prepare(
  `INSERT OR IGNORE INTO users (name, email, password_hash, role, active, must_change_password)
   VALUES (?, ?, ?, ?, 1, 1)`
);
const insUserCompany = db.prepare(
  'INSERT OR IGNORE INTO user_companies (user_id, company_id) VALUES (?, ?)'
);
USERS.forEach((u) => {
  insUser.run(u.name, u.email, hashPassword(u.password), u.role);
  const row = db.prepare('SELECT id FROM users WHERE email = ?').get(u.email);
  // Accountants start with access to every company; trim this in Masters > Users.
  companies.forEach((c) => insUserCompany.run(row.id, c.id));
});

// ------------------------------------------------------------------ categories

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
const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, kind, active) VALUES (?, ?, 1)');
CATEGORIES.forEach(([name, kind]) => insCat.run(name, kind));

console.log(`  Companies: ${companies.length}`);
console.log(`  Users:     ${db.prepare('SELECT COUNT(*) c FROM users').get().c}`);
console.log(`  Categories:${db.prepare('SELECT COUNT(*) c FROM categories').get().c}`);

// ------------------------------------------------------------------ demo data

if (wantDemo) {
  loadDemo();
}

function loadDemo() {
  if (db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c > 0) {
    console.log('  Sample data skipped - there are already invoices in this database.');
    return;
  }

  const SUPPLIERS = [
    ['SUP0001', 'Gulf Ready Mix LLC',            'Emirates NBD',        120],
    ['SUP0002', 'Al Manara Steel Trading',       'Abu Dhabi Commercial Bank', 90],
    ['SUP0003', 'Desert Equipment Rental',       'Mashreq Bank',        60],
    ['SUP0004', 'Sharjah Electricals FZE',       'RAK Bank',            90],
    ['SUP0005', 'Premier Manpower Services',     'Emirates Islamic',    30],
    ['SUP0006', 'Falcon Transport & Logistics',  'Dubai Islamic Bank',  45],
    ['SUP0007', 'National Cement Supplies',      'First Abu Dhabi Bank', 90],
    ['SUP0008', 'Skyline Scaffolding LLC',       'Emirates NBD',        60]
  ];
  const insSup = db.prepare(
    `INSERT INTO suppliers (code, name, bank_name, payment_terms_days, bank_account_no, active)
     VALUES (?, ?, ?, ?, ?, 1)`
  );
  SUPPLIERS.forEach(([code, name, bank, terms], i) =>
    insSup.run(code, name, bank, terms, `01${String(100000 + i * 7919).slice(0, 10)}`)
  );
  const suppliers = db.prepare('SELECT * FROM suppliers ORDER BY id').all();

  const EMPLOYEES = [
    ['EMP0001', 'Rashid Kareem', 'Site Engineer', 'Projects'],
    ['EMP0002', 'Suresh Nair', 'Storekeeper', 'Stores'],
    ['EMP0003', 'Mohammed Ali', 'Driver', 'Logistics'],
    ['EMP0004', 'Anita George', 'Admin Assistant', 'Administration'],
    ['EMP0005', 'Praveen Kumar', 'Foreman', 'Projects'],
    ['EMP0006', 'Jamal Hussain', 'Purchase Officer', 'Procurement']
  ];
  const insEmp = db.prepare(
    'INSERT INTO employees (code, name, designation, department, company_id, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  EMPLOYEES.forEach(([code, name, desig, dept], i) =>
    insEmp.run(code, name, desig, dept, companies[i % companies.length].id)
  );
  const employees = db.prepare('SELECT * FROM employees ORDER BY id').all();

  const insBank = db.prepare(
    'INSERT INTO bank_accounts (company_id, bank_name, account_name, account_no, currency, active) VALUES (?, ?, ?, ?, ?, 1)'
  );
  companies.forEach((c, i) =>
    insBank.run(c.id, ['Emirates NBD', 'Mashreq Bank', 'First Abu Dhabi Bank'][i % 3], c.name, `019${100000000 + i}`, CURRENCY)
  );
  const banks = db.prepare('SELECT * FROM bank_accounts ORDER BY id').all();

  const owner = db.prepare("SELECT id FROM users WHERE role = 'OWNER'").get();
  const fm = db.prepare("SELECT id FROM users WHERE role = 'FINANCE_MANAGER'").get();
  const accountants = db.prepare("SELECT id FROM users WHERE role = 'ACCOUNTANT' ORDER BY id").all();
  const expenseCats = db.prepare("SELECT * FROM categories WHERE kind = 'EXPENSE'").all();
  const pettyCats = db.prepare("SELECT * FROM categories WHERE kind = 'PETTY'").all();

  const insInv = db.prepare(
    `INSERT INTO purchase_invoices
       (company_id, supplier_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
        due_date, currency, subtotal, tax_amount, total_amount, category_id, project_ref,
        description, status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`
  );

  // A spread of invoices: some paid, some part paid, some comfortably overdue so the
  // red rows and the ageing report have something to show.
  let n = 0;
  const invoiceIds = [];
  for (let i = 0; i < 46; i += 1) {
    const supplier = suppliers[i % suppliers.length];
    const company = companies[i % companies.length];
    const invDate = addDays(today(), -(200 - i * 4));
    const subDate = addDays(invDate, (i % 5) + 1);
    const terms = supplier.payment_terms_days;
    const subtotal = money(4000 + ((i * 3671) % 90000));
    const tax = money(subtotal * 0.05);
    n += 1;
    const info = insInv.run(
      company.id, supplier.id, `${supplier.code.slice(3)}-INV-${1000 + n}`, invDate,
      // leave a couple unsubmitted, they are the ones with no due date yet
      i % 17 === 0 ? null : subDate,
      terms,
      i % 17 === 0 ? null : computeDueDate({ submitted_date: subDate, invoice_date: invDate, payment_terms_days: terms }),
      CURRENCY, subtotal, tax, money(subtotal + tax),
      expenseCats[i % expenseCats.length].id,
      `PRJ-${2024 + (i % 3)}-${String((i % 9) + 1).padStart(2, '0')}`,
      'Supply and delivery as per LPO',
      accountants[i % accountants.length].id, accountants[i % accountants.length].id
    );
    invoiceIds.push(info.lastInsertRowid);
  }

  const insPay = db.prepare(
    `INSERT INTO payments
       (company_id, supplier_id, payment_no, payment_date, amount, currency, mode, payment_type,
        party_bank_name, party_account_no, transfer_ref, from_bank_account_id, cheque_no,
        cheque_date, cheque_bank_name, pdc_status, status, narration, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?)`
  );
  const insAlloc = db.prepare(
    'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)'
  );

  const MODES = ['BANK_TRANSFER', 'PDC', 'PDC', 'CASH', 'BANK_TRANSFER', 'PDC'];
  invoiceIds.forEach((invId, i) => {
    if (i % 4 === 3) return;  // leave a quarter completely unpaid
    const inv = db.prepare('SELECT * FROM purchase_invoices WHERE id = ?').get(invId);
    const supplier = suppliers.find((s) => s.id === inv.supplier_id);
    const bank = banks.find((b) => b.company_id === inv.company_id);
    const mode = MODES[i % MODES.length];
    const part = i % 3 === 0 ? 0.5 : 1;          // some are part paid
    const amount = money(inv.total_amount * part);
    const payDate = addDays(inv.submitted_date || inv.invoice_date, 20 + (i % 30));
    const isCheque = mode === 'PDC';
    const chequeDate = isCheque ? addDays(payDate, 30 + (i % 90)) : null;
    // Cheques dated in the past have mostly cleared; the rest are still out there.
    const pdcStatus = isCheque ? (chequeDate < today() ? (i % 7 === 0 ? 'BOUNCED' : 'CLEARED') : 'ISSUED') : null;

    const payNo = nextDocNo(isCheque ? 'PDC' : 'PAY', companies.find((c) => c.id === inv.company_id).code, payDate);
    const info = insPay.run(
      inv.company_id, inv.supplier_id, payNo, payDate, amount, CURRENCY, mode, 'INVOICE',
      mode === 'BANK_TRANSFER' ? supplier.bank_name : null,
      mode === 'BANK_TRANSFER' ? supplier.bank_account_no : null,
      mode === 'BANK_TRANSFER' ? `UTR${900000 + i}` : null,
      bank ? bank.id : null,
      isCheque ? `${100200 + i}` : null,
      chequeDate,
      isCheque && bank ? bank.bank_name : null,
      pdcStatus,
      'Against invoice ' + inv.invoice_no,
      accountants[i % accountants.length].id, accountants[i % accountants.length].id
    );
    insAlloc.run(info.lastInsertRowid, invId, amount);
  });

  // A couple of advances paid before the material arrived, still unallocated.
  [0, 3, 5].forEach((i) => {
    const supplier = suppliers[i];
    const company = companies[i % companies.length];
    const bank = banks.find((b) => b.company_id === company.id);
    const payDate = addDays(today(), -(10 + i * 3));
    insPay.run(
      company.id, supplier.id, nextDocNo('PAY', company.code, payDate), payDate,
      money(15000 + i * 7500), CURRENCY, 'BANK_TRANSFER', 'ADVANCE',
      supplier.bank_name, supplier.bank_account_no, `UTR-ADV-${700 + i}`,
      bank ? bank.id : null, null, null, null, null,
      'Advance against upcoming material supply', fm.id, fm.id
    );
  });

  // Refresh invoice statuses now that payments exist.
  const { refreshInvoiceStatus } = require('./queries');
  invoiceIds.forEach(refreshInvoiceStatus);

  // Petty cash across the whole workflow.
  const insPetty = db.prepare(
    `INSERT INTO petty_cash_requests
       (company_id, request_no, request_date, employee_id, requested_by, amount, currency,
        category_id, purpose, bill_ref, status, verified_by, verified_at, approved_by, approved_at,
        paid_date, paid_mode, paid_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const PURPOSES = [
    'Site refreshments for the concrete pour',
    'Taxi fare for the municipality submission',
    'Courier charges for the LPO documents',
    'Purchase of hand tools for the site store',
    'Parking and Salik for the site vehicle',
    'Stationery for the site office',
    'Emergency plumbing spare for the labour camp',
    'Water and refreshments for the night shift'
  ];
  for (let i = 0; i < 18; i += 1) {
    const company = companies[i % companies.length];
    const requestDate = addDays(today(), -(i * 3));
    const status = i < 4 ? 'PENDING' : i < 7 ? 'VERIFIED' : i < 10 ? 'APPROVED' : i === 10 ? 'REJECTED' : 'PAID';
    insPetty.run(
      company.id, nextDocNo('PC', company.code, requestDate), requestDate,
      employees[i % employees.length].id, accountants[i % accountants.length].id,
      money(120 + ((i * 373) % 2400)), CURRENCY, pettyCats[i % pettyCats.length].id,
      PURPOSES[i % PURPOSES.length], `BILL-${5000 + i}`,
      status === 'REJECTED' ? 'PENDING' : status,
      ['VERIFIED', 'APPROVED', 'PAID'].includes(status) ? fm.id : null,
      ['VERIFIED', 'APPROVED', 'PAID'].includes(status) ? addDays(requestDate, 1) : null,
      ['APPROVED', 'PAID'].includes(status) ? owner.id : null,
      ['APPROVED', 'PAID'].includes(status) ? addDays(requestDate, 2) : null,
      status === 'PAID' ? addDays(requestDate, 3) : null,
      status === 'PAID' ? 'CASH' : null,
      status === 'PAID' ? accountants[i % accountants.length].id : null
    );
  }

  // Income: a few customers, invoices and receipts.
  const insCust = db.prepare(
    'INSERT INTO customers (code, name, payment_terms_days, active) VALUES (?, ?, ?, 1)'
  );
  [['CUS0001', 'Emaar Facilities', 60], ['CUS0002', 'Dubai Municipality', 90],
   ['CUS0003', 'Aldar Properties', 60], ['CUS0004', 'Private Villa Client', 30]]
    .forEach(([code, name, terms]) => insCust.run(code, name, terms));
  const customers = db.prepare('SELECT * FROM customers ORDER BY id').all();
  const incomeCats = db.prepare("SELECT * FROM categories WHERE kind = 'INCOME'").all();

  const insSales = db.prepare(
    `INSERT INTO sales_invoices
       (company_id, customer_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
        due_date, currency, subtotal, tax_amount, total_amount, category_id, description,
        status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`
  );
  const insRcp = db.prepare(
    `INSERT INTO receipts (company_id, customer_id, receipt_no, receipt_date, amount, currency,
       mode, receipt_type, party_bank_name, transfer_ref, status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'INVOICE', ?, ?, 'COMPLETED', ?, ?)`
  );
  const insRAlloc = db.prepare(
    'INSERT INTO receipt_allocations (receipt_id, invoice_id, amount) VALUES (?, ?, ?)'
  );
  const { refreshSalesInvoiceStatus } = require('./queries');

  for (let i = 0; i < 16; i += 1) {
    const company = companies[i % companies.length];
    const customer = customers[i % customers.length];
    const invDate = addDays(today(), -(150 - i * 8));
    const subDate = addDays(invDate, 2);
    const subtotal = money(30000 + ((i * 8117) % 250000));
    const tax = money(subtotal * 0.05);
    const info = insSales.run(
      company.id, customer.id, `${company.code}/SI/${2000 + i}`, invDate, subDate,
      customer.payment_terms_days,
      computeDueDate({ submitted_date: subDate, invoice_date: invDate, payment_terms_days: customer.payment_terms_days }),
      CURRENCY, subtotal, tax, money(subtotal + tax),
      incomeCats[i % incomeCats.length].id, 'Work done as per certified progress',
      accountants[i % accountants.length].id, accountants[i % accountants.length].id
    );
    if (i % 3 !== 2) {
      const inv = db.prepare('SELECT * FROM sales_invoices WHERE id = ?').get(info.lastInsertRowid);
      const amount = money(inv.total_amount * (i % 4 === 0 ? 0.6 : 1));
      const rcpDate = addDays(inv.due_date, -(i % 10));
      const r = insRcp.run(
        company.id, customer.id, nextDocNo('RCP', company.code, rcpDate), rcpDate, amount, CURRENCY,
        'BANK_TRANSFER', 'Emirates NBD', `IN-UTR-${4000 + i}`,
        accountants[i % accountants.length].id, accountants[i % accountants.length].id
      );
      insRAlloc.run(r.lastInsertRowid, inv.id, amount);
      refreshSalesInvoiceStatus(inv.id);
    }
  }

  console.log('');
  console.log('  Sample data loaded:');
  console.log(`    Suppliers          ${suppliers.length}`);
  console.log(`    Supplier invoices  ${db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c}`);
  console.log(`    Payments           ${db.prepare('SELECT COUNT(*) c FROM payments').get().c}`);
  console.log(`    Petty cash         ${db.prepare('SELECT COUNT(*) c FROM petty_cash_requests').get().c}`);
  console.log(`    Sales invoices     ${db.prepare('SELECT COUNT(*) c FROM sales_invoices').get().c}`);
}

console.log('');
console.log('  Sign in with:');
USERS.forEach((u) => {
  console.log(`    ${u.role.padEnd(16)} ${u.email.padEnd(30)} ${u.password}`);
});
console.log('');
console.log('  Change these passwords the first time you sign in.');
console.log('');
