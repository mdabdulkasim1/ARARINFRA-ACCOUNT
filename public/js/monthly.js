/* Two screens:
   - Monthly payments: pick a month, see everything owed that month in one place
   - Bank facilities: vehicle and equipment loans, and letters of credit */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge, API, Modal, toast } = C;
  const P = () => window.Payables;

  // ================================================================ monthly payments

  let selectedMonth = C.today().slice(0, 7);
  let calendarFrom = null;

  function shiftMonth(month, by) {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + by);
    return d.toISOString().slice(0, 7);
  }

  async function renderMonthly(host, query) {
    if (query && query.month) selectedMonth = query.month;
    if (!calendarFrom) calendarFrom = `${shiftMonth(selectedMonth, -2)}-01`;

    host.innerHTML = `
      <div class="toolbar">
        <div>
          <h2 style="font-size:17px">What has to be paid</h2>
          <div class="mini-note">Pick a month to see every commitment falling due in it.</div>
        </div>
        <div class="spacer"></div>
        <button class="btn" id="cal-back">&larr; Earlier</button>
        <button class="btn" id="cal-fwd">Later &rarr;</button>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
      <div id="cal-strip"><div class="loading">Loading the months&hellip;</div></div>
      <div id="month-detail"></div>`;

    host.querySelector('#cal-back').onclick = () => {
      calendarFrom = `${shiftMonth(calendarFrom.slice(0, 7), -6)}-01`;
      drawStrip(host);
    };
    host.querySelector('#cal-fwd').onclick = () => {
      calendarFrom = `${shiftMonth(calendarFrom.slice(0, 7), 6)}-01`;
      drawStrip(host);
    };

    await drawStrip(host);
    await drawMonth(host);
  }

  async function drawStrip(host) {
    const box = host.querySelector('#cal-strip');
    const params = new URLSearchParams({ from: calendarFrom, months: '12' });
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    const data = await API.get(`/api/reports/commitment-calendar?${params}`);

    const max = Math.max(1, ...data.months.map((m) => m.total));
    box.innerHTML = `
      <div class="card"><div class="body">
        <div class="month-strip">
          ${data.months.map((m) => `
            <button class="month-chip ${m.month === selectedMonth ? 'active' : ''}
                    ${m.month === C.today().slice(0, 7) ? 'is-now' : ''}"
                    data-month="${m.month}">
              <span class="mc-label">${esc(fmt.month(m.month))}</span>
              <span class="mc-amount">${m.total ? fmt.compact(m.total) : '&mdash;'}</span>
              <span class="mc-bar"><i style="height:${Math.max(2, (m.total / max) * 100)}%"></i></span>
            </button>`).join('')}
        </div>
      </div></div>`;

    box.querySelectorAll('.month-chip').forEach((b) => {
      b.onclick = () => {
        selectedMonth = b.dataset.month;
        box.querySelectorAll('.month-chip').forEach((x) => x.classList.toggle('active', x === b));
        drawMonth(host);
      };
    });
  }

  async function drawMonth(host) {
    const box = host.querySelector('#month-detail');
    box.innerHTML = '<div class="loading">Working out what falls due&hellip;</div>';

    const params = new URLSearchParams({ month: selectedMonth });
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    const d = await API.get(`/api/reports/monthly-commitments?${params}`);
    const s = d.sections;
    const cur = esc(C.State.currency);

    box.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi is-primary" style="border-left-width:5px">
          <div class="label">Total to pay in ${esc(fmt.month(d.month))}</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(d.total)}</div>
          <div class="foot">Everything below added up</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">PDC issued</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(s.pdc.amount)}</div>
          <div class="foot">${fmt.int(s.pdc.count)} cheque(s) dated this month</div>
        </div>
        <div class="kpi is-warn">
          <div class="label">STL settlement</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(s.stl.amount)}</div>
          <div class="foot">${fmt.int(s.stl.count)} settlement cheque(s)</div>
        </div>
        <div class="kpi is-primary">
          <div class="label">Bank EMI</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(s.emi.amount)}</div>
          <div class="foot">${fmt.int(s.emi.count)} instalment(s) still to pay</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">LC to the bank</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(s.lc.amount)}</div>
          <div class="foot">${fmt.int(s.lc.count)} maturing</div>
        </div>
        <div class="kpi ${s.supplier_invoices.overdue_amount ? 'is-danger' : 'is-ok'}">
          <div class="label">Supplier invoices</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(d.invoices_to_arrange)}</div>
          <div class="foot">
            ${fmt.int(s.supplier_invoices.count)} due
            ${d.invoices_covered_by_cheques
              ? `&middot; ${fmt.money(d.invoices_covered_by_cheques)} already covered by cheques`
              : ''}
          </div>
        </div>
      </div>

      ${d.invoices_covered_by_cheques ? `
        <div class="alert">
          ${fmt.money(d.invoices_covered_by_cheques)} ${cur} of the invoices falling due this month is
          already covered by cheques counted above, so the total does not ask for it twice.
        </div>` : ''}

      ${section('PDC issued, dated this month', s.pdc, chequeColumns(), 'is-accent')}
      ${section('STL settlement cheques', s.stl, chequeColumns(), 'is-warn')}
      ${section('Bank instalments', s.emi, facilityColumns(), 'is-primary')}
      ${section('LC and trust receipts', s.lc, facilityColumns(), 'is-accent')}
      ${section('Supplier invoices falling due', s.supplier_invoices, invoiceColumns(), 'is-primary')}
      ${section('Petty cash approved, not yet paid', s.petty_cash, pettyColumns(), 'is-warn')}`;

    box.querySelectorAll('[data-pay-due]').forEach((btn) => {
      btn.onclick = () => payDue(Number(btn.dataset.payDue), Number(btn.dataset.amount), () => drawMonth(host));
    });
  }

  function section(title, data, columns, tone) {
    if (!data.rows.length) return '';
    return `
      <div class="card">
        <header>
          <h3>${esc(title)}</h3>
          <span class="sub">${fmt.int(data.rows.length)} item(s)</span>
          <span class="spacer"></span>
          <b>${esc(C.State.currency)} ${fmt.money(data.amount)}</b>
        </header>
        <div class="body tight">${C.table(data.rows, columns, { empty: 'Nothing' })}</div>
      </div>`;
  }

  function chequeColumns() {
    return [
      { label: 'Cheque date', render: (r) => `<b class="nowrap">${fmt.date(r.cheque_date)}</b>` },
      { label: 'Cheque no', mono: true, render: (r) => esc(r.cheque_no) },
      { label: 'Supplier', render: (r) => esc(r.supplier_name) },
      { label: 'Company', render: (r) => `<span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Drawn on', render: (r) => esc(r.cheque_bank_name || r.from_bank_name || '-') },
      { label: 'Status', render: (r) => badge(r.pdc_status) },
      { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` }
    ];
  }

  function facilityColumns() {
    return [
      { label: 'Due', render: (r) => `<b class="nowrap">${fmt.date(r.due_date)}</b>` },
      { label: 'What', render: (r) =>
          `${esc(fmt.label(r.type))}${r.vehicle_no ? `<br><span class="mini-note">${esc(r.vehicle_no)}</span>` : ''}` },
      { label: 'Bank', render: (r) => esc(r.bank_name) },
      { label: 'Reference', mono: true, render: (r) => esc(r.reference || '-') },
      { label: 'Company', render: (r) => `<span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Status', render: (r) => badge(r.status === 'PAID' ? 'PAID' : 'PENDING') },
      { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` },
      { label: '', render: (r) => r.status === 'DUE' && C.can('facility.pay')
          ? `<button class="btn small primary" data-pay-due="${r.id}" data-amount="${r.amount}">Mark paid</button>`
          : '' }
    ];
  }

  function invoiceColumns() {
    return [
      { label: 'Due', render: (r) =>
          `<b class="nowrap ${r.is_overdue ? 'amount-danger' : ''}">${fmt.date(r.due_date)}</b>
           ${r.is_overdue ? `<br><span class="mini-note amount-danger">${r.days_overdue}d late</span>` : ''}` },
      { label: 'Supplier', render: (r) => esc(r.supplier_name) },
      { label: 'Invoice no', mono: true, render: (r) => esc(r.invoice_no) },
      { label: 'Company', render: (r) => `<span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Covered by cheque', num: true, render: (r) =>
          r.pdc_amount ? `<span class="badge blue">${fmt.money(r.pdc_amount)}</span>` : '<span class="mini-note">-</span>' },
      { label: 'Outstanding', num: true, render: (r) => `<b>${fmt.money(r.outstanding)}</b>` }
    ];
  }

  function pettyColumns() {
    return [
      { label: 'Request no', mono: true, render: (r) => esc(r.request_no) },
      { label: 'Employee', render: (r) => esc(r.employee_name) },
      { label: 'Purpose', render: (r) => esc(r.purpose) },
      { label: 'Company', render: (r) => `<span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` }
    ];
  }

  function payDue(dueId, amount, after) {
    const modal = Modal.open({
      title: 'Mark this instalment paid',
      size: 'narrow',
      body: C.formFields([
        { name: 'paid_date', label: 'Paid on', type: 'date', required: true, value: C.today() },
        { name: 'amount', label: 'Amount taken', type: 'number', value: amount,
          hint: 'Change it if the bank took a different figure' },
        { name: 'paid_mode', label: 'How', type: 'select', value: 'AUTO_DEBIT',
          options: [
            { value: 'AUTO_DEBIT', label: 'Direct debit from our account' },
            { value: 'BANK_TRANSFER', label: 'Bank transfer' },
            { value: 'CHEQUE', label: 'Cheque' },
            { value: 'CASH', label: 'Cash' },
            { value: 'ONLINE', label: 'Online' },
            { value: 'OTHER', label: 'Other' }
          ] },
        { name: 'paid_ref', label: 'Reference' }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Mark paid</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      await API.post(`/api/facilities/dues/${dueId}/pay`, b);
    }, { success: 'Instalment marked paid', after });
  }

  // ================================================================ bank facilities

  let facFilters = { type: '', q: '' };

  async function renderFacilities(host, query) {
    if (query && query.type) facFilters.type = query.type;

    host.innerHTML = `
      <div class="toolbar">
        <div>
          <h2 style="font-size:17px">Bank facilities</h2>
          <div class="mini-note">Vehicle and equipment loans paid monthly, and letters of credit.</div>
        </div>
        <div class="spacer"></div>
        <div class="field">
          <label>Type</label>
          <select data-filter="type">
            ${P().optionsHtml([
              { value: '', label: 'All types' },
              { value: 'VEHICLE_LOAN', label: 'Vehicle loans' },
              { value: 'EQUIPMENT_LOAN', label: 'Equipment loans' },
              { value: 'TERM_LOAN', label: 'Term loans' },
              { value: 'LC', label: 'Letters of credit' },
              { value: 'TRUST_RECEIPT', label: 'Trust receipts' },
              { value: 'OTHER', label: 'Other' }
            ], facFilters.type)}
          </select>
        </div>
        <div class="field grow">
          <label>Search</label>
          <input type="search" data-filter="q" value="${esc(facFilters.q)}"
                 placeholder="Vehicle number, loan reference or bank">
        </div>
        ${C.can('facility.edit') ? '<button class="btn primary" id="new-facility">+ New facility</button>' : ''}
      </div>
      <div id="fac-summary"></div>
      <div class="card"><div class="body tight" id="fac-table"><div class="loading">Loading&hellip;</div></div></div>`;

    P().bindFilters(host, facFilters, () => refreshFacilities(host));
    const nb = host.querySelector('#new-facility');
    if (nb) nb.onclick = () => facilityForm(null, () => refreshFacilities(host));

    await refreshFacilities(host);
  }

  async function refreshFacilities(host) {
    const box = host.querySelector('#fac-table');
    box.innerHTML = '<div class="loading">Loading&hellip;</div>';
    const params = new URLSearchParams();
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    Object.entries(facFilters).forEach(([k, v]) => { if (v) params.set(k, v); });

    const data = await API.get(`/api/facilities?${params}`);
    const cur = esc(C.State.currency);

    host.querySelector('#fac-summary').innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi is-primary">
          <div class="label">Every month</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(data.totals.monthly)}</div>
          <div class="foot">Total instalments across ${fmt.int(data.totals.count)} active facilities</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Still owed</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(data.totals.remaining)}</div>
          <div class="foot">Everything not yet paid</div>
        </div>
        <div class="kpi is-warn">
          <div class="label">LC outstanding</div>
          <div class="value"><span class="cur">${cur}</span>${fmt.compact(data.totals.lc)}</div>
          <div class="foot">Letters of credit and trust receipts</div>
        </div>
      </div>`;

    box.innerHTML = C.table(data.rows, [
      { label: 'Type', render: (r) => `<b>${esc(r.type_label)}</b><br><span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Vehicle / reference', render: (r) =>
          `${r.vehicle_no ? `<b>${esc(r.vehicle_no)}</b><br>` : ''}
           <span class="mini-note">${esc(r.reference || r.description || '-')}</span>` },
      { label: 'Bank', render: (r) => esc(r.bank_name) },
      { label: 'Monthly', num: true, render: (r) =>
          r.is_instalment ? `<b>${fmt.money(r.emi_amount)}</b>` : '<span class="mini-note">one payment</span>' },
      { label: 'Schedule', render: (r) => r.is_instalment
          ? `${fmt.date(r.start_date)} &ndash; ${fmt.date(r.end_date)}<br>
             <span class="mini-note">${fmt.int(r.instalments_paid)} of ${fmt.int(r.instalments)} paid</span>`
          : `<span class="nowrap">due ${fmt.date(r.end_date)}</span>` },
      { label: 'Still owed', num: true, render: (r) => `<b>${fmt.money(r.remaining_total)}</b>` },
      { label: 'Next due', render: (r) => r.next_due_date
          ? `<span class="nowrap ${r.next_due_date < C.today() ? 'amount-danger' : ''}">${fmt.date(r.next_due_date)}</span>
             ${r.overdue_instalments ? `<br><span class="mini-note amount-danger">${r.overdue_instalments} missed</span>` : ''}`
          : '<span class="mini-note">-</span>' },
      { label: 'Status', render: (r) => badge(r.status === 'ACTIVE' ? 'OPEN' : r.status) },
      { label: '', render: (r) => `<div class="btn-row">
          <button class="btn small" data-act="view" data-id="${r.id}">Schedule</button>
          ${C.can('facility.edit') ? `<button class="btn small" data-act="edit" data-id="${r.id}">Edit</button>` : ''}
        </div>` }
    ], {
      empty: 'No bank facilities recorded yet',
      emptyIcon: '&#128663;',
      emptyHint: C.can('facility.edit')
        ? 'Add a vehicle loan with its monthly instalment, and it shows up in the monthly payments view.'
        : '',
      rowClass: (r) => r.status !== 'ACTIVE' ? 'row-muted' : (r.overdue_instalments ? 'row-overdue' : ''),
      footer: ['<b>Totals</b>', '', '', fmt.money(data.totals.monthly), '',
               fmt.money(data.totals.remaining), '', '', '']
    });

    box.querySelectorAll('[data-act]').forEach((btn) => {
      const row = data.rows.find((r) => r.id === Number(btn.dataset.id));
      btn.onclick = () => btn.dataset.act === 'edit'
        ? facilityForm(row, () => refreshFacilities(host))
        : facilityDetail(row.id, () => refreshFacilities(host));
    });
  }

  function facilityForm(row, after) {
    const isEdit = !!row;
    const companyId = row ? row.company_id : (C.State.companyId || (C.State.companies[0] || {}).id);

    const modal = Modal.open({
      title: isEdit ? `Edit ${row.type_label}${row.vehicle_no ? ` ${row.vehicle_no}` : ''}` : 'New bank facility',
      subtitle: 'Enter it once with the monthly instalment, and the schedule is worked out from it',
      size: 'wide',
      body: `
        ${C.formFields([
          { type: 'group', className: 'grid-2', fields: [
            { name: 'company_id', label: 'Company', type: 'select', required: true,
              options: C.opt.companies(false), value: companyId },
            { name: 'type', label: 'Type', type: 'select', required: true,
              value: row ? row.type : 'VEHICLE_LOAN',
              options: [
                { value: 'VEHICLE_LOAN', label: 'Vehicle loan' },
                { value: 'EQUIPMENT_LOAN', label: 'Equipment loan' },
                { value: 'TERM_LOAN', label: 'Term loan' },
                { value: 'LC', label: 'Letter of credit' },
                { value: 'TRUST_RECEIPT', label: 'Trust receipt' },
                { value: 'OTHER', label: 'Other' }
              ] }
          ] },
          { type: 'group', className: 'grid-2', fields: [
            { name: 'vehicle_no', label: 'Vehicle number', value: row ? row.vehicle_no : '',
              hint: 'The plate number, so the loan can be matched to the vehicle' },
            { name: 'reference', label: 'Loan / LC number', value: row ? row.reference : '' }
          ] },
          { type: 'group', className: 'grid-2', fields: [
            { name: 'bank_account_id', label: 'Our account it comes out of', type: 'select',
              options: C.opt.banks(companyId, 'Not set'), value: row ? row.bank_account_id : '' },
            { name: 'bank_name', label: 'Bank', required: true, value: row ? row.bank_name : '',
              hint: 'Filled in from the account above if you leave it blank' }
          ] }
        ])}

        <div id="fac-loan-fields">
          ${C.formFields([
            { type: 'group', className: 'grid-4', fields: [
              { name: 'emi_amount', label: 'Monthly instalment', type: 'number',
                value: row ? row.emi_amount : '' },
              { name: 'due_day', label: 'Taken on day', type: 'number', step: '1',
                value: row ? row.due_day : 5, hint: 'Day of the month' },
              { name: 'start_date', label: 'First instalment', type: 'date',
                value: row ? row.start_date : '' },
              { name: 'end_date', label: 'Last instalment', type: 'date',
                value: row ? row.end_date : '' }
            ] }
          ])}
        </div>

        <div id="fac-lc-fields" hidden>
          ${C.formFields([
            { type: 'group', className: 'grid-2', fields: [
              { name: 'principal_amount', label: 'Amount', type: 'number',
                value: row ? row.principal_amount : '' },
              { name: 'lc_end_date', label: 'Falls due on', type: 'date',
                value: row ? row.end_date : '' }
            ] }
          ])}
        </div>

        ${C.formFields([
          { type: 'group', className: 'grid-2', fields: [
            { name: 'supplier_id', label: 'Beneficiary (for an LC)', type: 'select',
              options: C.opt.suppliers('Not set'), value: row ? row.supplier_id : '' },
            { name: 'description', label: 'Description', value: row ? row.description : '' }
          ] },
          { name: 'notes', label: 'Notes', type: 'textarea', value: row ? row.notes : '' }
        ])}
        <div id="fac-preview" class="alert" hidden></div>`,
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">${isEdit ? 'Save changes' : 'Save facility'}</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const $ = (s) => modal.querySelector(s);
    const typeSel = $('[name="type"]');
    const vehicleField = modal.querySelector('[data-field="vehicle_no"]');
    const bankSel = $('[name="bank_account_id"]');
    const bankName = $('[name="bank_name"]');

    const isLoan = () => ['VEHICLE_LOAN', 'EQUIPMENT_LOAN', 'TERM_LOAN'].includes(typeSel.value);

    function sync() {
      $('#fac-loan-fields').hidden = !isLoan();
      $('#fac-lc-fields').hidden = isLoan();
      vehicleField.hidden = typeSel.value !== 'VEHICLE_LOAN';
      vehicleField.classList.toggle('required', typeSel.value === 'VEHICLE_LOAN');
      preview();
    }

    function preview() {
      const box = $('#fac-preview');
      if (!isLoan()) { box.hidden = true; return; }
      const emi = Number($('[name="emi_amount"]').value || 0);
      const start = $('[name="start_date"]').value;
      const end = $('[name="end_date"]').value;
      if (!emi || !start || !end || end < start) { box.hidden = true; return; }
      const months = (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12
        + (Number(end.slice(5, 7)) - Number(start.slice(5, 7))) + 1;
      box.hidden = false;
      box.innerHTML = `That is <b>${months}</b> monthly instalments of
        <b>${C.State.currency} ${fmt.money(emi)}</b>, ${fmt.money(months * emi)} in total.`;
    }

    typeSel.onchange = sync;
    ['emi_amount', 'start_date', 'end_date'].forEach((n) => {
      const el = $(`[name="${n}"]`);
      if (el) el.oninput = preview;
    });
    bankSel.onchange = () => {
      const acc = C.State.bankAccounts.find((b) => String(b.id) === bankSel.value);
      if (acc && !bankName.value) bankName.value = acc.bank_name;
    };
    sync();

    C.wireSave(modal, async (b) => {
      // The LC block keeps its date under a different name so the two sets of
      // fields can sit in the form at the same time without clashing.
      if (!['VEHICLE_LOAN', 'EQUIPMENT_LOAN', 'TERM_LOAN'].includes(b.type)) {
        b.end_date = b.lc_end_date;
        b.start_date = b.lc_end_date;
        b.emi_amount = 0;
      }
      delete b.lc_end_date;
      if (row) await API.put(`/api/facilities/${row.id}`, b);
      else await API.post('/api/facilities', b);
    }, { success: 'Facility saved', after });
  }

  async function facilityDetail(id, after) {
    const f = await API.get(`/api/facilities/${id}`);
    const modal = Modal.open({
      title: `${f.type_label}${f.vehicle_no ? ` - ${f.vehicle_no}` : ''}`,
      subtitle: `${f.bank_name}${f.reference ? ` - ${f.reference}` : ''}`,
      size: 'wide',
      body: `
        <div class="grid-2" style="gap:0 24px">
          <dl class="kv">
            <dt>Company</dt><dd>${esc(f.company_name)}</dd>
            <dt>Bank</dt><dd>${esc(f.bank_name)}${f.account_no ? ` <span class="mini-note">${esc(f.account_no)}</span>` : ''}</dd>
            ${f.vehicle_no ? `<dt>Vehicle</dt><dd><b>${esc(f.vehicle_no)}</b></dd>` : ''}
            ${f.reference ? `<dt>Reference</dt><dd>${esc(f.reference)}</dd>` : ''}
          </dl>
          <dl class="kv">
            ${f.is_instalment ? `<dt>Monthly</dt><dd><b>${C.State.currency} ${fmt.money(f.emi_amount)}</b></dd>` : ''}
            <dt>Scheduled</dt><dd>${C.State.currency} ${fmt.money(f.scheduled_total)}</dd>
            <dt>Paid</dt><dd class="amount-ok">${C.State.currency} ${fmt.money(f.paid_total)}</dd>
            <dt>Still owed</dt><dd><b>${C.State.currency} ${fmt.money(f.remaining_total)}</b></dd>
          </dl>
        </div>
        <h4 style="margin:18px 0 8px">Instalments</h4>
        ${C.table(f.dues, [
          { label: 'Due', render: (d) => `<b class="nowrap ${d.status === 'DUE' && d.due_date < C.today() ? 'amount-danger' : ''}">${fmt.date(d.due_date)}</b>` },
          { label: 'Amount', num: true, render: (d) => fmt.money(d.amount) },
          { label: 'Status', render: (d) => badge(d.status === 'PAID' ? 'PAID' : (d.status === 'SKIPPED' ? 'CANCELLED' : 'PENDING')) },
          { label: 'Paid on', render: (d) => d.paid_date ? `${fmt.date(d.paid_date)}<br><span class="mini-note">${esc(fmt.label(d.paid_mode || ''))}</span>` : '<span class="mini-note">-</span>' },
          { label: 'By', render: (d) => `<span class="mini-note">${esc(d.paid_by_name || '')}</span>` },
          { label: '', render: (d) => d.status === 'DUE' && C.can('facility.pay')
              ? `<button class="btn small primary" data-pay-due="${d.id}" data-amount="${d.amount}">Mark paid</button>`
              : '' }
        ], { empty: 'No instalments scheduled' })}`,
      footer: `<button class="btn" data-act="close">Close</button>
               <div class="spacer"></div>
               ${C.can('facility.edit') && f.status === 'ACTIVE'
                 ? '<button class="btn" data-act="close-fac">Mark settled</button>' : ''}`
    });
    modal.querySelector('[data-act="close"]').onclick = () => Modal.close();

    modal.querySelectorAll('[data-pay-due]').forEach((btn) => {
      btn.onclick = () => {
        Modal.close();
        payDue(Number(btn.dataset.payDue), Number(btn.dataset.amount), after);
      };
    });

    const closeBtn = modal.querySelector('[data-act="close-fac"]');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        const ok = await Modal.confirm({
          title: 'Mark this facility settled?',
          message: 'Any instalments still outstanding will stop appearing in the monthly payments view.',
          confirmText: 'Mark settled'
        });
        if (!ok) return;
        await API.post(`/api/facilities/${f.id}/close`, { status: 'CLOSED' });
        Modal.close();
        toast('Facility marked settled', 'ok');
        after();
      };
    }
  }

  window.Monthly = { renderMonthly, renderFacilities };
})();
