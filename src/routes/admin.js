'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const Database = require('better-sqlite3');

const { db, audit, migrate } = require('../db');
const config = require('../config');
const { requireAuth, requirePermission } = require('../auth');
const { applyEnvPasswords } = require('../bootstrap');
const { badRequest } = require('../util');

const router = express.Router();
router.use(requireAuth);

/**
 * Download the whole database as one file.
 *
 * Hosted, the data lives on a volume nobody logs into, so the owner needs a way
 * to take a copy. `VACUUM INTO` writes a clean, consistent snapshot even while
 * people are entering invoices - unlike copying the file, which can catch the
 * write-ahead log mid-flight and produce a corrupt backup.
 */
router.get('/backup', requirePermission('settings.edit'), (req, res, next) => {
  const tmp = path.join(
    os.tmpdir(),
    `arar-backup-${crypto.randomBytes(8).toString('hex')}.db`
  );
  try {
    db.prepare('VACUUM INTO ?').run(tmp);

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const filename = `arar-accounts-backup-${stamp}.db`;

    audit(req, {
      action: 'BACKUP', entity: 'database', entity_id: null,
      summary: `${req.user.name} downloaded a database backup`
    });

    res.download(tmp, filename, (err) => {
      fs.unlink(tmp, () => {});
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    fs.unlink(tmp, () => {});
    next(err);
  }
});

/**
 * Replace everything in the database with the contents of a backup file.
 *
 * Used to carry the old purchase log across after importing it elsewhere, and to
 * put a backup back after a mistake. The upload is validated before anything is
 * touched, and the current contents are saved first, so a bad file cannot leave
 * the app with nothing.
 *
 * The rows are copied in over the live connection rather than swapping the file
 * underneath it, which would leave every open handle pointing at a file that is
 * no longer there.
 */
router.post(
  '/restore',
  requirePermission('settings.edit'),
  express.raw({ type: () => true, limit: '256mb' }),
  (req, res, next) => {
    const uploaded = path.join(os.tmpdir(), `arar-restore-${crypto.randomBytes(8).toString('hex')}.db`);
    let safetyCopy = null;

    try {
      const body = req.body;
      if (!body || !body.length) throw badRequest('No file was uploaded');
      if (body.slice(0, 15).toString('utf8') !== 'SQLite format 3') {
        throw badRequest('That is not a database file. Upload a backup downloaded from this app.');
      }
      fs.writeFileSync(uploaded, body);

      // Check the upload before touching anything that matters.
      const source = new Database(uploaded, { readonly: true });
      let tables;
      try {
        tables = source
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all()
          .map((r) => r.name);
        const required = ['companies', 'users', 'suppliers', 'purchase_invoices', 'payments'];
        const missing = required.filter((t) => !tables.includes(t));
        if (missing.length) {
          throw badRequest(`That backup is missing: ${missing.join(', ')}. It is not from this app.`);
        }
        if (source.prepare('SELECT COUNT(*) c FROM companies').get().c === 0) {
          throw badRequest('That backup has no companies in it, so it would leave the app unusable.');
        }
      } finally {
        source.close();
      }

      // Keep what is there now, in case this turns out to be the wrong file.
      config.ensureDataDir();
      const backupDir = path.join(config.dataDir, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      safetyCopy = path.join(
        backupDir,
        `before-restore-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`
      );
      db.prepare('VACUUM INTO ?').run(safetyCopy);

      const before = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;

      // Copy table by table over the live connection. Foreign keys stay off for
      // the swap because the tables are emptied and refilled out of dependency
      // order; PRAGMA cannot change inside a transaction, hence the order here.
      const target = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name);
      const shared = tables.filter((t) => target.includes(t));

      db.pragma('foreign_keys = OFF');
      try {
        db.exec(`ATTACH DATABASE '${uploaded.replace(/'/g, "''")}' AS restore_src`);
        try {
          db.transaction(() => {
            shared.forEach((table) => {
              const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
              const srcColumns = db
                .prepare(`PRAGMA restore_src.table_info(${table})`)
                .all()
                .map((c) => c.name);
              // Only the columns both sides have, so a backup from an older
              // version still restores.
              const common = columns.filter((c) => srcColumns.includes(c));
              if (!common.length) return;
              const list = common.map((c) => `"${c}"`).join(', ');
              db.exec(`DELETE FROM "${table}"`);
              db.exec(`INSERT INTO "${table}" (${list}) SELECT ${list} FROM restore_src."${table}"`);
            });
          })();
        } finally {
          db.exec('DETACH DATABASE restore_src');
        }
      } finally {
        db.pragma('foreign_keys = ON');
      }

      // The backup may come from an older version, and whoever restored it still
      // has to be able to sign in afterwards.
      migrate();
      applyEnvPasswords();

      const after = db.prepare('SELECT COUNT(*) c FROM purchase_invoices').get().c;
      const counts = {};
      ['companies', 'users', 'suppliers', 'purchase_invoices', 'payments', 'bank_facilities']
        .forEach((t) => {
          try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { counts[t] = null; }
        });

      audit(req, {
        action: 'RESTORE', entity: 'database', entity_id: null,
        summary: `${req.user.name} restored the database from a backup ` +
                 `(${before} invoices before, ${after} after)`,
        details: { tables: shared.length, counts, safety_copy: path.basename(safetyCopy) }
      });

      fs.unlink(uploaded, () => {});
      res.json({
        ok: true,
        tables: shared.length,
        counts,
        invoices_before: before,
        invoices_after: after,
        safety_copy: path.basename(safetyCopy)
      });
    } catch (err) {
      fs.unlink(uploaded, () => {});
      next(err);
    }
  }
);

/** What the owner needs to know about where this copy is running. */
router.get('/system', requirePermission('settings.edit'), (req, res) => {
  const counts = {};
  ['companies', 'users', 'suppliers', 'purchase_invoices', 'payments', 'petty_cash_requests']
    .forEach((t) => { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; });

  // In WAL mode a good part of the data can be sitting in the -wal file, so the
  // main file on its own understates how much is being kept.
  let dbSize = null;
  try {
    dbSize = ['', '-wal', '-shm'].reduce((total, suffix) => {
      try { return total + fs.statSync(config.dbFile + suffix).size; } catch { return total; }
    }, 0);
  } catch { /* not readable, not important */ }

  res.json({
    hosted: config.onRailway,
    storage_is_persistent: config.storageIsPersistent,
    data_dir: config.dataDir,
    // What to mount, and where, so the warning can name the fix rather than
    // leaving whoever reads it to guess.
    volume_mount_path: config.volume,
    suggested_mount_path: config.dataDir,
    db_file_is_set: !!process.env.DB_FILE,
    database_size_bytes: dbSize,
    session_secret_is_set: !!process.env.JWT_SECRET,
    counts
  });
});

module.exports = router;
