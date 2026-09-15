'use strict';

/**
 * Where things live and how the app identifies itself, resolved once at boot.
 *
 * Running locally, everything sits under ./data. On Railway (or any host that
 * mounts a volume) the data directory follows the volume, because the container
 * filesystem is wiped on every redeploy and the database would go with it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const onRailway = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID);
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;

/** The one directory that has to survive a restart. */
const dataDir = path.resolve(
  process.env.DATA_DIR || volume || path.join(__dirname, '..', 'data')
);

const dbFile = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(dataDir, 'arar-accounts.db');

/**
 * True when the data directory will still be there after a redeploy.
 *
 * A volume only helps if the database is actually on it. Hosting panels offer to
 * add every variable they can find in the source, DB_FILE among them, and its
 * example value is a path inside the app - which quietly moves the database off
 * the volume and onto disposable storage.
 */
const dbIsOnTheVolume = !volume || dbFile.startsWith(path.resolve(volume) + path.sep);
const storageIsPersistent =
  (!onRailway || !!volume || !!process.env.DATA_DIR) && dbIsOnTheVolume;

if (volume && !dbIsOnTheVolume) {
  console.warn('');
  console.warn('  ****************************************************************');
  console.warn('  WARNING: a volume is mounted at ' + volume);
  console.warn('  but DB_FILE points outside it, at:');
  console.warn('    ' + dbFile);
  console.warn('  Everything entered will be LOST on the next deploy.');
  console.warn('  Remove the DB_FILE variable, or set it to a path on the volume.');
  console.warn('  ****************************************************************');
  console.warn('');
}

const isProduction = process.env.NODE_ENV === 'production' || onRailway;

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
}

/**
 * The key that signs login sessions.
 *
 * Set JWT_SECRET and that is what gets used. Otherwise one is generated and kept
 * in the data directory, so sessions survive a restart instead of logging
 * everybody out - as long as that directory is persistent.
 */
let cachedSecret = null;

function sessionSecret() {
  if (cachedSecret) return cachedSecret;

  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv !== 'change-this-to-a-long-random-secret-string') {
    cachedSecret = fromEnv;
    return cachedSecret;
  }

  const secretFile = path.join(dataDir, '.session-secret');
  try {
    ensureDataDir();
    if (fs.existsSync(secretFile)) {
      const stored = fs.readFileSync(secretFile, 'utf8').trim();
      if (stored.length >= 32) {
        cachedSecret = stored;
        return cachedSecret;
      }
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.warn(
      '[auth] JWT_SECRET is not set. Generated one and saved it to the data ' +
      'directory, so sessions survive a restart. Set JWT_SECRET to control it yourself.'
    );
    cachedSecret = generated;
    return cachedSecret;
  } catch (err) {
    // Read-only disk, or no data directory. Fall back to a per-process secret:
    // the app still works, but a restart signs everybody out.
    console.warn(
      `[auth] Could not store a session secret (${err.message}). Using a temporary one - ` +
      'everyone will be signed out when the server restarts. Set JWT_SECRET to fix this.'
    );
    cachedSecret = crypto.randomBytes(48).toString('hex');
    return cachedSecret;
  }
}

function sessionHours() {
  const h = Number(process.env.SESSION_HOURS || 12);
  return Number.isFinite(h) && h > 0 ? h : 12;
}

const config = {
  port: Number(process.env.PORT || 3000),
  dataDir,
  dbFile,
  onRailway,
  volume,
  storageIsPersistent,
  isProduction,
  // Tests seed their own fixtures, so they turn the first-run bootstrap off.
  autoBootstrap: process.env.AUTO_BOOTSTRAP !== 'false',
  ensureDataDir,
  sessionSecret,
  sessionHours,
  groupName: process.env.GROUP_NAME || 'ARAR INFRA GROUP',
  currency: process.env.DEFAULT_CURRENCY || 'AED',
  defaultTerms: Number(process.env.DEFAULT_PAYMENT_TERMS_DAYS || 90)
};

module.exports = config;
