'use strict';

/** Round to 2 decimals, the way money behaves. */
function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** Amounts closer than half a fils are the same amount. */
function nearlyEqual(a, b) {
  return Math.abs(money(a) - money(b)) < 0.005;
}

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

/** Normalise anything date-ish to 'YYYY-MM-DD', or null. */
function toDate(v) {
  if (isBlank(v)) return null;
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** Add whole days to a 'YYYY-MM-DD' date. */
function addDays(dateStr, days) {
  const d = toDate(dateStr);
  if (!d) return null;
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + Number(days || 0));
  return t.toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). Negative when b is before a. */
function daysBetween(a, b) {
  const x = toDate(a);
  const y = toDate(b);
  if (!x || !y) return null;
  return Math.round(
    (new Date(`${y}T00:00:00Z`) - new Date(`${x}T00:00:00Z`)) / 86400000
  );
}

/**
 * The payment due date. Credit period runs from the date we submitted the
 * invoice, not from the date the supplier wrote on it. When the invoice has not
 * been submitted yet there is no due date to speak of, so we fall back to the
 * invoice date and let the caller flag it.
 */
function computeDueDate({ submitted_date, invoice_date, payment_terms_days }) {
  const base = toDate(submitted_date) || toDate(invoice_date);
  if (!base) return null;
  return addDays(base, Number(payment_terms_days || 0));
}

/** Bucket an invoice by how far past its due date it is. */
function ageingBucket(dueDate, asOf) {
  const overdueBy = daysBetween(dueDate, asOf || today());
  if (overdueBy === null) return 'NO_DUE_DATE';
  if (overdueBy <= 0) return 'NOT_DUE';
  if (overdueBy <= 30) return 'D1_30';
  if (overdueBy <= 60) return 'D31_60';
  if (overdueBy <= 90) return 'D61_90';
  return 'D90_PLUS';
}

const AGEING_BUCKETS = ['NOT_DUE', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS', 'NO_DUE_DATE'];

const AGEING_LABELS = {
  NOT_DUE: 'Not yet due',
  D1_30: 'Overdue 1-30 days',
  D31_60: 'Overdue 31-60 days',
  D61_90: 'Overdue 61-90 days',
  D90_PLUS: 'Overdue over 90 days',
  NO_DUE_DATE: 'No due date (not submitted)'
};

/**
 * Does this payment actually take money out of the business?
 * Cash and transfers settle the moment they are recorded. A cheque only settles
 * once it clears the bank - until then it is a commitment, not a settlement.
 */
function isSettled(payment) {
  if (!payment || payment.status === 'CANCELLED') return false;
  if (payment.mode === 'PDC' || payment.mode === 'CHEQUE') {
    return payment.pdc_status === 'CLEARED';
  }
  return payment.status === 'COMPLETED';
}

/** A cheque that is out there in the supplier's hands, still waiting to clear. */
function isPdcOutstanding(payment) {
  if (!payment || payment.status === 'CANCELLED') return false;
  if (payment.mode !== 'PDC' && payment.mode !== 'CHEQUE') return false;
  return payment.pdc_status === 'ISSUED' || payment.pdc_status === 'PRESENTED';
}

/** SQL fragment matching settled payments, for use inside sub-selects. */
const SQL_SETTLED = `(
  p.status <> 'CANCELLED' AND (
    (p.mode IN ('PDC','CHEQUE') AND p.pdc_status = 'CLEARED')
    OR (p.mode NOT IN ('PDC','CHEQUE') AND p.status = 'COMPLETED')
  )
)`;

/** SQL fragment matching cheques still to clear. */
const SQL_PDC_OUTSTANDING = `(
  p.status <> 'CANCELLED'
  AND p.mode IN ('PDC','CHEQUE')
  AND p.pdc_status IN ('ISSUED','PRESENTED')
)`;

function parseAmount(v, field = 'amount') {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const err = new Error(`${field} must be a number`);
    err.status = 400;
    throw err;
  }
  return money(n);
}

function requireFields(body, fields) {
  const missing = fields.filter((f) => isBlank(body[f]));
  if (missing.length) {
    const err = new Error(`Missing required field(s): ${missing.join(', ')}`);
    err.status = 400;
    throw err;
  }
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFound(message = 'Not found') {
  const err = new Error(message);
  err.status = 404;
  return err;
}

function forbidden(message = 'You do not have permission to do this') {
  const err = new Error(message);
  err.status = 403;
  return err;
}

/** Clean a free-text field: trim, or null when empty. */
function text(v) {
  if (isBlank(v)) return null;
  return String(v).trim();
}

function bool(v, dflt = false) {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

module.exports = {
  money,
  nearlyEqual,
  isBlank,
  toDate,
  today,
  nowStamp,
  addDays,
  daysBetween,
  computeDueDate,
  ageingBucket,
  AGEING_BUCKETS,
  AGEING_LABELS,
  isSettled,
  isPdcOutstanding,
  SQL_SETTLED,
  SQL_PDC_OUTSTANDING,
  parseAmount,
  requireFields,
  badRequest,
  notFound,
  forbidden,
  text,
  bool
};
