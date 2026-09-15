'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { db, audit } = require('../db');
const config = require('../config');
const { requireAuth, requirePermission } = require('../auth');

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

/** What the owner needs to know about where this copy is running. */
router.get('/system', requirePermission('settings.edit'), (req, res) => {
  const counts = {};
  ['companies', 'users', 'suppliers', 'purchase_invoices', 'payments', 'petty_cash_requests']
    .forEach((t) => { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; });

  let dbSize = null;
  try { dbSize = fs.statSync(config.dbFile).size; } catch { /* not readable, not important */ }

  res.json({
    hosted: config.onRailway,
    storage_is_persistent: config.storageIsPersistent,
    data_dir: config.dataDir,
    database_size_bytes: dbSize,
    session_secret_is_set: !!process.env.JWT_SECRET,
    counts
  });
});

module.exports = router;
