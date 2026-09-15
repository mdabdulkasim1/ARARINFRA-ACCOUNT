/* Reports the owner actually asks for: ageing by supplier, the group position,
   where the money went, petty cash by employee, and the audit trail. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge, API } = C;

  // ---------------------------------------------------------------- ageing

  async function renderAgeing(host) {
    host.innerHTML = '<div class="loading">Working out the ageing&hellip;</div>';
    const qs = C.companyParam();
    const data = await API.get(`/api/reports/supplier-ageing${qs ? `?${qs}` : ''}`);
    const L = data.labels;

    host.innerHTML = `
      <div class="toolbar">
        <div>
          <h2 style="font-size:17px">Supplier ageing</h2>
          <div class="mini-note">
            How long each supplier has been waiting, counted from the due date.
            As at ${fmt.date(data.as_of)}.
          </div>
        </div>
        <div class="spacer"></div>
        <button class="btn" id="ageing-export">Export CSV</button>
        <button class="btn" onclick="window.print()">Print</button>
      </div>

      <div class="kpi-grid">
        <div class="kpi is-primary">
          <div class="label">Total outstanding</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.totals.total)}</div>
          <div class="foot">${fmt.int(data.rows.length)} suppliers &middot; ${fmt.int(data.totals.invoices)} invoices</div>
        </div>
        <div class="kpi is-ok">
          <div class="label">${esc(L.NOT_DUE)}</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.totals.NOT_DUE)}</div>
          <div class="foot">Inside the agreed credit period</div>
        </div>
        <div class="kpi is-warn">
          <div class="label">Overdue up to 60 days</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.totals.D1_30 + data.totals.D31_60)}</div>
          <div class="foot">Chase these before they age further</div>
        </div>
        <div class="kpi is-danger">
          <div class="label">Overdue over 60 days</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.totals.D61_90 + data.totals.D90_PLUS)}</div>
          <div class="foot">Clear these first</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Covered by cheques</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.totals.pdc)}</div>
          <div class="foot">Still to arrange: ${fmt.money(data.totals.net_payable)}</div>
        </div>
      </div>

      <div class="card">
        <header><h3>By supplier</h3><span class="sub">worst first</span></header>
        <div class="body tight">
          ${C.table(data.rows, [
            { label: 'Supplier', render: (r) => `<a href="#/supplier/${r.supplier_id}"><b>${esc(r.supplier_name)}</b></a><br><span class="mini-note">${esc(r.supplier_code)} &middot; ${fmt.int(r.invoices)} invoices</span>` },
            { label: L.NOT_DUE, num: true, render: (r) => cell(r.NOT_DUE) },
            { label: '1-30 days', num: true, render: (r) => cell(r.D1_30, 'warn') },
            { label: '31-60 days', num: true, render: (r) => cell(r.D31_60, 'warn') },
            { label: '61-90 days', num: true, render: (r) => cell(r.D61_90, 'danger') },
            { label: 'Over 90 days', num: true, render: (r) => cell(r.D90_PLUS, 'danger') },
            { label: 'No due date', num: true, render: (r) => cell(r.NO_DUE_DATE) },
            { label: 'Total', num: true, render: (r) => `<b>${fmt.money(r.total)}</b>` },
            { label: 'PDC issued', num: true, render: (r) => cell(r.pdc) },
            { label: 'To arrange', num: true, render: (r) => `<b>${fmt.money(r.net_payable)}</b>` }
          ], {
            empty: 'Nothing is outstanding',
            emptyIcon: '&#9989;',
            footer: [
              '<b>Total</b>',
              fmt.money(data.totals.NOT_DUE), fmt.money(data.totals.D1_30), fmt.money(data.totals.D31_60),
              fmt.money(data.totals.D61_90), fmt.money(data.totals.D90_PLUS), fmt.money(data.totals.NO_DUE_DATE),
              fmt.money(data.totals.total), fmt.money(data.totals.pdc), fmt.money(data.totals.net_payable)
            ]
          })}
        </div>
      </div>`;

    host.querySelector('#ageing-export').onclick = () =>
      C.downloadCsv(`supplier-ageing-${data.as_of}.csv`, [
        { label: 'Supplier code', key: 'supplier_code' },
        { label: 'Supplier', key: 'supplier_name' },
        { label: 'Invoices', key: 'invoices' },
        { label: 'Not due', key: 'NOT_DUE' },
        { label: 'Overdue 1-30', key: 'D1_30' },
        { label: 'Overdue 31-60', key: 'D31_60' },
        { label: 'Overdue 61-90', key: 'D61_90' },
        { label: 'Overdue 90+', key: 'D90_PLUS' },
        { label: 'No due date', key: 'NO_DUE_DATE' },
        { label: 'Total outstanding', key: 'total' },
        { label: 'PDC issued', key: 'pdc' },
        { label: 'Still to arrange', key: 'net_payable' }
      ], data.rows);
  }

  function cell(v, tone) {
    if (!v) return '<span class="mini-note">-</span>';
    if (tone === 'danger') return `<span class="amount-danger strong">${fmt.money(v)}</span>`;
    if (tone === 'warn') return `<span style="color:var(--warn);font-weight:600">${fmt.money(v)}</span>`;
    return fmt.money(v);
  }

  // ---------------------------------------------------------------- group

  async function renderGroup(host) {
    host.innerHTML = '<div class="loading">Pulling the group position together&hellip;</div>';
    const data = await API.get('/api/reports/group-summary');
    const t = data.totals;

    host.innerHTML = `
      <div class="toolbar">
        <div>
          <h2 style="font-size:17px">${esc(C.State.groupName)}</h2>
          <div class="mini-note">All companies side by side, as at ${fmt.date(data.as_of)}. Year to date figures are for ${esc(data.year)}.</div>
        </div>
        <div class="spacer"></div>
        <button class="btn" id="group-export">Export CSV</button>
        <button class="btn" onclick="window.print()">Print</button>
      </div>

      <div class="kpi-grid">
        <div class="kpi is-primary">
          <div class="label">Group payable</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.payable)}</div>
          <div class="foot">${fmt.int(t.open_invoices)} open invoices</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">PDC issued</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.pdc_issued)}</div>
          <div class="foot">Cheques out, waiting to clear</div>
        </div>
        <div class="kpi is-primary">
          <div class="label">Still to arrange</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.net_payable)}</div>
          <div class="foot">Payable less the cheques</div>
        </div>
        <div class="kpi is-danger">
          <div class="label">Overdue</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.overdue)}</div>
          <div class="foot">${fmt.int(t.overdue_count)} invoices</div>
        </div>
        <div class="kpi is-ok">
          <div class="label">Receivable</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.receivable)}</div>
          <div class="foot">Owed to the group by customers</div>
        </div>
      </div>

      <div class="card">
        <header><h3>Company by company</h3></header>
        <div class="body tight">
          ${C.table(data.rows, [
            { label: 'Company', render: (r) => `<b>${esc(r.name)}</b><br><span class="mini-note">${esc(r.code)}</span>` },
            { label: 'Open invoices', num: true, render: (r) => fmt.int(r.open_invoices) },
            { label: 'Payable', num: true, render: (r) => fmt.money(r.payable) },
            { label: 'PDC issued', num: true, render: (r) => fmt.money(r.pdc_issued) },
            { label: 'To arrange', num: true, render: (r) => `<b>${fmt.money(r.net_payable)}</b>` },
            { label: 'Overdue', num: true, render: (r) => cell(r.overdue, 'danger') },
            { label: 'Receivable', num: true, render: (r) => fmt.money(r.receivable) },
            { label: 'Paid out YTD', num: true, render: (r) => fmt.money(r.spend_ytd) },
            { label: 'Received YTD', num: true, render: (r) => fmt.money(r.income_ytd) },
            { label: 'Petty cash YTD', num: true, render: (r) => fmt.money(r.petty_ytd) }
          ], {
            empty: 'No companies set up',
            footer: [
              '<b>Group</b>', fmt.int(t.open_invoices), fmt.money(t.payable), fmt.money(t.pdc_issued),
              fmt.money(t.net_payable), fmt.money(t.overdue), fmt.money(t.receivable),
              fmt.money(t.spend_ytd), fmt.money(t.income_ytd), fmt.money(t.petty_ytd)
            ]
          })}
        </div>
      </div>`;

    host.querySelector('#group-export').onclick = () =>
      C.downloadCsv(`group-summary-${data.as_of}.csv`, [
        { label: 'Code', key: 'code' }, { label: 'Company', key: 'name' },
        { label: 'Open invoices', key: 'open_invoices' }, { label: 'Payable', key: 'payable' },
        { label: 'PDC issued', key: 'pdc_issued' }, { label: 'Still to arrange', key: 'net_payable' },
        { label: 'Overdue', key: 'overdue' }, { label: 'Receivable', key: 'receivable' },
        { label: 'Paid out YTD', key: 'spend_ytd' }, { label: 'Received YTD', key: 'income_ytd' },
        { label: 'Petty cash YTD', key: 'petty_ytd' }
      ], data.rows);
  }

  // ---------------------------------------------------------------- cash out

  async function renderCashOut(host) {
    const from = C.addDays(C.today(), -30);
    host.innerHTML = `
      <div class="toolbar">
        <div><h2 style="font-size:17px">Where the money went</h2>
          <div class="mini-note">Every payment recorded in the period, by mode.</div></div>
        <div class="spacer"></div>
        <div class="field"><label>From</label><input type="date" id="co-from" value="${from}"></div>
        <div class="field"><label>To</label><input type="date" id="co-to" value="${C.today()}"></div>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
      <div id="co-body"><div class="loading">Loading&hellip;</div></div>`;

    const load = async () => {
      const box = host.querySelector('#co-body');
      box.innerHTML = '<div class="loading">Loading&hellip;</div>';
      const params = new URLSearchParams({
        from: host.querySelector('#co-from').value,
        to: host.querySelector('#co-to').value
      });
      if (C.State.companyId) params.set('company_id', C.State.companyId);
      const data = await API.get(`/api/reports/cash-out?${params}`);

      box.innerHTML = `
        <div class="kpi-grid">
          <div class="kpi is-primary">
            <div class="label">Paid to suppliers</div>
            <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.total)}</div>
            <div class="foot">${fmt.int(data.rows.length)} payments</div>
          </div>
          ${data.by_mode.map((m) => `
            <div class="kpi is-accent">
              <div class="label">${esc(C.MODE_LABEL[m.mode] || m.mode)}</div>
              <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(m.amount)}</div>
              <div class="foot">${fmt.int(m.count)} payments &middot; ${fmt.money(m.settled)} settled</div>
            </div>`).join('')}
          <div class="kpi is-warn">
            <div class="label">Petty cash paid</div>
            <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.petty_cash_paid)}</div>
            <div class="foot">${fmt.int(data.petty_cash_count)} requests</div>
          </div>
        </div>

        <div class="card">
          <header><h3>Payment register</h3>
            <span class="sub">${fmt.date(data.from)} to ${fmt.date(data.to)}</span></header>
          <div class="body tight">
            ${C.table(data.rows, [
              { label: 'Date', render: (r) => fmt.date(r.payment_date) },
              { label: 'Reference', mono: true, render: (r) => esc(r.payment_no) },
              { label: 'Supplier', render: (r) => esc(r.supplier_name) },
              { label: 'Company', render: (r) => esc(r.company_code) },
              { label: 'Mode', render: (r) => esc(C.MODE_LABEL[r.mode] || r.mode) },
              { label: 'Bank / cheque', render: (r) =>
                  `<span class="mini-note">${esc(r.party_bank_name || r.cheque_bank_name || '-')}
                   ${r.cheque_no ? ` &middot; chq ${esc(r.cheque_no)}` : ''}
                   ${r.transfer_ref ? ` &middot; ${esc(r.transfer_ref)}` : ''}</span>` },
              { label: 'Status', render: (r) => r.pdc_status ? badge(r.pdc_status) : badge(r.status) },
              { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` }
            ], {
              empty: 'No payments in this period',
              footer: ['<b>Total</b>', '', '', '', '', '', '', fmt.money(data.total)]
            })}
          </div>
        </div>`;
    };

    host.querySelector('#co-from').onchange = load;
    host.querySelector('#co-to').onchange = load;
    await load();
  }

  // ---------------------------------------------------------------- petty cash

  async function renderPettySummary(host) {
    const from = `${C.today().slice(0, 4)}-01-01`;
    host.innerHTML = `
      <div class="toolbar">
        <div><h2 style="font-size:17px">Petty cash by employee</h2>
          <div class="mini-note">Who is drawing petty cash, how much, and on what.</div></div>
        <div class="spacer"></div>
        <div class="field"><label>From</label><input type="date" id="pcs-from" value="${from}"></div>
        <div class="field"><label>To</label><input type="date" id="pcs-to" value="${C.today()}"></div>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
      <div id="pcs-body"><div class="loading">Loading&hellip;</div></div>`;

    const load = async () => {
      const box = host.querySelector('#pcs-body');
      box.innerHTML = '<div class="loading">Loading&hellip;</div>';
      const params = new URLSearchParams({
        from: host.querySelector('#pcs-from').value,
        to: host.querySelector('#pcs-to').value
      });
      if (C.State.companyId) params.set('company_id', C.State.companyId);
      const data = await API.get(`/api/reports/petty-cash-summary?${params}`);
      const paidTotal = data.by_employee.reduce((s, r) => s + r.paid, 0);

      box.innerHTML = `
        <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:16px;align-items:start" class="dash-split">
          <div class="card">
            <header><h3>By employee</h3></header>
            <div class="body tight">
              ${C.table(data.by_employee, [
                { label: 'Employee', render: (r) => `<b>${esc(r.employee_name)}</b><br><span class="mini-note">${esc(r.employee_code)}${r.department ? ` &middot; ${esc(r.department)}` : ''}</span>` },
                { label: 'Requests', num: true, render: (r) => fmt.int(r.requests) },
                { label: 'Requested', num: true, render: (r) => fmt.money(r.requested) },
                { label: 'Paid', num: true, render: (r) => `<b>${fmt.money(r.paid)}</b>` },
                { label: 'Waiting', num: true, render: (r) => r.awaiting ? `<span style="color:var(--warn);font-weight:600">${fmt.money(r.awaiting)}</span>` : '-' },
                { label: 'Approved, unpaid', num: true, render: (r) => r.approved_unpaid ? fmt.money(r.approved_unpaid) : '-' },
                { label: 'Rejected', num: true, render: (r) => r.rejected ? `<span class="amount-danger">${fmt.int(r.rejected)}</span>` : '-' }
              ], {
                empty: 'No petty cash in this period',
                emptyIcon: '&#128176;',
                footer: ['<b>Total</b>', '', '', fmt.money(paidTotal), '', '', '']
              })}
            </div>
          </div>
          <div class="card">
            <header><h3>What it was spent on</h3><span class="sub">paid requests only</span></header>
            <div class="body">${catBars(data.by_category)}</div>
          </div>
        </div>

        <div class="card">
          <header><h3>Month by month</h3></header>
          <div class="body">${monthBars(data.by_month)}</div>
        </div>`;
    };

    host.querySelector('#pcs-from').onchange = load;
    host.querySelector('#pcs-to').onchange = load;
    await load();
  }

  function catBars(rows) {
    if (!rows.length) return '<div class="empty"><div class="big">&#128176;</div><div>Nothing paid out yet</div></div>';
    const max = Math.max(1, ...rows.map((r) => r.amount));
    return `<div class="bars">${rows.map((r) => `
      <div class="bar-row">
        <div>${esc(r.category)}<br><span class="cnt">${fmt.int(r.requests)} request(s)</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, (r.amount / max) * 100)}%;background:#8a5a00"></div></div>
        <div class="amt">${fmt.money(r.amount)}</div>
      </div>`).join('')}</div>`;
  }

  function monthBars(rows) {
    if (!rows.length) return '<div class="empty"><div class="big">&#128197;</div><div>No requests in this period</div></div>';
    const max = Math.max(1, ...rows.map((r) => r.paid));
    return `<div class="bars">${rows.map((r) => `
      <div class="bar-row">
        <div>${esc(fmt.month(r.month))}<br><span class="cnt">${fmt.int(r.requests)} request(s)</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, (r.paid / max) * 100)}%;background:#1c456c"></div></div>
        <div class="amt">${fmt.money(r.paid)}</div>
      </div>`).join('')}</div>`;
  }

  // ---------------------------------------------------------------- payable forecast

  const forecastState = { basis: 'assumed', terms: 90, day: 5, months: 12 };

  /** Supplier down the side, month across the top - when the cash is needed. */
  async function renderForecast(host) {
    host.innerHTML = `
      <div class="toolbar">
        <div>
          <h2 style="font-size:17px">Payable by supplier and month</h2>
          <div class="mini-note">What each supplier is owed, placed in the month the money falls due.</div>
        </div>
        <div class="spacer"></div>
        <div class="field">
          <label>Work out the due month from</label>
          <select id="fc-basis">
            <option value="assumed">A fixed credit period</option>
            <option value="actual">Each invoice's own terms</option>
          </select>
        </div>
        <div class="field" id="fc-terms-wrap">
          <label>Credit period</label>
          <select id="fc-terms"></select>
        </div>
        <div class="field" id="fc-day-wrap">
          <label>Submitted on day</label>
          <input type="number" id="fc-day" min="1" max="28" value="${forecastState.day}" style="width:82px">
        </div>
        <button class="btn" id="fc-export">Export CSV</button>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
      <div id="fc-body"><div class="loading">Working out the forecast&hellip;</div></div>`;

    const termsSel = host.querySelector('#fc-terms');
    termsSel.innerHTML = C.TERM_OPTIONS
      .map((o) => `<option value="${o.value}" ${o.value === forecastState.terms ? 'selected' : ''}>${esc(o.label)}</option>`)
      .join('');
    host.querySelector('#fc-basis').value = forecastState.basis;

    const sync = () => {
      const assumed = host.querySelector('#fc-basis').value === 'assumed';
      host.querySelector('#fc-terms-wrap').hidden = !assumed;
      host.querySelector('#fc-day-wrap').hidden = !assumed;
    };
    const reload = () => {
      forecastState.basis = host.querySelector('#fc-basis').value;
      forecastState.terms = Number(termsSel.value);
      forecastState.day = Number(host.querySelector('#fc-day').value || 5);
      sync();
      draw(host);
    };
    host.querySelector('#fc-basis').onchange = reload;
    termsSel.onchange = reload;
    host.querySelector('#fc-day').onchange = reload;
    sync();

    await draw(host);
  }

  async function draw(host) {
    const box = host.querySelector('#fc-body');
    box.innerHTML = '<div class="loading">Working out the forecast&hellip;</div>';

    const params = new URLSearchParams({
      basis: forecastState.basis,
      terms: String(forecastState.terms),
      day: String(forecastState.day),
      months: String(forecastState.months)
    });
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    const d = await API.get(`/api/reports/supplier-forecast?${params}`);

    if (!d.rows.length) {
      box.innerHTML = '<div class="card"><div class="empty"><div class="big">&#128202;</div>' +
        '<div>Nothing is outstanding</div></div></div>';
      return;
    }

    const cur = esc(C.State.currency);
    const peak = d.months.reduce((best, m) =>
      (d.month_totals[m] || 0) > (d.month_totals[best] || 0) ? m : best, d.months[0]);

    const columns = [
      // Wide enough that a long trading name does not wrap into five lines and
      // drag every month column down with it.
      { label: 'Supplier', width: '250px', render: (r) =>
          `<a href="#/supplier/${r.supplier_id}"><b>${esc(r.supplier_name)}</b></a>
           <br><span class="mini-note">${esc(r.supplier_code)} &middot; ${fmt.int(r.invoices)} invoice(s)</span>` }
    ].concat(d.months.map((m) => ({
      label: fmt.month(m), num: true,
      render: (r) => r.months[m]
        ? `<span class="${m === peak ? 'strong' : ''}">${fmt.money(r.months[m])}</span>`
        : '<span class="mini-note">-</span>'
    }))).concat([
      { label: 'Total', num: true, render: (r) => `<b>${fmt.money(r.total)}</b>` }
    ]);

    box.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi is-primary">
          <div class="label">Total payable</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(d.total)}</div>
          <div class="foot">${fmt.int(d.supplier_count)} suppliers</div>
        </div>
        <div class="kpi is-warn">
          <div class="label">Heaviest month</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(d.month_totals[peak] || 0)}</div>
          <div class="foot">${esc(fmt.month(peak))}</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Months covered</div>
          <div class="value">${fmt.int(d.months.length)}</div>
          <div class="foot">${d.basis === 'assumed'
            ? `Assuming ${d.terms} days from the ${ordinal(d.anchor_day)} of the month submitted`
            : "Using each invoice's own terms"}</div>
        </div>
        ${d.unscheduled ? `
          <div class="kpi is-danger">
            <div class="label">No date to place it</div>
            <div class="value"><span class="cur">${cur}</span>${fmt.compact(d.unscheduled)}</div>
            <div class="foot">Invoices with no submitted date</div>
          </div>` : ''}
      </div>

      <div class="card">
        <header>
          <h3>Supplier by month</h3>
          <span class="sub">${d.basis === 'assumed'
            ? `submitted on the ${ordinal(d.anchor_day)}, paid ${d.terms} days later`
            : "each invoice's own due date"}</span>
        </header>
        <div class="body tight" id="fc-table"></div>
      </div>`;

    box.querySelector('#fc-table').innerHTML = C.table(d.rows, columns, {
      empty: 'Nothing outstanding',
      footer: ['<b>Total</b>']
        .concat(d.months.map((m) => `<b>${fmt.money(d.month_totals[m] || 0)}</b>`))
        .concat([`<b>${fmt.money(d.total)}</b>`])
    });

    host.querySelector('#fc-export').onclick = () => {
      C.downloadCsv(`payable-by-supplier-and-month-${C.today()}.csv`,
        [{ label: 'Supplier', key: 'supplier_name' }, { label: 'Code', key: 'supplier_code' }]
          .concat(d.months.map((m) => ({ label: fmt.month(m), value: (r) => r.months[m] || 0 })))
          .concat([{ label: 'Total', key: 'total' }]),
        d.rows);
    };
  }

  function ordinal(n) {
    const v = Number(n);
    const suffix = (v % 10 === 1 && v !== 11) ? 'st'
      : (v % 10 === 2 && v !== 12) ? 'nd'
      : (v % 10 === 3 && v !== 13) ? 'rd' : 'th';
    return `${v}${suffix}`;
  }

  // ---------------------------------------------------------------- audit

  async function renderAudit(host) {
    host.innerHTML = `
      <div class="toolbar">
        <div><h2 style="font-size:17px">Audit trail</h2>
          <div class="mini-note">Every entry, edit, approval and deletion, with who did it.</div></div>
        <div class="spacer"></div>
        <div class="field">
          <label>Area</label>
          <select id="audit-entity">
            <option value="">Everything</option>
            <option value="purchase_invoice">Supplier invoices</option>
            <option value="payment">Payments</option>
            <option value="petty_cash">Petty cash</option>
            <option value="sales_invoice">Customer invoices</option>
            <option value="receipt">Receipts</option>
            <option value="supplier">Suppliers</option>
            <option value="user">Users</option>
          </select>
        </div>
      </div>
      <div class="card"><div class="body tight" id="audit-table"><div class="loading">Loading&hellip;</div></div></div>`;

    const load = async () => {
      const entity = host.querySelector('#audit-entity').value;
      const rows = await API.get(`/api/reports/audit?limit=400${entity ? `&entity=${entity}` : ''}`);
      host.querySelector('#audit-table').innerHTML = C.table(rows, [
        { label: 'When', render: (r) => `<span class="nowrap">${fmt.dateTime(r.created_at)}</span>` },
        { label: 'Who', render: (r) => `<b>${esc(r.user_name || 'system')}</b>` },
        { label: 'Action', render: (r) => badge(r.action, actionTone(r.action)) },
        { label: 'Area', render: (r) => `<span class="mini-note">${esc(fmt.label(r.entity))}</span>` },
        { label: 'What happened', render: (r) => esc(r.summary || '') }
      ], { empty: 'Nothing recorded yet', emptyIcon: '&#128220;' });
    };
    host.querySelector('#audit-entity').onchange = load;
    await load();
  }

  function actionTone(action) {
    if (['DELETE', 'REJECT', 'CANCEL'].includes(action)) return 'red';
    if (['APPROVE', 'PAY', 'CREATE'].includes(action)) return 'green';
    if (['UPDATE', 'VERIFY', 'ALLOCATE', 'PDC_STATUS'].includes(action)) return 'blue';
    return 'grey';
  }

  window.Reports = {
    renderAgeing, renderGroup, renderCashOut, renderPettySummary, renderAudit, renderForecast
  };
})();
