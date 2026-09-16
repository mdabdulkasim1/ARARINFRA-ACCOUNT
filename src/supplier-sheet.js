'use strict';

/**
 * Read a list of suppliers out of a spreadsheet.
 *
 * Suppliers arrive in batches - a new site, a new trade - and typing forty of
 * them one form at a time is nobody's afternoon. The file people actually have
 * is whatever their own list looks like, so the columns are matched by what the
 * heading says rather than by position, and anything not recognised is left
 * alone instead of being guessed at.
 *
 * Both .xlsx and .csv are read. Nothing here touches the database: it turns a
 * file into rows and says what is wrong with them, and the route decides.
 */

const { text } = require('./util');

// What a column might be called in somebody else's spreadsheet. Checked after
// lowercasing and stripping everything that is not a letter or a digit, so
// "Supplier Name", "supplier_name" and "SUPPLIER NAME:" all land together.
const COLUMNS = {
  name: ['name', 'suppliername', 'supplier', 'vendorname', 'vendor', 'party', 'partyname', 'company', 'companyname'],
  code: ['code', 'suppliercode', 'supcode', 'vendorcode', 'accountcode', 'ledgercode'],
  contact_person: ['contact', 'contactperson', 'contactname', 'attention', 'personincharge'],
  phone: ['phone', 'phoneno', 'phonenumber', 'mobile', 'mobileno', 'telephone', 'tel', 'contactno', 'contactnumber'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  trn: ['trn', 'trnno', 'trnnumber', 'tax', 'taxno', 'taxnumber', 'vat', 'vatno', 'taxregistrationnumber'],
  payment_terms_days: ['terms', 'term', 'paymentterms', 'paymentterm', 'creditperiod', 'creditdays', 'credit',
    'paymenttermsdays', 'days', 'creditterms'],
  bank_name: ['bank', 'bankname', 'theirbank', 'partybank', 'beneficiarybank', 'bankdetails'],
  bank_account_no: ['accountno', 'accountnumber', 'account', 'acno', 'ac', 'bankaccount', 'bankaccountno'],
  iban: ['iban', 'ibanno', 'ibannumber'],
  address: ['address', 'location', 'addressline'],
  notes: ['notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'description'],
  active: ['active', 'status']
};

const TEMPLATE_HEADINGS = [
  'Supplier name', 'Code', 'Contact person', 'Phone', 'Email', 'TRN',
  'Credit period (days)', 'Bank name', 'Account number', 'IBAN', 'Address', 'Notes', 'Active'
];

/** The credit periods the app offers; anything else is rounded to the nearest. */
const TERMS = [0, 7, 15, 20, 30, 45, 60, 75, 90, 105, 120, 150, 180];

const key = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Which of our fields this heading is, or null if we do not recognise it. */
function fieldFor(heading) {
  const k = key(heading);
  if (!k) return null;
  return Object.keys(COLUMNS).find((f) => COLUMNS[f].includes(k)) || null;
}

/**
 * "90", "90 days", "Net 60", "immediate", "cash" -> a number of days.
 * Returns null when the cell says nothing usable, so the default applies.
 */
function parseTerms(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return nearestTerm(value);
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  if (/^(immediate|immediately|cash|advance|on submission|prepaid|cod)$/.test(s)) return 0;
  const m = /(-?\d+(?:\.\d+)?)/.exec(s);
  if (!m) return null;
  return nearestTerm(Number(m[1]));
}

function nearestTerm(n) {
  if (!Number.isFinite(n) || n < 0) return null;
  const days = Math.round(n);
  if (TERMS.includes(days)) return days;
  return TERMS.reduce((best, t) => (Math.abs(t - days) < Math.abs(best - days) ? t : best), TERMS[0]);
}

/** "no", "inactive", "closed", 0 and blank-as-false all mean not active. */
function parseActive(value) {
  if (value === null || value === undefined || value === '') return true;
  const s = String(value).trim().toLowerCase();
  if (!s) return true;
  return !/^(no|n|false|0|inactive|closed|blocked|stopped|dormant)$/.test(s);
}

// ------------------------------------------------------------------ csv

/** A CSV reader that copes with quotes, embedded commas and newlines. */
function parseCsv(str) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < str.length; i += 1) {
    const c = str[i];
    if (quoted) {
      if (c === '"') {
        if (str[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ------------------------------------------------------------------ reading

function looksLikeXlsx(buffer) {
  // Every .xlsx is a zip, and every zip starts "PK\x03\x04".
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
         buffer[2] === 0x03 && buffer[3] === 0x04;
}

/** Every used row of the first sheet, keeping the row number the sheet shows. */
async function readXlsx(buffer) {
  let ExcelJS;
  try {
    // eslint-disable-next-line global-require
    ExcelJS = require('exceljs');
  } catch {
    const err = new Error(
      'This copy cannot read .xlsx files. Save the sheet as CSV and upload that instead.'
    );
    err.status = 400;
    throw err;
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.worksheets.find((w) => w.rowCount > 0) || wb.worksheets[0];
  if (!sheet) return [];

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (r, number) => {
    const cells = [];
    r.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellValue(cell.value); });
    // The number the sheet shows, so a blank row in the middle does not shift
    // every row number in the report below it.
    rows.push({ number, cells });
  });
  return rows;
}

/** One cell as plain text or a number, whatever shape ExcelJS hands over. */
function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // A formula cell carries its last calculated value; a rich-text one its runs.
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('hyperlink' in v) return cellValue(v.text || v.hyperlink);
  }
  return String(v);
}

/**
 * The heading row is the first one that names a supplier column, so a sheet with
 * a title and a blank line above the table still reads.
 */
function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i += 1) {
    const fields = (rows[i].cells || []).map(fieldFor).filter(Boolean);
    if (fields.includes('name')) return i;
  }
  return -1;
}

/**
 * Turn a file into supplier rows.
 *
 * Returns the rows it understood, the columns it matched, and the headings it
 * ignored - so whoever uploaded can see their "Category" column was not silently
 * turned into something else.
 */
async function readSuppliers(buffer) {
  const rows = looksLikeXlsx(buffer)
    ? await readXlsx(buffer)
    : parseCsv(buffer.toString('utf8').replace(/^﻿/, ''))
      .map((cells, i) => ({ number: i + 1, cells }));

  const headerRow = findHeaderRow(rows);
  if (headerRow === -1) {
    const err = new Error(
      'No supplier name column found. The first row should have a heading like "Supplier name".'
    );
    err.status = 400;
    throw err;
  }

  const headings = rows[headerRow].cells || [];
  const mapping = {};
  const ignored = [];
  headings.forEach((h, i) => {
    const f = fieldFor(h);
    // First column wins, so a sheet with two "Notes" does not lose the first.
    if (f && !(f in mapping)) mapping[f] = i;
    else if (text(h)) ignored.push(String(h).trim());
  });

  const suppliers = [];
  for (let i = headerRow + 1; i < rows.length; i += 1) {
    const cells = rows[i].cells || [];
    const at = (field) => (mapping[field] === undefined ? '' : cells[mapping[field]]);
    const name = text(at('name'));
    // A blank line in the middle is a blank line, not the end of the file.
    if (!name) continue;

    suppliers.push({
      row: rows[i].number,
      name,
      code: text(at('code')) ? String(at('code')).trim().toUpperCase() : null,
      contact_person: text(at('contact_person')),
      phone: text(at('phone')),
      email: text(at('email')),
      trn: text(at('trn')),
      payment_terms_days: parseTerms(at('payment_terms_days')),
      bank_name: text(at('bank_name')),
      bank_account_no: text(at('bank_account_no')),
      iban: text(at('iban')),
      address: text(at('address')),
      notes: text(at('notes')),
      active: parseActive(at('active'))
    });
  }

  return {
    suppliers,
    matched: Object.keys(mapping),
    ignored,
    header_row: rows[headerRow].number
  };
}

/** A blank sheet in the shape the reader expects, as CSV. */
function templateCsv() {
  const example = [
    'AL NOOR BUILDING MATERIALS LLC', '', 'Mr Rashid', '+971 50 000 0000',
    'accounts@alnoor.example', '100123456700003', '90', 'ADCB', '1234567890',
    'AE000000000000000000000', 'Mussafah, Abu Dhabi', 'Opened for the Al Reem site', 'Yes'
  ];
  const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return `﻿${[TEMPLATE_HEADINGS, example].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}

module.exports = {
  readSuppliers, templateCsv, parseCsv, parseTerms, parseActive, fieldFor,
  TEMPLATE_HEADINGS, TERMS
};
