/* The owner's first screen: how much is payable, how much is out in cheques,
   what is overdue, and what is waiting for an approval. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge } = C;

  async function render(host) {
    host.innerHTML = '<div class="loading">Loading the group position&hellip;</div>';
    const qs = C.companyParam();
    const data = await C.API.get(`/api/reports/dashboard${qs ? `?${qs}` : ''}`);
    const k = data.kpi;
    const scopeLabel = C.State.companyId ? C.companyName(C.State.companyId) : 'the whole group';

    host.innerHTML = `
      <div class="kpi-grid">
        ${kpi({
          href: '#/payables?view=open', cls: 'is-primary', label: 'Payable to suppliers',
          value: k.payable_total,
          foot: `${fmt.int(k.open_invoice_count)} open invoices from ${fmt.int(k.supplier_count)} suppliers`
        })}
        ${kpi({
          href: '#/pdc', cls: 'is-accent', label: 'PDC issued',
          value: k.pdc_outstanding_total,
          foot: `${fmt.int(k.pdc_outstanding_count)} cheques not yet cleared &middot; ${fmt.money(k.pdc_due_30_amount)} due within 30 days`
        })}
        ${kpi({
          href: '#/payables?view=open', cls: 'is-primary', label: 'Still to arrange',
          value: k.net_payable,
          foot: 'Payable less the cheques already handed over'
        })}
        ${kpi({
          href: '#/payables?view=overdue', cls: 'is-danger', label: 'Overdue',
          value: k.overdue_amount,
          foot: `${fmt.int(k.overdue_count)} invoices past their due date`
        })}
        ${kpi({
          href: '#/payables?view=due_soon', cls: 'is-warn', label: 'Falling due in 7 days',
          value: k.due_7_amount,
          foot: `${fmt.int(k.due_30_count)} invoices &middot; ${fmt.money(k.due_30_amount)} within 30 days`
        })}
        ${kpi({
          href: '#/payments?view=advances_open', cls: 'is-accent', label: 'Advances on account',
          value: k.advance_unallocated,
          foot: `${fmt.int(k.advance_count)} advances not yet set against an invoice`
        })}
        ${kpi({
          href: '#/petty?view=awaiting_me', cls: k.petty_awaiting_approval_count ? 'is-warn' : 'is-ok',
          label: 'Petty cash to approve',
          value: k.petty_awaiting_approval_amount,
          foot: `${fmt.int(k.petty_awaiting_approval_count)} requests waiting &middot; ${fmt.int(k.petty_approved_unpaid_count)} approved, not paid`
        })}
        ${kpi({
          href: '#/income', cls: 'is-ok', label: 'Receivable from customers',
          value: k.receivable_total,
          foot: `${fmt.int(k.receivable_count)} invoices outstanding`
        })}
      </div>

      ${k.pdc_past_date_count ? `
        <div class="alert warn">
          <b>${fmt.int(k.pdc_past_date_count)} cheque(s) worth ${fmt.money(k.pdc_past_date_amount)} ${C.State.currency}</b>
          are dated in the past but have not been marked cleared. Check with the bank and update the cheque status.
          <a href="#/pdc">Open the cheque register</a>
        </div>` : ''}

      ${k.not_submitted_count ? `
        <div class="alert">
          <b>${fmt.int(k.not_submitted_count)} invoice(s) worth ${fmt.money(k.not_submitted_amount)} ${C.State.currency}</b>
          have no submitted date, so the credit period has not started counting.
          <a href="#/payables?view=unsubmitted">Review them</a>
        </div>` : ''}

      <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:16px;align-items:start" class="dash-split">
        <div class="card">
          <header>
            <h3>How old the payables are</h3>
            <span class="sub">by days past the due date</span>
          </header>
          <div class="body">
            ${ageingBars(data.ageing)}
            <div class="legend" style="margin-top:14px">
              <span><i style="background:#8aa4bd"></i>Not yet due</span>
              <span><i style="background:#e0b661"></i>1-60 days late</span>
              <span><i style="background:#c9553f"></i>61-90 days late</span>
              <span><i style="background:#8f1f16"></i>Over 90 days late</span>
            </div>
          </div>
        </div>

        <div class="card">
          <header>
            <h3>Cheques coming up</h3>
            <span class="spacer"></span>
            <a class="btn small" href="#/pdc">All cheques</a>
          </header>
          <div class="body tight">
            ${C.table(data.upcoming_pdc.slice(0, 8), [
              { label: 'Cheque date', render: (r) => `<span class="nowrap ${r.cheque_date < C.today() ? 'amount-danger' : ''}">${fmt.date(r.cheque_date)}</span>` },
              { label: 'Cheque no', key: 'cheque_no', mono: true },
              { label: 'Supplier', render: (r) => esc(r.supplier_name) },
              { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` }
            ], { empty: 'No cheques are waiting to clear', emptyIcon: '&#128179;' })}
          </div>
        </div>
      </div>

      <div class="card">
        <header>
          <h3>Company by company</h3>
          <span class="sub">${esc(scopeLabel)} as at ${fmt.date(data.as_of)}</span>
          <span class="spacer"></span>
          <a class="btn small" href="#/group">Full group report</a>
        </header>
        <div class="body tight">
          ${C.table(data.by_company, [
            { label: 'Company', render: (r) => `<b>${esc(r.name)}</b> <span class="mini-note">${esc(r.code)}</span>` },
            { label: 'Open invoices', num: true, render: (r) => fmt.int(r.open_invoices) },
            { label: 'Payable', num: true, render: (r) => fmt.money(r.payable) },
            { label: 'PDC issued', num: true, render: (r) => fmt.money(r.pdc_issued) },
            { label: 'Still to arrange', num: true, render: (r) => `<b>${fmt.money(r.net_payable)}</b>` },
            { label: 'Overdue', num: true, render: (r) =>
                r.overdue > 0
                  ? `<span class="amount-danger">${fmt.money(r.overdue)}</span> <span class="mini-note">(${r.overdue_count})</span>`
                  : '<span class="mini-note">none</span>' }
          ], {
            empty: 'No companies set up yet',
            footer: [
              '<b>Group total</b>',
              fmt.int(sum(data.by_company, 'open_invoices')),
              fmt.money(sum(data.by_company, 'payable')),
              fmt.money(sum(data.by_company, 'pdc_issued')),
              `<b>${fmt.money(sum(data.by_company, 'net_payable'))}</b>`,
              `<span class="amount-danger">${fmt.money(sum(data.by_company, 'overdue'))}</span>`
            ]
          })}
        </div>
      </div>

      <div class="card">
        <header>
          <h3>Overdue invoices</h3>
          <span class="sub">clear these first</span>
          <span class="spacer"></span>
          <a class="btn small" href="#/payables?view=overdue">See all</a>
        </header>
        <div class="body tight">
          ${C.table(data.overdue_invoices, [
            { label: 'Supplier', render: (r) => `<b>${esc(r.supplier_name)}</b>` },
            { label: 'Invoice no', key: 'invoice_no', mono: true },
            { label: 'Company', render: (r) => `<span class="mini-note">${esc(r.company_code)}</span>` },
            { label: 'Submitted', render: (r) => fmt.date(r.submitted_date) },
            { label: 'Due', render: (r) => `<span class="nowrap">${fmt.date(r.due_date)}</span>` },
            { label: 'Late by', num: true, render: (r) => `<span class="amount-danger strong">${r.days_overdue} days</span>` },
            { label: 'Outstanding', num: true, render: (r) => `<b>${fmt.money(r.outstanding)}</b>` },
            { label: '', render: (r) => `<button class="btn small" data-pay="${r.id}">Pay</button>` }
          ], {
            empty: 'Nothing is overdue',
            emptyIcon: '&#9989;',
            emptyHint: 'Every submitted invoice is still inside its credit period.',
            rowClass: () => 'row-overdue'
          })}
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start" class="dash-split">
        <div class="card">
          <header><h3>Who we owe the most</h3></header>
          <div class="body tight">
            ${C.table(data.top_suppliers, [
              { label: 'Supplier', render: (r) => `<a href="#/supplier/${r.supplier_id}">${esc(r.supplier_name)}</a>` },
              { label: 'Invoices', num: true, render: (r) => fmt.int(r.invoices) },
              { label: 'Outstanding', num: true, render: (r) => fmt.money(r.outstanding) },
              { label: 'Overdue', num: true, render: (r) =>
                  r.overdue > 0 ? `<span class="amount-danger">${fmt.money(r.overdue)}</span>` : '<span class="mini-note">-</span>' }
            ], { empty: 'No open supplier balances' })}
          </div>
        </div>

        <div class="card">
          <header><h3>Money out, last six months</h3></header>
          <div class="body">
            ${monthlyBars(data.monthly_cash_out, data.monthly_income)}
          </div>
        </div>
      </div>`;

    host.querySelectorAll('[data-pay]').forEach((btn) => {
      btn.onclick = () => window.Payables.openPaymentForInvoice(Number(btn.dataset.pay), () => render(host));
    });

    host.querySelectorAll('[data-bucket]').forEach((bar) => {
      bar.onclick = () => showBucket(bar.dataset.bucket, bar.dataset.label);
    });
  }

  function kpi(o) {
    return `
      <a class="kpi ${o.cls || ''}" href="${o.href || '#'}">
        <div class="label">${o.label}</div>
        <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(o.value)}</div>
        <div class="foot">${o.foot || ''}</div>
      </a>`;
  }

  function sum(rows, key) {
    return rows.reduce((s, r) => s + Number(r[key] || 0), 0);
  }

  const BUCKET_COLOUR = {
    NOT_DUE: '#8aa4bd',
    D1_30: '#e0b661',
    D31_60: '#d99441',
    D61_90: '#c9553f',
    D90_PLUS: '#8f1f16',
    NO_DUE_DATE: '#b6bfc9'
  };

  function ageingBars(buckets) {
    const max = Math.max(1, ...buckets.map((b) => b.amount));
    if (!buckets.some((b) => b.amount > 0)) {
      return '<div class="empty"><div class="big">&#128202;</div><div>Nothing is outstanding</div></div>';
    }
    // A bar with nothing in it has nobody to show, so only the ones carrying
    // money become buttons.
    return `<div class="bars">${buckets.map((b) => {
      const inner = `
        <div>${esc(b.label)}<br><span class="cnt">${fmt.int(b.count)} invoice(s)</span></div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.max(1, (b.amount / max) * 100)}%;background:${BUCKET_COLOUR[b.bucket]}"></div>
        </div>
        <div class="amt">${fmt.money(b.amount)}</div>`;
      return b.amount > 0
        ? `<button type="button" class="bar-row is-clickable" data-bucket="${esc(b.bucket)}"
                   data-label="${esc(b.label)}" title="See which suppliers make up this">${inner}</button>`
        : `<div class="bar-row">${inner}</div>`;
    }).join('')}</div>`;
  }

  /**
   * Who is behind one bar of the ageing chart.
   *
   * The chart answers how much is late; the owner's next question is always who,
   * so clicking a bar opens the suppliers that make it up, biggest first, with a
   * way straight through to each one's statement.
   */
  async function showBucket(bucket, label) {
    const qs = C.companyParam();
    const data = await C.API.get(`/api/reports/supplier-ageing${qs ? `?${qs}` : ''}`);

    const rows = data.rows
      .filter((r) => r[bucket] > 0.005)
      .map((r) => ({
        supplier_id: r.supplier_id,
        supplier_name: r.supplier_name,
        supplier_code: r.supplier_code,
        amount: r[bucket],
        invoices: (r.counts && r.counts[bucket]) || 0,
        oldest: (r.oldest && r.oldest[bucket]) || null,
        total: r.total
      }))
      .sort((a, b) => b.amount - a.amount);

    const total = rows.reduce((t, r) => t + r.amount, 0);
    const invoices = rows.reduce((t, r) => t + r.invoices, 0);
    const late = bucket !== 'NOT_DUE' && bucket !== 'NO_DUE_DATE';

    C.Modal.open({
      title: label,
      subtitle: `${fmt.int(rows.length)} supplier(s) \u00b7 ${fmt.int(invoices)} invoice(s) ` +
                `\u00b7 ${fmt.money(total)} ${C.State.currency} as at ${fmt.date(data.as_of)}`,
      size: 'wide',
      body: `<div class="tight">${C.table(rows, [
        { label: 'Supplier', render: (r) =>
            `<a href="#/supplier/${r.supplier_id}" data-close-modal><b>${esc(r.supplier_name)}</b></a>` +
            ` <span class="mini-note">${esc(r.supplier_code || '')}</span>` },
        { label: 'Invoices', num: true, render: (r) => fmt.int(r.invoices) },
        { label: late ? 'Due since' : 'Due', hidePhone: true, render: (r) =>
            r.oldest ? `<span class="nowrap">${fmt.date(r.oldest)}</span>` : '<span class="mini-note">-</span>' },
        { label: 'In this bucket', num: true, render: (r) =>
            `<b class="${late ? 'amount-danger' : ''}">${fmt.money(r.amount)}</b>` },
        { label: 'Owed in total', num: true, hidePhone: true, render: (r) => fmt.money(r.total) }
      ], {
        empty: 'Nothing sits in this bucket',
        footer: [
          '<b>Total</b>',
          fmt.int(invoices),
          '',
          `<b class="${late ? 'amount-danger' : ''}">${fmt.money(total)}</b>`,
          ''
        ]
      })}</div>`,
      footer: `<button class="btn" data-act="close">Close</button>
               <a class="btn primary" href="#/ageing" data-close-modal>Full ageing report</a>`,
      onMount(modal) {
        modal.querySelector('[data-act="close"]').onclick = () => C.Modal.close();
        modal.querySelectorAll('[data-close-modal]').forEach((a) => {
          a.addEventListener('click', () => C.Modal.close());
        });
      }
    });
  }

  function monthlyBars(cashOut, income) {
    const months = [...new Set([...cashOut.map((r) => r.month), ...income.map((r) => r.month)])].sort();
    if (!months.length) {
      return '<div class="empty"><div class="big">&#128200;</div><div>No payments recorded yet</div></div>';
    }
    const outBy = Object.fromEntries(cashOut.map((r) => [r.month, r]));
    const inBy = Object.fromEntries(income.map((r) => [r.month, r.amount]));
    const max = Math.max(1, ...months.map((m) => Math.max(outBy[m] ? outBy[m].amount : 0, inBy[m] || 0)));

    return `<div class="bars">${months.map((m) => {
      const o = outBy[m] || { amount: 0, cash: 0, transfer: 0, cheque: 0 };
      const i = inBy[m] || 0;
      return `
        <div class="bar-row">
          <div>${esc(fmt.month(m))}<br><span class="cnt">out / in</span></div>
          <div>
            <div class="bar-track" style="margin-bottom:3px">
              <div class="bar-fill" style="width:${Math.max(1, (o.amount / max) * 100)}%;background:#c9553f"></div>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style="width:${Math.max(1, (i / max) * 100)}%;background:#1a6d3f"></div>
            </div>
          </div>
          <div class="amt">
            <span class="amount-danger">${fmt.compact(o.amount)}</span><br>
            <span class="amount-ok">${fmt.compact(i)}</span>
          </div>
        </div>`;
    }).join('')}</div>`;
  }

  window.Dashboard = { render, title: 'Dashboard' };
})();
