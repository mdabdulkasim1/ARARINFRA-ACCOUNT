'use strict';

/**
 * Bring the existing purchase log spreadsheet into the app.
 *
 *   npm run import -- PURCHASE_LOGS-2026.xlsx --dry-run
 *   npm run import -- PURCHASE_LOGS-2026.xlsx --company AIC
 *   npm run import -- PURCHASE_LOGS-2026.xlsx --company AIC --cheques
 *
 * What it reads
 *   Master_Combined (or 2026)  the purchase log: one row per supplier invoice
 *   payment                    the cheque register, only with --cheques
 *
 * How the money is carried over
 *   Each invoice keeps its own dates, terms and amounts. Where the sheet shows
 *   an amount already PAID, one settlement entry is recorded against that
 *   invoice, so the outstanding figure in the app matches the BALANCE column
 *   exactly. Individual historic cheques are not matched to invoices - the sheet
 *   does not record which cheque paid which bill - so they are only brought in
 *   as a register, and only the ones that have not cleared.
 *
 * Running it twice is safe: an invoice already present for the same supplier and
 * company is skipped rather than duplicated.
 */

require('dotenv').config();

const path = require('path');
const { db, migrate } = require('./db');
const { money, toDate } = require('./util');

let ExcelJS;
try {
  ExcelJS = require('exceljs');
} catch {
  console.error(
    '\n  The spreadsheet reader is not installed. Run npm install first.\n'
  );
  process.exit(1);
}

// ------------------------------------------------------------------ arguments

const argv = process.argv.slice(2);
const flags = {
  file: argv.find((a) => !a.startsWith('-')),
  dryRun: argv.includes('--dry-run'),
  cheques: argv.some((a) => a === '--cheques' || a.startsWith('--cheques=')),
  allCheques: argv.includes('--cheques=all'),
  company: (argv.find((a) => a.startsWith('--company=')) || '').split('=')[1] ||
           (argv.includes('--company') ? argv[argv.indexOf('--company') + 1] : null),
  sheet: (argv.find((a) => a.startsWith('--sheet=')) || '').split('=')[1] || null
};

if (!flags.file) {
  console.error('\n  Usage: npm run import -- <file.xlsx> [--company CODE] [--cheques] [--dry-run]\n');
  process.exit(1);
}

// ------------------------------------------------------------------ helpers

/**
 * Pull the literal out of a Google Sheets export formula.
 *
 * A workbook exported from Google Sheets wraps every cell as
 *   IFERROR(__xludf.DUMMYFUNCTION("..."), "DATE ")
 * where the second argument is the value Google last displayed. Excel never
 * evaluates that, so `result` comes back null and the cell looks empty - which
 * is how two of the column headings went missing and took their whole column
 * with them. The fallback literal is the real value.
 */
function literalFromFormula(formula) {
  if (typeof formula !== 'string') return null;
  const quoted = /,\s*"((?:[^"]|"")*)"\s*\)\s*$/.exec(formula);
  if (quoted) return quoted[1].replace(/""/g, '"').trim() || null;
  const numeric = /,\s*(-?\d+(?:\.\d+)?)\s*\)\s*$/.exec(formula);
  if (numeric) return numeric[1];
  return null;
}

const clean = (v) => {
  if (v === null || v === undefined) return null;
  // ExcelJS hands back objects for formulas, rich text and hyperlinks.
  if (typeof v === 'object') {
    // A few cells in the log hold a date serial outside the valid range, which
    // arrives as an Invalid Date. Treat those as empty rather than throwing.
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
    if (v.formula !== undefined) {
      const computed = clean(v.result);
      return computed === null ? clean(literalFromFormula(v.formula)) : computed;
    }
    if (v.result !== undefined) return clean(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('').trim() || null;
    if (v.text !== undefined) return String(v.text).trim() || null;
    return null;
  }
  const s = String(v).trim();
  return s === '' ? null : s;
};

const text = (v) => {
  const c = clean(v);
  if (c === null) return null;
  if (c instanceof Date) {
    return Number.isNaN(c.getTime()) ? null : c.toISOString().slice(0, 10);
  }
  return String(c).replace(/\s+/g, ' ').trim() || null;
};

const num = (v) => {
  const c = clean(v);
  if (c === null) return 0;
  if (c instanceof Date) return 0;
  const n = Number(String(c).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const asDate = (v) => {
  const c = clean(v);
  if (c === null) return null;
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) return null;
    // Excel dates come through as UTC midnight; take the calendar day as-is.
    return c.toISOString().slice(0, 10);
  }
  return toDate(String(c));
};

/** Invoice numbers arrive as floats: 2025205550 reads back as "2025205550.0". */
const invoiceRef = (v) => {
  const t = text(v);
  if (!t) return null;
  return t.replace(/\.0+$/, '').trim() || null;
};

const normaliseName = (name) => String(name || '').replace(/\s+/g, ' ').trim().toUpperCase();

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i += 1) {
    const joined = rows[i].map((c) => normaliseName(text(c) || '')).join('|');
    if (joined.includes('INV NO') && (joined.includes('SNO') || joined.includes('SUPPLIER'))) {
      return i;
    }
  }
  return -1;
}

/** Map the sheet's headings (typos and all) onto the fields we need. */
const FIELD_ALIASES = {
  sno:        ['SNO', 'S NO', 'ROW'],
  submitted:  ['DATE'],
  invoiceDate:['INV DAT', 'INV DATE', 'INVOICE DATE'],
  category:   ['CATEGORY'],
  lpo:        ['LPO NO', 'LPO'],
  supplier:   ["SUPPLIER'S NAMES", 'SUPPLIER NAME', 'SUPPLIERS NAMES', 'NAME'],
  term:       ['TERM', 'TERMS'],
  invoiceNo:  ['INV NO', 'INVOICE NO'],
  amount:     ['AMOUNT'],
  vat:        ['VAT'],
  total:      ['TOATAL', 'TOTAL'],
  paid:       ['PAID'],
  balance:    ['BALANCE'],
  status:     ['PAYMEN STATUS', 'PAYMENT STATUS', 'STATUS']
};

function mapColumns(headerCells) {
  const headings = headerCells.map((c) => normaliseName(text(c) || ''));
  const index = {};
  Object.entries(FIELD_ALIASES).forEach(([field, aliases]) => {
    index[field] = headings.findIndex((h) => h && aliases.includes(h));
  });
  return index;
}

// ------------------------------------------------------------------ main

async function main() {
  migrate();

  const file = path.resolve(flags.file);
  console.log(`\n  Reading ${file}`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  // Which company do these invoices belong to?
  const companies = db.prepare('SELECT * FROM companies ORDER BY id').all();
  if (!companies.length) {
    console.error('\n  There are no companies yet. Run "npm run seed" first.\n');
    process.exit(1);
  }
  const company = flags.company
    ? companies.find((c) => c.code.toUpperCase() === flags.company.toUpperCase())
    : companies[0];
  if (!company) {
    console.error(`\n  No company with code "${flags.company}". Known codes: ${companies.map((c) => c.code).join(', ')}\n`);
    process.exit(1);
  }

  const sheetName = flags.sheet || ['Master_Combined', '2026'].find((n) => wb.getWorksheet(n));
  const ws = wb.getWorksheet(sheetName);
  if (!ws) {
    console.error(`\n  No sheet called "${sheetName}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}\n`);
    process.exit(1);
  }

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-based with a leading hole; drop it.
    rows.push(Array.isArray(row.values) ? row.values.slice(1) : []);
  });

  const headerAt = findHeaderRow(rows);
  if (headerAt < 0) {
    console.error(`\n  Could not find the heading row in "${sheetName}".\n`);
    process.exit(1);
  }
  const col = mapColumns(rows[headerAt]);
  const missing = ['supplier', 'invoiceNo', 'total'].filter((f) => col[f] < 0);
  if (missing.length) {
    console.error(`\n  The sheet is missing these columns: ${missing.join(', ')}\n`);
    process.exit(1);
  }

  const dataRows = rows.slice(headerAt + 1).filter((r) => text(r[col.supplier]));
  console.log(`  Sheet "${sheetName}": ${dataRows.length} invoice rows`);
  console.log(`  Importing into: ${company.name} (${company.code})`);
  if (flags.dryRun) console.log('  DRY RUN - nothing will be written\n');
  else console.log('');

  // ---------------------------------------------------------------- parse

  const parsed = [];
  const stats = {
    rows: dataRows.length,
    termNumeric: 0, termFromSupplier: 0, termUnknown: 0,
    noInvoiceNo: 0, zeroTotal: 0, paidCapped: 0, dateEstimated: 0
  };

  // The log is written in date order, so when a row's date cell is corrupt the
  // previous row's date is the closest thing to the truth we have. Better than
  // dropping the invoice and losing its balance.
  let lastGoodDate = null;

  dataRows.forEach((r, i) => {
    const supplierName = text(r[col.supplier]);
    const total = money(num(r[col.total]));
    if (total <= 0) { stats.zeroTotal += 1; return; }

    let ref = invoiceRef(r[col.invoiceNo]);
    if (!ref) {
      stats.noInvoiceNo += 1;
      ref = `NOREF-${text(r[col.sno]) || i + 1}`;
    }

    let invoiceDate = asDate(r[col.invoiceDate]) || asDate(r[col.submitted]);
    let submitted = asDate(r[col.submitted]);
    let dateEstimated = false;

    if (!invoiceDate && !submitted) {
      // Both cells unreadable - carry the previous row's date forward.
      invoiceDate = lastGoodDate;
      submitted = lastGoodDate;
      dateEstimated = true;
      stats.dateEstimated += 1;
    }
    lastGoodDate = submitted || invoiceDate || lastGoodDate;

    // The log is written when the invoice reaches accounts, so DATE is the day it
    // was submitted. Guard against a row where that lands before the invoice date.
    if (submitted && invoiceDate && submitted < invoiceDate) submitted = invoiceDate;

    const rawTerm = text(r[col.term]);
    const termDays = rawTerm !== null && /^\d+$/.test(rawTerm) ? Number(rawTerm) : null;
    if (termDays !== null) stats.termNumeric += 1;

    let paid = money(num(r[col.paid]));
    if (paid > total) { paid = total; stats.paidCapped += 1; }

    parsed.push({
      supplierName,
      supplierKey: normaliseName(supplierName),
      invoiceNo: ref,
      invoiceDate: invoiceDate || submitted,
      submitted,
      termDays,
      rawTerm,
      dateEstimated,
      category: text(r[col.category]),
      lpo: text(r[col.lpo]),
      subtotal: money(num(r[col.amount])),
      vat: money(num(r[col.vat])),
      total,
      paid,
      status: (text(r[col.status]) || '').toUpperCase()
    });
  });

  // A supplier's usual credit period, used when a row leaves TERM blank.
  const supplierTerms = new Map();
  parsed.forEach((p) => {
    if (p.termDays === null) return;
    const seen = supplierTerms.get(p.supplierKey) || new Map();
    seen.set(p.termDays, (seen.get(p.termDays) || 0) + 1);
    supplierTerms.set(p.supplierKey, seen);
  });
  const usualTerm = (key) => {
    const seen = supplierTerms.get(key);
    if (!seen) return null;
    return [...seen.entries()].sort((a, b) => b[1] - a[1])[0][0];
  };

  parsed.forEach((p) => {
    if (p.termDays !== null) return;
    const fallback = usualTerm(p.supplierKey);
    if (fallback !== null) {
      p.termDays = fallback;
      p.termInferred = true;
      stats.termFromSupplier += 1;
    } else {
      // Nothing to go on: treat it as due when submitted rather than invent terms.
      p.termDays = 0;
      stats.termUnknown += 1;
    }
  });

  const supplierNames = [...new Set(parsed.map((p) => p.supplierKey))];
  const invoiced = money(parsed.reduce((s, p) => s + p.total, 0));
  const paidTotal = money(parsed.reduce((s, p) => s + p.paid, 0));

  console.log('  Read from the sheet');
  console.log(`    Suppliers            ${supplierNames.length}`);
  console.log(`    Invoices             ${parsed.length}`);
  console.log(`    Invoiced             ${invoiced.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`    Already paid         ${paidTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log(`    Still outstanding    ${money(invoiced - paidTotal).toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  console.log('');
  console.log('  Payment terms');
  console.log(`    Taken from the sheet ${stats.termNumeric}`);
  console.log(`    From supplier's usual terms (TERM was blank or a payment mode) ${stats.termFromSupplier}`);
  console.log(`    Unknown, treated as due on submission ${stats.termUnknown}`);
  if (stats.dateEstimated) console.log(`    Rows whose date cell was unreadable, dated from the row above: ${stats.dateEstimated}`);
  if (stats.noInvoiceNo) console.log(`    Rows with no invoice reference, kept as NOREF-n: ${stats.noInvoiceNo}`);
  if (stats.zeroTotal) console.log(`    Rows skipped with no amount: ${stats.zeroTotal}`);
  if (stats.paidCapped) console.log(`    Rows where PAID exceeded the total, capped: ${stats.paidCapped}`);
  console.log('');

  // ---------------------------------------------------------------- cheques

  let cheques = [];
  if (flags.cheques) {
    cheques = readCheques(wb, flags.allCheques);
    console.log(`  Cheque register: ${cheques.length} cheque(s) to bring in` +
                (flags.allCheques ? ' (including cleared)' : ' (not yet cleared only)'));
    console.log('');
  }

  if (flags.dryRun) {
    console.log('  Dry run finished, nothing was written.\n');
    return;
  }

  // ---------------------------------------------------------------- write

  const result = db.transaction(() => {
    const out = {
      suppliersCreated: 0, invoicesCreated: 0, invoicesSkipped: 0,
      settlements: 0, chequesCreated: 0, categoriesCreated: 0
    };

    // --- suppliers
    const existingSuppliers = new Map(
      db.prepare('SELECT id, name FROM suppliers').all()
        .map((s) => [normaliseName(s.name), s.id])
    );
    const maxCode = db.prepare(
      "SELECT IFNULL(MAX(CAST(substr(code, 4) AS INTEGER)), 0) n FROM suppliers WHERE code LIKE 'SUP%'"
    ).get().n;
    let nextCode = maxCode;

    const insSupplier = db.prepare(
      'INSERT INTO suppliers (code, name, payment_terms_days, active) VALUES (?, ?, ?, 1)'
    );
    supplierNames.forEach((key) => {
      if (existingSuppliers.has(key)) return;
      const original = parsed.find((p) => p.supplierKey === key).supplierName;
      nextCode += 1;
      const info = insSupplier.run(
        `SUP${String(nextCode).padStart(4, '0')}`, original, usualTerm(key) ?? 30
      );
      existingSuppliers.set(key, info.lastInsertRowid);
      out.suppliersCreated += 1;
    });

    // --- categories
    const existingCats = new Map(
      db.prepare("SELECT id, name FROM categories WHERE kind = 'EXPENSE'").all()
        .map((c) => [normaliseName(c.name), c.id])
    );
    const insCat = db.prepare("INSERT INTO categories (name, kind, active) VALUES (?, 'EXPENSE', 1)");
    [...new Set(parsed.map((p) => p.category).filter(Boolean))].forEach((name) => {
      const key = normaliseName(name);
      if (existingCats.has(key)) return;
      const info = insCat.run(name);
      existingCats.set(key, info.lastInsertRowid);
      out.categoriesCreated += 1;
    });

    // --- invoices
    const findInvoice = db.prepare(
      'SELECT id FROM purchase_invoices WHERE company_id = ? AND supplier_id = ? AND invoice_no = ?'
    );
    const insInvoice = db.prepare(
      `INSERT INTO purchase_invoices
         (company_id, supplier_id, invoice_no, invoice_date, submitted_date, payment_terms_days,
          due_date, currency, subtotal, tax_amount, total_amount, category_id, lpo_no,
          description, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`
    );
    const insPayment = db.prepare(
      `INSERT INTO payments
         (company_id, supplier_id, payment_no, payment_date, amount, currency, mode, payment_type,
          status, narration)
       VALUES (?, ?, ?, ?, ?, ?, 'OTHER', 'INVOICE', 'COMPLETED', ?)`
    );
    const insAlloc = db.prepare(
      'INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?, ?, ?)'
    );

    const currency = company.currency;
    let settlementNo = 0;

    parsed.forEach((p) => {
      if (!p.invoiceDate) { out.invoicesSkipped += 1; return; }
      const supplierId = existingSuppliers.get(p.supplierKey);
      if (findInvoice.get(company.id, supplierId, p.invoiceNo)) {
        out.invoicesSkipped += 1;
        return;
      }

      const base = p.submitted || p.invoiceDate;
      const due = base
        ? new Date(new Date(`${base}T00:00:00Z`).getTime() + p.termDays * 86400000)
            .toISOString().slice(0, 10)
        : null;

      const notes = [];
      if (p.rawTerm && !/^\d+$/.test(p.rawTerm)) notes.push(`Sheet TERM: ${p.rawTerm}`);
      if (p.termInferred) notes.push(`Terms taken from this supplier's usual ${p.termDays} days`);
      if (p.status) notes.push(`Sheet status: ${p.status}`);
      if (p.dateEstimated) notes.push('The date cell was unreadable; taken from the row above');
      notes.push('Imported from the purchase log');

      const info = insInvoice.run(
        company.id, supplierId, p.invoiceNo, p.invoiceDate, p.submitted, p.termDays,
        p.submitted ? due : null, currency,
        p.subtotal || money(p.total - p.vat), p.vat, p.total,
        p.category ? existingCats.get(normaliseName(p.category)) : null,
        p.lpo, notes.join('. ')
      );
      const invoiceId = info.lastInsertRowid;
      out.invoicesCreated += 1;

      // Carry the paid figure over as one settlement, so the outstanding amount
      // in the app matches the sheet's BALANCE column exactly.
      if (p.paid > 0.005) {
        settlementNo += 1;
        const pay = insPayment.run(
          company.id, supplierId,
          `OPEN/${company.code}/${String(settlementNo).padStart(5, '0')}`,
          p.submitted || p.invoiceDate, p.paid, currency,
          'Opening balance: settled before go-live, per the purchase log'
        );
        insAlloc.run(pay.lastInsertRowid, invoiceId, p.paid);
        out.settlements += 1;
      }
    });

    // --- cheque register
    if (cheques.length) {
      const insChq = db.prepare(
        `INSERT INTO payments
           (company_id, supplier_id, payment_no, payment_date, amount, currency, mode, payment_type,
            cheque_no, cheque_date, cheque_bank_name, pdc_status, status, narration)
         VALUES (?, ?, ?, ?, ?, ?, 'PDC', 'ADVANCE', ?, ?, ?, ?, 'COMPLETED', ?)`
      );
      let n = 0;
      cheques.forEach((c) => {
        const key = normaliseName(c.name);
        let supplierId = existingSuppliers.get(key);
        if (!supplierId) {
          nextCode += 1;
          const info = insSupplier.run(`SUP${String(nextCode).padStart(4, '0')}`, c.name, 30);
          supplierId = info.lastInsertRowid;
          existingSuppliers.set(key, supplierId);
          out.suppliersCreated += 1;
        }
        n += 1;
        insChq.run(
          company.id, supplierId,
          `IMPDC/${company.code}/${String(n).padStart(5, '0')}`,
          c.issued || c.chequeDate, c.amount, currency,
          c.chequeNo, c.chequeDate, c.bank, c.status,
          'Imported from the cheque register. Not yet matched to an invoice.'
        );
        out.chequesCreated += 1;
      });
    }

    return out;
  })();

  // Bring every touched invoice's status in line with what was settled.
  const { refreshInvoiceStatus } = require('./queries');
  db.prepare('SELECT id FROM purchase_invoices WHERE company_id = ?')
    .all(company.id)
    .forEach((r) => refreshInvoiceStatus(r.id));

  console.log('  Written');
  console.log(`    Suppliers created    ${result.suppliersCreated}`);
  console.log(`    Categories created   ${result.categoriesCreated}`);
  console.log(`    Invoices created     ${result.invoicesCreated}`);
  console.log(`    Invoices skipped (already present)  ${result.invoicesSkipped}`);
  console.log(`    Opening settlements  ${result.settlements}`);
  if (flags.cheques) console.log(`    Cheques created      ${result.chequesCreated}`);
  console.log('');

  // ---------------------------------------------------------------- verify

  const check = db.prepare(
    `SELECT ROUND(SUM(i.total_amount), 2) total,
            ROUND(SUM(IFNULL(a.paid, 0)), 2) paid,
            ROUND(SUM(i.total_amount - IFNULL(a.paid, 0)), 2) outstanding
       FROM purchase_invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) paid FROM payment_allocations GROUP BY invoice_id) a
              ON a.invoice_id = i.id
      WHERE i.company_id = ? AND i.status <> 'CANCELLED'`
  ).get(company.id);

  const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2 });
  console.log('  In the app now');
  console.log(`    Invoiced             ${fmt(check.total)}`);
  console.log(`    Paid                 ${fmt(check.paid)}`);
  console.log(`    Outstanding          ${fmt(check.outstanding)}`);
  console.log('');
  console.log('  From the sheet');
  console.log(`    Invoiced             ${fmt(invoiced)}`);
  console.log(`    Paid                 ${fmt(paidTotal)}`);
  console.log(`    Outstanding          ${fmt(money(invoiced - paidTotal))}`);

  const drift = Math.abs(money(check.outstanding) - money(invoiced - paidTotal));
  console.log('');
  if (drift < 0.05) {
    console.log('  The outstanding figure matches the spreadsheet.');
  } else {
    console.log(`  NOTE: the outstanding figure differs by ${fmt(drift)}.`);
    console.log('  That is expected if some invoices were already in the app before this run.');
  }
  if (result.invoicesSkipped) {
    console.log('');
    console.log(`  ${result.invoicesSkipped} row(s) were skipped because the same invoice number`);
    console.log('  already exists for that supplier. The sheet lists them twice, so the invoiced');
    console.log('  and paid totals above are lower by the duplicated amount. Where those rows were');
    console.log('  settled in full, what is still outstanding is unaffected.');
  }
  console.log('');
}

/** Read the cheque register. By default only cheques that have not cleared. */
function readCheques(wb, includeCleared) {
  const ws = wb.getWorksheet('payment');
  if (!ws) return [];

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    rows.push(Array.isArray(row.values) ? row.values.slice(1) : []);
  });
  if (!rows.length) return [];

  const headings = rows[0].map((c) => normaliseName(text(c) || ''));
  const at = (...names) => headings.findIndex((h) => names.includes(h));
  const idx = {
    issued: at('ISS DAT'),
    chequeDate: at('CHQ  DAT', 'CHQ DAT'),
    name: at('NAME'),
    bank: at('BANK'),
    chequeNo: at('CHQ NO', 'CHQ-NO'),
    status: at('BANK STATUS'),
    amount: at('AMOUNT')
  };
  if (idx.name < 0 || idx.amount < 0) return [];

  const out = [];
  rows.slice(1).forEach((r) => {
    const name = text(r[idx.name]);
    const amount = money(num(r[idx.amount]));
    if (!name || amount <= 0) return;

    const raw = (text(r[idx.status]) || '').toUpperCase();
    const cleared = raw === 'CLR' || raw === 'STL';
    // A cleared cheque is already reflected in the invoice's PAID figure, so
    // bringing it in as well would count the same money twice.
    if (cleared && !includeCleared) return;

    out.push({
      name,
      amount,
      bank: text(r[idx.bank]),
      chequeNo: invoiceRef(r[idx.chequeNo]),
      issued: asDate(r[idx.issued]),
      chequeDate: asDate(r[idx.chequeDate]),
      status: cleared ? 'CLEARED' : 'ISSUED'
    });
  });
  return out;
}

main().catch((err) => {
  console.error('\n  Import failed:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
