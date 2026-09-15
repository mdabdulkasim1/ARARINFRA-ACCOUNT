'use strict';

/**
 * Schema changes that have to be applied to a database created by an earlier
 * version. `schema.sql` creates anything missing; these handle the cases it
 * cannot, such as widening a CHECK constraint on a table that already exists.
 *
 * Each migration runs once and is recorded. Add new ones to the end of the list;
 * never edit or renumber one that has shipped.
 */

/**
 * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt: make
 * the new one, copy the rows across, drop the old, rename. Foreign keys are
 * switched off for the swap and the indexes are put back afterwards.
 */
function rebuildWithNewCheck(db, table, createSql, indexes) {
  const tmp = `${table}__migrating`;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const columnList = columns.map((c) => `"${c}"`).join(', ');

  db.exec(createSql.replace(
    new RegExp(`CREATE TABLE (IF NOT EXISTS )?${table}\\b`), `CREATE TABLE ${tmp}`
  ));
  db.exec(`INSERT INTO ${tmp} (${columnList}) SELECT ${columnList} FROM ${table};`);
  db.exec(`DROP TABLE ${table};`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table};`);
  indexes.forEach((sql) => db.exec(sql));
}

const PAYMENTS_TABLE = `
CREATE TABLE payments (
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
  party_bank_name   TEXT,
  party_account_no  TEXT,
  party_iban        TEXT,
  transfer_ref      TEXT,
  from_bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE SET NULL,
  cheque_no         TEXT,
  cheque_date       TEXT,
  cheque_bank_name  TEXT,
  pdc_status        TEXT    DEFAULT 'ISSUED'
                    CHECK (pdc_status IN ('ISSUED','PRESENTED','CLEARED','SETTLED','BOUNCED','CANCELLED','REPLACED')),
  cleared_date      TEXT,
  bounce_reason     TEXT,
  status            TEXT    NOT NULL DEFAULT 'COMPLETED'
                    CHECK (status IN ('COMPLETED','PENDING','CANCELLED')),
  narration         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);`;

const PAYMENTS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_pay_company  ON payments(company_id);',
  'CREATE INDEX IF NOT EXISTS idx_pay_supplier ON payments(supplier_id);',
  'CREATE INDEX IF NOT EXISTS idx_pay_mode     ON payments(mode);',
  'CREATE INDEX IF NOT EXISTS idx_pay_cheque   ON payments(cheque_date);'
];

const RECEIPTS_TABLE = `
CREATE TABLE receipts (
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
                    CHECK (pdc_status IN ('ISSUED','PRESENTED','CLEARED','SETTLED','BOUNCED','CANCELLED','REPLACED')),
  cleared_date      TEXT,
  bounce_reason     TEXT,
  status            TEXT    NOT NULL DEFAULT 'COMPLETED'
                    CHECK (status IN ('COMPLETED','PENDING','CANCELLED')),
  narration         TEXT,
  created_by        INTEGER REFERENCES users(id),
  updated_by        INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);`;

const USERNAMES = {
  'owner@ararinfra.com': 'admin',
  'finance@ararinfra.com': 'finance',
  'accountant1@ararinfra.com': 'accountant1',
  'accountant2@ararinfra.com': 'accountant2'
};

const MIGRATIONS = [
  {
    id: '2026-09-15-usernames',
    description: 'Let people sign in with a short username as well as an email',
    up(db) {
      const columns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      if (!columns.includes('username')) {
        db.exec('ALTER TABLE users ADD COLUMN username TEXT');
      }
      // Unique, but only among the rows that have one, so accounts without a
      // username do not collide with each other.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
                 ON users(lower(username)) WHERE username IS NOT NULL`);

      const set = db.prepare('UPDATE users SET username = ? WHERE lower(email) = ? AND username IS NULL');
      Object.entries(USERNAMES).forEach(([email, username]) => set.run(username, email));
    }
  },
  {
    id: '2026-09-15-settled-cheque-status',
    description: 'Allow SETTLED (STL) as a cheque status on payments and receipts',
    up(db) {
      const needsIt = (table) => {
        const row = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table);
        return row && row.sql.includes('pdc_status') && !row.sql.includes('SETTLED');
      };
      if (needsIt('payments')) {
        rebuildWithNewCheck(db, 'payments', PAYMENTS_TABLE, PAYMENTS_INDEXES);
      }
      if (needsIt('receipts')) {
        rebuildWithNewCheck(db, 'receipts', RECEIPTS_TABLE, []);
      }
    }
  }
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id      TEXT PRIMARY KEY,
      applied TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  const applied = [];

  MIGRATIONS.forEach((m) => {
    if (done.has(m.id)) return;
    // Foreign keys must be off for a table rebuild, and PRAGMA cannot change
    // inside a transaction - so it is set around the whole migration.
    const before = db.pragma('foreign_keys', { simple: true });
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (id) VALUES (?)').run(m.id);
      })();
      applied.push(m.id);
    } finally {
      db.pragma(`foreign_keys = ${before ? 'ON' : 'OFF'}`);
    }
  });

  return applied;
}

module.exports = { runMigrations, MIGRATIONS };
