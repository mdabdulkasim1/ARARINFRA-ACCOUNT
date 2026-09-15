'use strict';

/**
 * A small in-memory throttle for the sign in form.
 *
 * Once the app is reachable from the internet, an open login page invites people
 * to guess passwords all day. This slows that to a crawl without needing Redis or
 * any other moving part. Counts live in memory, so a restart clears them - fine
 * for the job, since the point is to make guessing slow rather than to keep a
 * permanent record.
 *
 * Failures are counted per address AND account, not per address alone. The whole
 * office usually shares one public address, so counting per address would let one
 * person mistyping their password lock out everybody else.
 */

const WINDOW_MS = 15 * 60 * 1000;   // how far back failures are remembered
const MAX_FAILURES = 10;            // failures allowed inside that window
const BLOCK_MS = 15 * 60 * 1000;    // how long a blocked address waits

const attempts = new Map();

function keyFor(req, email) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  return `${ip}|${String(email || '').trim().toLowerCase()}`;
}

function prune(now) {
  for (const [key, entry] of attempts) {
    if (entry.blockedUntil < now && entry.last + WINDOW_MS < now) attempts.delete(key);
  }
}

/** How many seconds this address must wait for this account, or 0 if it may try now. */
function retryAfter(req, email) {
  const now = Date.now();
  const entry = attempts.get(keyFor(req, email));
  if (!entry || entry.blockedUntil <= now) return 0;
  return Math.ceil((entry.blockedUntil - now) / 1000);
}

function recordFailure(req, email) {
  const now = Date.now();
  prune(now);
  const key = keyFor(req, email);
  const entry = attempts.get(key) || { count: 0, last: now, blockedUntil: 0 };
  // A quiet spell wipes the slate, so an honest typo today is not held against
  // somebody next week.
  if (entry.last + WINDOW_MS < now) entry.count = 0;
  entry.count += 1;
  entry.last = now;
  if (entry.count >= MAX_FAILURES) {
    entry.blockedUntil = now + BLOCK_MS;
    entry.count = 0;
  }
  attempts.set(key, entry);
}

function recordSuccess(req, email) {
  attempts.delete(keyFor(req, email));
}

/** Test hook: forget every recorded failure. */
function reset() {
  attempts.clear();
}

module.exports = { retryAfter, recordFailure, recordSuccess, reset, MAX_FAILURES };
