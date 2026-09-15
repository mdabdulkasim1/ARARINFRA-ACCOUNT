'use strict';

const { db } = require('./db');
const {
  money, today, daysBetween, ageingBucket, SQL_SETTLED, SQL_PDC_OUTSTANDING
} = require('./util');

/**
 * Every supplier invoice, with the three numbers that matter:
 *
 *   paid_amount  - money that has actually left us (cash, transfer, cleared cheques)
 *   pdc_amount   - cheques handed over but not yet cleared; committed, not gone
 *   outstanding  - what the supplier is still owed  (total - paid)
 *   net_payable  - what we still have to arrange    (outstanding - cheques in hand)
 */
const INVOICE_SELECT = `
  SELECT i.*,
         s.name AS supplier_name,
         s.code AS supplier_code,
         c.code AS company_code,
         c.name AS company_name,
         cat.name AS category_name,
         u.name AS created_by_name,
         ROUND(IFNULL(paid.amt, 0), 2) AS paid_amount,
         ROUND(IFNULL(pdc.amt, 0), 2)  AS pdc_amount,
         ROUND(i.total_amount - IFNULL(paid.amt, 0), 2) AS outstanding,
         ROUND(i.total_amount - IFNULL(paid.amt, 0) - IFNULL(pdc.amt, 0), 2) AS net_payable
    FROM purchase_invoices i
    JOIN suppliers s   ON s.id  = i.supplier_id
    JOIN companies c   ON c.id  = i.company_id
    LEFT JOIN categories cat ON cat.id = i.category_id
    LEFT JOIN users u  ON u.id  = i.created_by
    LEFT JOIN (
      SELECT a.invoice_id, SUM(a.amount) AS amt
        FROM payment_allocations a
        JOIN payments p ON p.id = a.payment_id
       WHERE ${SQL_SETTLED}
       GROUP BY a.invoice_id
    ) paid ON paid.invoice_id = i.id
    LEFT JOIN (
      SELECT a.invoice_id, SUM(a.amount) AS amt
        FROM payment_allocations a
        JOIN payments p ON p.id = a.payment_id
       WHERE ${SQL_PDC_OUTSTANDING}
       GROUP BY a.invoice_id
    ) pdc ON pdc.invoice_id = i.id
`;

const SALES_SELECT = `
  SELECT i.*,
         cu.name AS customer_name,
         cu.code AS customer_code,
         c.code AS company_code,
         c.name AS company_name,
         cat.name AS category_name,
         ROUND(IFNULL(rec.amt, 0), 2) AS received_amount,
         ROUND(IFNULL(pdc.amt, 0), 2) AS pdc_amount,
         ROUND(i.total_amount - IFNULL(rec.amt, 0), 2) AS outstanding
    FROM sales_invoices i
    JOIN customers cu ON cu.id = i.customer_id
    JOIN companies c  ON c.id  = i.company_id
    LEFT JOIN categories cat ON cat.id = i.category_id
    LEFT JOIN (
      SELECT a.invoice_id, SUM(a.amount) AS amt
        FROM receipt_allocations a
        JOIN receipts p ON p.id = a.receipt_id
       WHERE ${SQL_SETTLED}
       GROUP BY a.invoice_id
    ) rec ON rec.invoice_id = i.id
    LEFT JOIN (
      SELECT a.invoice_id, SUM(a.amount) AS amt
        FROM receipt_allocations a
        JOIN receipts p ON p.id = a.receipt_id
       WHERE ${SQL_PDC_OUTSTANDING}
       GROUP BY a.invoice_id
    ) pdc ON pdc.invoice_id = i.id
`;

const PAYMENT_SELECT = `
  SELECT p.*,
         s.name AS supplier_name,
         s.code AS supplier_code,
         c.code AS company_code,
         c.name AS company_name,
         ba.bank_name AS from_bank_name,
         ba.account_no AS from_bank_account_no,
         u.name AS created_by_name,
         ROUND(IFNULL(al.amt, 0), 2) AS allocated_amount,
         ROUND(p.amount - IFNULL(al.amt, 0), 2) AS unallocated_amount
    FROM payments p
    JOIN suppliers s  ON s.id = p.supplier_id
    JOIN companies c  ON c.id = p.company_id
    LEFT JOIN bank_accounts ba ON ba.id = p.from_bank_account_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN (
      SELECT payment_id, SUM(amount) AS amt FROM payment_allocations GROUP BY payment_id
    ) al ON al.payment_id = p.id
`;

const RECEIPT_SELECT = `
  SELECT r.*,
         cu.name AS customer_name,
         cu.code AS customer_code,
         c.code AS company_code,
         c.name AS company_name,
         ba.bank_name AS to_bank_name,
         u.name AS created_by_name,
         ROUND(IFNULL(al.amt, 0), 2) AS allocated_amount,
         ROUND(r.amount - IFNULL(al.amt, 0), 2) AS unallocated_amount
    FROM receipts r
    JOIN customers cu ON cu.id = r.customer_id
    JOIN companies c  ON c.id = r.company_id
    LEFT JOIN bank_accounts ba ON ba.id = r.to_bank_account_id
    LEFT JOIN users u ON u.id = r.created_by
    LEFT JOIN (
      SELECT receipt_id, SUM(amount) AS amt FROM receipt_allocations GROUP BY receipt_id
    ) al ON al.receipt_id = r.id
`;

/** Add the derived ageing fields the screens colour by. */
function enrichInvoice(row, asOf) {
  if (!row) return row;
  const ref = asOf || today();
  const open = row.status !== 'CANCELLED' && money(row.outstanding) > 0.005;
  const daysOverdue = row.due_date ? daysBetween(row.due_date, ref) : null;
  const daysToDue = row.due_date ? daysBetween(ref, row.due_date) : null;
  return {
    ...row,
    is_open: open,
    is_submitted: !!row.submitted_date,
    days_overdue: daysOverdue !== null && daysOverdue > 0 ? daysOverdue : 0,
    days_to_due: daysToDue,
    is_overdue: open && daysOverdue !== null && daysOverdue > 0,
    is_due_soon: open && daysToDue !== null && daysToDue >= 0 && daysToDue <= 7,
    ageing_bucket: open ? ageingBucket(row.due_date, ref) : 'NOT_DUE'
  };
}

/** Recalculate an invoice status from what has been settled against it. */
function refreshInvoiceStatus(invoiceId) {
  const row = db
    .prepare(
      `SELECT i.total_amount, i.status,
              IFNULL((SELECT SUM(a.amount) FROM payment_allocations a
                        JOIN payments p ON p.id = a.payment_id
                       WHERE a.invoice_id = i.id AND ${SQL_SETTLED}), 0) AS paid
         FROM purchase_invoices i WHERE i.id = ?`
    )
    .get(invoiceId);
  if (!row) return;
  if (row.status === 'CANCELLED' || row.status === 'ON_HOLD') return;
  const paid = money(row.paid);
  const total = money(row.total_amount);
  let status = 'OPEN';
  if (paid >= total - 0.005 && total > 0) status = 'PAID';
  else if (paid > 0.005) status = 'PARTIALLY_PAID';
  db.prepare("UPDATE purchase_invoices SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, invoiceId);
}

function refreshSalesInvoiceStatus(invoiceId) {
  const row = db
    .prepare(
      `SELECT i.total_amount, i.status,
              IFNULL((SELECT SUM(a.amount) FROM receipt_allocations a
                        JOIN receipts p ON p.id = a.receipt_id
                       WHERE a.invoice_id = i.id AND ${SQL_SETTLED}), 0) AS paid
         FROM sales_invoices i WHERE i.id = ?`
    )
    .get(invoiceId);
  if (!row) return;
  if (row.status === 'CANCELLED' || row.status === 'ON_HOLD') return;
  const paid = money(row.paid);
  const total = money(row.total_amount);
  let status = 'OPEN';
  if (paid >= total - 0.005 && total > 0) status = 'PAID';
  else if (paid > 0.005) status = 'PARTIALLY_PAID';
  db.prepare("UPDATE sales_invoices SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, invoiceId);
}

/** Refresh every invoice a payment touches - used after edits and cheque updates. */
function refreshInvoicesForPayment(paymentId) {
  const ids = db
    .prepare('SELECT invoice_id FROM payment_allocations WHERE payment_id = ?')
    .all(paymentId)
    .map((r) => r.invoice_id);
  ids.forEach(refreshInvoiceStatus);
  return ids;
}

function refreshInvoicesForReceipt(receiptId) {
  const ids = db
    .prepare('SELECT invoice_id FROM receipt_allocations WHERE receipt_id = ?')
    .all(receiptId)
    .map((r) => r.invoice_id);
  ids.forEach(refreshSalesInvoiceStatus);
  return ids;
}

/** Advances paid to a supplier that have not been set against any invoice yet. */
function unallocatedAdvances(supplierId, companyId) {
  const params = [supplierId];
  let where = 'p.supplier_id = ?';
  if (companyId) {
    where += ' AND p.company_id = ?';
    params.push(companyId);
  }
  const row = db
    .prepare(
      `SELECT ROUND(IFNULL(SUM(p.amount - IFNULL(al.amt, 0)), 0), 2) AS amt
         FROM payments p
         LEFT JOIN (SELECT payment_id, SUM(amount) amt FROM payment_allocations GROUP BY payment_id) al
                ON al.payment_id = p.id
        WHERE ${where} AND ${SQL_SETTLED} AND (p.amount - IFNULL(al.amt, 0)) > 0.005`
    )
    .get(...params);
  return money(row ? row.amt : 0);
}

module.exports = {
  INVOICE_SELECT,
  SALES_SELECT,
  PAYMENT_SELECT,
  RECEIPT_SELECT,
  enrichInvoice,
  refreshInvoiceStatus,
  refreshSalesInvoiceStatus,
  refreshInvoicesForPayment,
  refreshInvoicesForReceipt,
  unallocatedAdvances
};
