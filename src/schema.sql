-- ARAR INFRA - ACCOUNTS
-- Internal cash-out control: supplier invoices, payments (cash / bank transfer / PDC),
-- advances, income and petty cash, across the companies of one group.
--
-- Money is stored as REAL rounded to 2 decimals. Dates are stored as 'YYYY-MM-DD' text.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- organisation

CREATE TABLE IF NOT EXISTS companies (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,      -- short code used in document numbers
  name              TEXT    NOT NULL,
  legal_name        TEXT,
  trn               TEXT,                          -- tax registration number
  currency          TEXT    NOT NULL DEFAULT 'AED',
  address           TEXT,
  phone             TEXT,
  email             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  username          TEXT,                          -- short sign in name, e.g. admin
  email             TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('OWNER','FINANCE_MANAGER','ACCOUNTANT')),
  phone             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at     TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Which companies a user may work in. OWNER and FINANCE_MANAGER see every company
-- regardless of these rows; they exist mainly to scope the accountants.
CREATE TABLE IF NOT EXISTS user_companies (
  user_id           INTEGER NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, company_id)
);

-- ---------------------------------------------------------------- master data

CREATE TABLE IF NOT EXISTS suppliers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  contact_person    TEXT,
  phone             TEXT,
  email             TEXT,
  trn               TEXT,
  address           TEXT,
  -- default credit period, counted from the date we submit the invoice
  payment_terms_days INTEGER NOT NULL DEFAULT 90,
  bank_name         TEXT,                          -- the party bank, used for transfers
  bank_account_no   TEXT,
  iban              TEXT,
  notes             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  contact_person    TEXT,
  phone             TEXT,
  email             TEXT,
  trn               TEXT,
  address           TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 60,
  notes             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employees (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  designation       TEXT,
  department        TEXT,
  company_id        INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  phone             TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  kind              TEXT    NOT NULL CHECK (kind IN ('EXPENSE','PETTY','INCOME')),
  active            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (name, kind)
);

-- Our own bank accounts, the money goes out from here.
CREATE TABLE IF NOT EXISTS bank_accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_name         TEXT    NOT NULL,
  account_name      TEXT,
  account_no        TEXT,
  iban              TEXT,
  currency          TEXT    NOT NULL DEFAULT 'AED',
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------- payables

CREATE TABLE IF NOT EXISTS purchase_invoices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id),
  invoice_no        TEXT    NOT NULL,              -- the supplier's own reference number
  invoice_date      TEXT    NOT NULL,
  submitted_date    TEXT,                          -- date the invoice reached us; terms run from here
  payment_terms_days INTEGER NOT NULL DEFAULT 90,
  due_date          TEXT,                          -- submitted_date + payment_terms_days
  currency          TEXT    NOT NULL DEFAULT 'AED',
  subtotal          REAL    NOT NULL DEFAULT 0,
  tax_amount        REAL    NOT NULL DEFAULT 0,
  total_amount      REAL    NOT NULL DEFAULT 0,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  project_ref       TEXT,
  lpo_no            TEXT,
  description       TEXT,
  status            TEXT    NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','ON_HOLD','CANCELLED')),
  hold_reason       TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, supplier_id, invoice_no)
);

CREATE INDEX IF NOT EXISTS idx_pi_company   ON purchase_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_pi_supplier  ON purchase_invoices(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pi_due       ON purchase_invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_pi_status    ON purchase_invoices(status);

-- One row per money movement to a supplier. An advance is simply a payment that is
-- not (yet) fully allocated to an invoice.
CREATE TABLE IF NOT EXISTS payments (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id),
  payment_no        TEXT    NOT NULL UNIQUE,
  payment_date      TEXT    NOT NULL,
  amount            REAL    NOT NULL,
  currency          TEXT    NOT NULL DEFAULT 'AED',
  mode              TEXT    NOT NULL
                    CHECK (mode IN ('CASH','BANK_TRANSFER','PDC','CHEQUE','ONLINE','OTHER')),
  payment_type      TEXT    NOT NULL DEFAULT 'INVOICE'
                    CHECK (payment_type IN ('INVOICE','ADVANCE')),

  -- bank transfer / online details
  party_bank_name   TEXT,                          -- the supplier's bank
  party_account_no  TEXT,
  party_iban        TEXT,
  transfer_ref      TEXT,                          -- UTR / transaction reference
  from_bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,

  -- cheque / post dated cheque details
  cheque_no         TEXT,
  cheque_date       TEXT,                          -- the post dated value date
  cheque_bank_name  TEXT,                          -- bank the cheque is drawn on (ours)
  pdc_status        TEXT    DEFAULT 'ISSUED'
                    CHECK (pdc_status IN ('ISSUED','PRESENTED','CLEARED','BOUNCED','CANCELLED','REPLACED')),
  cleared_date      TEXT,
  bounce_reason     TEXT,

  status            TEXT    NOT NULL DEFAULT 'COMPLETED'
                    CHECK (status IN ('COMPLETED','PENDING','CANCELLED')),
  narration         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pay_company  ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_pay_supplier ON payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_pay_mode     ON payments(mode);
CREATE INDEX IF NOT EXISTS idx_pay_cheque   ON payments(cheque_date);

-- How much of a payment is set against which invoice. A payment may cover several
-- invoices, and an advance may be allocated later, in parts.
CREATE TABLE IF NOT EXISTS payment_allocations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id        INTEGER NOT NULL REFERENCES payments(id)          ON DELETE CASCADE,
  invoice_id        INTEGER NOT NULL REFERENCES purchase_invoices(id) ON DELETE CASCADE,
  amount            REAL    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON payment_allocations(invoice_id);

-- ---------------------------------------------------------------- receivables (income)

CREATE TABLE IF NOT EXISTS sales_invoices (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  invoice_no        TEXT    NOT NULL,
  invoice_date      TEXT    NOT NULL,
  submitted_date    TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 60,
  due_date          TEXT,
  currency          TEXT    NOT NULL DEFAULT 'AED',
  subtotal          REAL    NOT NULL DEFAULT 0,
  tax_amount        REAL    NOT NULL DEFAULT 0,
  total_amount      REAL    NOT NULL DEFAULT 0,
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  project_ref       TEXT,
  lpo_no            TEXT,
  description       TEXT,
  status            TEXT    NOT NULL DEFAULT 'OPEN'
                    CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','ON_HOLD','CANCELLED')),
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, customer_id, invoice_no)
);

CREATE INDEX IF NOT EXISTS idx_si_company  ON sales_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_si_customer ON sales_invoices(customer_id);
CREATE INDEX IF NOT EXISTS idx_si_due      ON sales_invoices(due_date);

CREATE TABLE IF NOT EXISTS receipts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  receipt_no        TEXT    NOT NULL UNIQUE,
  receipt_date      TEXT    NOT NULL,
  amount            REAL    NOT NULL,
  currency          TEXT    NOT NULL DEFAULT 'AED',
  mode              TEXT    NOT NULL
                    CHECK (mode IN ('CASH','BANK_TRANSFER','PDC','CHEQUE','ONLINE','OTHER')),
  receipt_type      TEXT    NOT NULL DEFAULT 'INVOICE'
                    CHECK (receipt_type IN ('INVOICE','ADVANCE')),
  party_bank_name   TEXT,
  transfer_ref      TEXT,
  to_bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
  cheque_no         TEXT,
  cheque_date       TEXT,
  cheque_bank_name  TEXT,
  pdc_status        TEXT    DEFAULT 'ISSUED'
                    CHECK (pdc_status IN ('ISSUED','PRESENTED','CLEARED','BOUNCED','CANCELLED','REPLACED')),
  cleared_date      TEXT,
  bounce_reason     TEXT,
  status            TEXT    NOT NULL DEFAULT 'COMPLETED'
                    CHECK (status IN ('COMPLETED','PENDING','CANCELLED')),
  narration         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS receipt_allocations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id        INTEGER NOT NULL REFERENCES receipts(id)       ON DELETE CASCADE,
  invoice_id        INTEGER NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  amount            REAL    NOT NULL,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (receipt_id, invoice_id)
);

-- ---------------------------------------------------------------- petty cash

CREATE TABLE IF NOT EXISTS petty_cash_requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  request_no        TEXT    NOT NULL UNIQUE,
  request_date      TEXT    NOT NULL,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),   -- who the cash is for
  requested_by      INTEGER NOT NULL REFERENCES users(id),       -- the accounts user who raised it
  amount            REAL    NOT NULL,
  currency          TEXT    NOT NULL DEFAULT 'AED',
  category_id       INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  purpose           TEXT    NOT NULL,
  bill_ref          TEXT,
  status            TEXT    NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING','VERIFIED','APPROVED','REJECTED','PAID','CANCELLED')),
  verified_by       INTEGER REFERENCES users(id),
  verified_at       TEXT,
  verify_remarks    TEXT,
  approved_by       INTEGER REFERENCES users(id),                -- the owner
  approved_at       TEXT,
  approve_remarks   TEXT,
  rejected_by       INTEGER REFERENCES users(id),
  rejected_at       TEXT,
  reject_reason     TEXT,
  paid_date         TEXT,
  paid_mode         TEXT    CHECK (paid_mode IS NULL OR paid_mode IN ('CASH','BANK_TRANSFER','CHEQUE','ONLINE','OTHER')),
  paid_ref          TEXT,
  paid_by           INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pc_company ON petty_cash_requests(company_id);
CREATE INDEX IF NOT EXISTS idx_pc_status  ON petty_cash_requests(status);

-- ---------------------------------------------------------------- housekeeping

CREATE TABLE IF NOT EXISTS audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           INTEGER REFERENCES users(id),
  user_name         TEXT,
  action            TEXT    NOT NULL,
  entity            TEXT    NOT NULL,
  entity_id         INTEGER,
  summary           TEXT,
  details           TEXT,
  ip                TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS settings (
  key               TEXT PRIMARY KEY,
  value             TEXT
);

-- Running counters for document numbers, one row per company/prefix/year.
CREATE TABLE IF NOT EXISTS doc_counters (
  scope             TEXT PRIMARY KEY,
  last_no           INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------- bank facilities

-- Vehicle loans, letters of credit and anything else owed to a bank on a date
-- rather than to a supplier against an invoice.
CREATE TABLE IF NOT EXISTS bank_facilities (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  type              TEXT    NOT NULL
                    CHECK (type IN ('VEHICLE_LOAN','EQUIPMENT_LOAN','TERM_LOAN','LC','TRUST_RECEIPT','OTHER')),
  reference         TEXT,                          -- loan account or LC number
  vehicle_no        TEXT,                          -- plate number, for vehicle loans
  description       TEXT,
  bank_name         TEXT    NOT NULL,
  bank_account_id   INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
  supplier_id       INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,  -- LC beneficiary
  currency          TEXT    NOT NULL DEFAULT 'AED',
  principal_amount  REAL    NOT NULL DEFAULT 0,
  emi_amount        REAL    NOT NULL DEFAULT 0,    -- the monthly instalment
  due_day           INTEGER NOT NULL DEFAULT 1,    -- day of the month it is taken
  start_date        TEXT,
  end_date          TEXT,                          -- last instalment, or LC maturity
  status            TEXT    NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','CLOSED','CANCELLED')),
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fac_company ON bank_facilities(company_id);
CREATE INDEX IF NOT EXISTS idx_fac_type    ON bank_facilities(type);

-- One row per instalment. Monthly for a loan, a single row for an LC maturity.
CREATE TABLE IF NOT EXISTS facility_dues (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  facility_id       INTEGER NOT NULL REFERENCES bank_facilities(id) ON DELETE CASCADE,
  company_id        INTEGER NOT NULL REFERENCES companies(id),
  due_date          TEXT    NOT NULL,
  amount            REAL    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'DUE'
                    CHECK (status IN ('DUE','PAID','SKIPPED')),
  paid_date         TEXT,
  paid_mode         TEXT    CHECK (paid_mode IS NULL OR paid_mode IN ('BANK_TRANSFER','CASH','CHEQUE','AUTO_DEBIT','ONLINE','OTHER')),
  paid_ref          TEXT,
  paid_by           INTEGER REFERENCES users(id),
  notes             TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (facility_id, due_date)
);

CREATE INDEX IF NOT EXISTS idx_due_month   ON facility_dues(due_date);
CREATE INDEX IF NOT EXISTS idx_due_company ON facility_dues(company_id);
