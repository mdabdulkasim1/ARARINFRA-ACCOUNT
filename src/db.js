'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const DB_FILE = config.dbFile;

config.ensureDataDir();

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Create anything that is missing, then apply pending schema changes. */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  const { runMigrations } = require('./migrations');
  const applied = runMigrations(db);
  if (applied.length) {
    console.log(`[db] applied ${applied.length} schema change(s): ${applied.join(', ')}`);
  }
}

/**
 * Next number in a series, e.g. PAY/ARIN/2026/0007.
 * The counter row and the caller's own insert share one transaction, so two
 * users saving at the same moment cannot land on the same number.
 */
function nextDocNo(prefix, companyCode, dateStr) {
  const year = String(dateStr || new Date().toISOString().slice(0, 10)).slice(0, 4);
  const scope = `${prefix}:${companyCode}:${year}`;
  db.prepare(
    'INSERT INTO doc_counters (scope, last_no) VALUES (?, 0) ON CONFLICT(scope) DO NOTHING'
  ).run(scope);
  const row = db
    .prepare('UPDATE doc_counters SET last_no = last_no + 1 WHERE scope = ? RETURNING last_no')
    .get(scope);
  return `${prefix}/${companyCode}/${year}/${String(row.last_no).padStart(4, '0')}`;
}

function getSetting(key, dflt = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : dflt;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value === null || value === undefined ? null : String(value));
}

/** Write an audit trail entry. Never throws - an audit failure must not lose the work. */
function audit(req, { action, entity, entity_id, summary, details }) {
  try {
    db.prepare(
      `INSERT INTO audit_log (user_id, user_name, action, entity, entity_id, summary, details, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      req && req.user ? req.user.id : null,
      req && req.user ? req.user.name : null,
      action,
      entity,
      entity_id === undefined ? null : entity_id,
      summary || null,
      details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
      req ? req.ip || null : null
    );
  } catch (err) {
    console.error('[audit] could not write entry:', err.message);
  }
}

module.exports = { db, DB_FILE, migrate, nextDocNo, getSetting, setSetting, audit };
