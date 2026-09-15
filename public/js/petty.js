/* Petty cash: accounts raise it, finance verifies, the owner approves,
   accounts pay it out. Every step records who did it and when. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge, API, Modal, toast } = C;

  const TABS = [
    { key: 'awaiting_me', label: 'Waiting on me' },
    { key: '', label: 'All requests' },
    { key: 'PENDING', label: 'Pending', status: true },
    { key: 'VERIFIED', label: 'Verified', status: true },
    { key: 'APPROVED', label: 'Approved, not paid', status: true },
    { key: 'PAID', label: 'Paid', status: true },
    { key: 'REJECTED', label: 'Rejected', status: true }
  ];

  let filters = { view: 'awaiting_me', status: '', employee_id: '', q: '', from: '', to: '' };

  async function render(host, query) {
    if (query && query.view) {
      filters.view = query.view;
      filters.status = '';
    }

    host.innerHTML = `
      <div class="tabs" id="petty-tabs">
        ${TABS.map((t) => {
          const active = t.status ? filters.status === t.key : (filters.view === t.key && !filters.status);
          return `<button data-key="${esc(t.key)}" data-status="${t.status ? '1' : ''}" class="${active ? 'active' : ''}">${t.label}</button>`;
        }).join('')}
      </div>
      <div class="toolbar">
        <div class="field grow">
          <label>Search</label>
          <input type="search" data-filter="q" value="${esc(filters.q)}"
                 placeholder="Request number, purpose, employee or bill reference">
        </div>
        <div class="field">
          <label>Employee</label>
          <select data-filter="employee_id">
            ${window.Payables.optionsHtml(
              [{ value: '', label: 'All employees' }].concat(
                C.State.employees.map((e) => ({ value: e.id, label: e.name }))
              ), filters.employee_id)}
          </select>
        </div>
        <div class="field"><label>From</label><input type="date" data-filter="from" value="${esc(filters.from)}"></div>
        <div class="field"><label>To</label><input type="date" data-filter="to" value="${esc(filters.to)}"></div>
        <div class="spacer"></div>
        <button class="btn" data-act="export">Export CSV</button>
        ${C.can('petty.create') ? '<button class="btn primary" id="new-petty">+ New request</button>' : ''}
      </div>
      <div id="petty-summary"></div>
      <div class="card"><div class="body tight" id="petty-table"><div class="loading">Loading&hellip;</div></div></div>`;

    host.querySelectorAll('#petty-tabs button').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.status) { filters.status = b.dataset.key; filters.view = ''; }
        else { filters.view = b.dataset.key; filters.status = ''; }
        host.querySelectorAll('#petty-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        refresh(host);
      };
    });
    window.Payables.bindFilters(host, filters, () => refresh(host));
    const nb = host.querySelector('#new-petty');
    if (nb) nb.onclick = () => requestForm(null, () => refresh(host));

    await refresh(host);
  }

  async function refresh(host) {
    const box = host.querySelector('#petty-table');
    box.innerHTML = '<div class="loading">Loading requests&hellip;</div>';
    const params = new URLSearchParams();
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });

    const data = await API.get(`/api/petty-cash?${params}`);
    const t = data.totals;

    host.querySelector('#petty-summary').innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi is-warn">
          <div class="label">Waiting for approval</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.pending + t.verified)}</div>
          <div class="foot">${fmt.int(t.pending_count + t.verified_count)} requests</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Approved, not yet paid</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.approved)}</div>
          <div class="foot">${fmt.int(t.approved_count)} requests</div>
        </div>
        <div class="kpi is-ok">
          <div class="label">Paid out</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.paid)}</div>
          <div class="foot">${fmt.int(t.paid_count)} requests</div>
        </div>
        <div class="kpi is-primary">
          <div class="label">Listed</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.total)}</div>
          <div class="foot">${fmt.int(t.count)} requests &middot; ${fmt.int(t.rejected_count)} rejected</div>
        </div>
      </div>`;

    box.innerHTML = C.table(data.rows, [
      { label: 'Request no', mono: true, render: (r) => esc(r.request_no) },
      { label: 'Date', render: (r) => `<span class="nowrap">${fmt.date(r.request_date)}</span>` },
      { label: 'Employee', render: (r) =>
          `<b>${esc(r.employee_name)}</b><br><span class="mini-note">${esc(r.employee_designation || r.employee_code || '')}</span>` },
      { label: 'Company', render: (r) => esc(r.company_code) },
      { label: 'Purpose', render: (r) =>
          `${esc(r.purpose)}${r.category_name ? `<br><span class="mini-note">${esc(r.category_name)}</span>` : ''}` },
      { label: 'Raised by', render: (r) => `<span class="mini-note">${esc(r.requested_by_name || '')}</span>` },
      { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` },
      { label: 'Status', render: (r) => statusCell(r) },
      { label: '', render: (r) => actions(r) }
    ], {
      empty: 'No petty cash requests match this filter',
      emptyIcon: '&#128176;',
      emptyHint: C.can('petty.create') ? 'Use "New request" to raise one.' : '',
      rowClass: (r) => r.status === 'CANCELLED' || r.status === 'REJECTED' ? 'row-muted' : '',
      footer: ['<b>Total</b>', '', '', '', '', '', fmt.money(t.total), '', '']
    });

    box.querySelectorAll('[data-act]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const row = data.rows.find((r) => r.id === id);
      btn.onclick = () => handle(btn.dataset.act, row, () => refresh(host));
    });

    host.querySelector('[data-act="export"]').onclick = () =>
      C.downloadCsv(`petty-cash-${C.today()}.csv`, [
        { label: 'Request no', key: 'request_no' },
        { label: 'Date', key: 'request_date' },
        { label: 'Company', key: 'company_name' },
        { label: 'Employee', key: 'employee_name' },
        { label: 'Department', key: 'employee_department' },
        { label: 'Purpose', key: 'purpose' },
        { label: 'Category', key: 'category_name' },
        { label: 'Bill ref', key: 'bill_ref' },
        { label: 'Amount', key: 'amount' },
        { label: 'Status', key: 'status' },
        { label: 'Raised by', key: 'requested_by_name' },
        { label: 'Verified by', key: 'verified_by_name' },
        { label: 'Approved by', key: 'approved_by_name' },
        { label: 'Paid on', key: 'paid_date' },
        { label: 'Paid by', key: 'paid_by_name' }
      ], data.rows);
  }

  function statusCell(r) {
    let extra = '';
    if (r.status === 'APPROVED') extra = `<br><span class="mini-note">by ${esc(r.approved_by_name || '')}</span>`;
    if (r.status === 'PAID') extra = `<br><span class="mini-note">${fmt.date(r.paid_date)} &middot; ${esc(fmt.label(r.paid_mode || ''))}</span>`;
    if (r.status === 'VERIFIED') extra = `<br><span class="mini-note">by ${esc(r.verified_by_name || '')}</span>`;
    if (r.status === 'REJECTED') extra = `<br><span class="mini-note">${esc(r.reject_reason || '')}</span>`;
    return badge(r.status) + extra;
  }

  function actions(r) {
    const b = [`<button class="btn small" data-act="view" data-id="${r.id}">View</button>`];
    if (r.can_approve) b.push(`<button class="btn small ok" data-act="approve" data-id="${r.id}">Approve</button>`);
    // Approving covers verifying, so only offer it to someone who cannot approve.
    if (r.can_verify && !r.can_approve) b.push(`<button class="btn small primary" data-act="verify" data-id="${r.id}">Verify</button>`);
    if (r.can_reject) b.push(`<button class="btn small danger" data-act="reject" data-id="${r.id}">Reject</button>`);
    if (r.can_pay) b.push(`<button class="btn small primary" data-act="pay" data-id="${r.id}">Mark paid</button>`);
    if (r.can_edit) b.push(`<button class="btn small" data-act="edit" data-id="${r.id}">Edit</button>`);
    return `<div class="btn-row">${b.join('')}</div>`;
  }

  async function handle(act, row, after) {
    if (act === 'view') return detail(row.id, after);
    if (act === 'edit') return requestForm(row, after);

    if (act === 'approve') {
      const ok = await Modal.confirm({
        title: 'Approve this petty cash?',
        message: `${C.State.currency} ${fmt.money(row.amount)} for ${row.employee_name} - ${row.purpose}`,
        confirmText: 'Approve'
      });
      if (!ok) return;
      await API.post(`/api/petty-cash/${row.id}/approve`, {});
      toast('Approved', 'ok');
      return after();
    }

    if (act === 'verify') {
      const remarks = await Modal.prompt({
        title: 'Verify this request',
        label: 'Remarks (optional)',
        hint: 'Confirm the bill and the amount before it goes to the owner.',
        confirmText: 'Verify'
      });
      if (remarks === null) return;
      await API.post(`/api/petty-cash/${row.id}/verify`, { remarks });
      toast('Verified, now waiting for the owner', 'ok');
      return after();
    }

    if (act === 'reject') {
      const reason = await Modal.prompt({
        title: 'Reject this request',
        label: 'Why is it rejected?',
        required: true, multiline: true, confirmText: 'Reject'
      });
      if (reason === null) return;
      await API.post(`/api/petty-cash/${row.id}/reject`, { reason });
      toast('Rejected', 'ok');
      return after();
    }

    if (act === 'pay') return payForm(row, after);
  }

  // ---------------------------------------------------------------- forms

  function requestForm(request, after) {
    const isEdit = !!request;
    const companyId = request ? request.company_id : (C.State.companyId || (C.State.companies[0] || {}).id);

    const modal = Modal.open({
      title: isEdit ? `Edit ${request.request_no}` : 'New petty cash request',
      subtitle: 'The owner approves it before any cash is handed over',
      body: C.formFields([
        { type: 'group', className: 'grid-2', fields: [
          { name: 'company_id', label: 'Company', type: 'select', required: true,
            options: C.opt.companies(false), value: companyId },
          { name: 'request_date', label: 'Request date', type: 'date', required: true,
            value: request ? request.request_date : C.today() }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'employee_id', label: 'Employee requesting the cash', type: 'select', required: true,
            options: C.opt.employees(true), value: request ? request.employee_id : '',
            hint: 'Who the cash is actually for' },
          { name: 'amount', label: 'Amount', type: 'number', required: true,
            value: request ? request.amount : '' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'category_id', label: 'Category', type: 'select',
            options: C.opt.categories('PETTY'), value: request ? request.category_id : '' },
          { name: 'bill_ref', label: 'Bill / receipt reference', value: request ? request.bill_ref : '' }
        ] },
        { name: 'purpose', label: 'What is it for?', type: 'textarea', required: true,
          value: request ? request.purpose : '',
          hint: 'Be specific - the owner sees this when approving' }
      ]),
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">${isEdit ? 'Save changes' : 'Send for approval'}</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    C.wireSave(modal, async (body) => {
      if (isEdit) await API.put(`/api/petty-cash/${request.id}`, body);
      else await API.post('/api/petty-cash', body);
    }, { success: isEdit ? 'Request updated' : 'Request sent for approval', after });
  }

  function payForm(row, after) {
    const modal = Modal.open({
      title: `Pay out ${row.request_no}`,
      subtitle: `${C.State.currency} ${fmt.money(row.amount)} to ${row.employee_name}`,
      size: 'narrow',
      body: C.formFields([
        { name: 'paid_date', label: 'Paid on', type: 'date', required: true, value: C.today() },
        { name: 'paid_mode', label: 'How was it handed over?', type: 'select', required: true,
          value: 'CASH',
          options: [
            { value: 'CASH', label: 'Cash' },
            { value: 'BANK_TRANSFER', label: 'Bank transfer' },
            { value: 'CHEQUE', label: 'Cheque' },
            { value: 'ONLINE', label: 'Online' },
            { value: 'OTHER', label: 'Other' }
          ] },
        { name: 'paid_ref', label: 'Reference', hint: 'Voucher number, transfer reference or cheque number' }
      ]),
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">Mark as paid</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (body) => {
      await API.post(`/api/petty-cash/${row.id}/pay`, body);
    }, { success: 'Marked as paid', after });
  }

  async function detail(id, after) {
    const r = await API.get(`/api/petty-cash/${id}`);
    const modal = Modal.open({
      title: r.request_no,
      subtitle: `${r.employee_name} - ${r.company_name}`,
      body: `
        ${r.status === 'REJECTED' ? `<div class="alert error"><b>Rejected.</b> ${esc(r.reject_reason || '')}</div>` : ''}
        <div class="grid-2" style="gap:0 24px">
          <dl class="kv">
            <dt>Employee</dt><dd>${esc(r.employee_name)} <span class="mini-note">${esc(r.employee_code || '')}</span></dd>
            <dt>Designation</dt><dd>${esc(r.employee_designation || '-')}</dd>
            <dt>Department</dt><dd>${esc(r.employee_department || '-')}</dd>
            <dt>Request date</dt><dd>${fmt.date(r.request_date)}</dd>
          </dl>
          <dl class="kv">
            <dt>Amount</dt><dd><b>${C.State.currency} ${fmt.money(r.amount)}</b></dd>
            <dt>Category</dt><dd>${esc(r.category_name || '-')}</dd>
            <dt>Bill reference</dt><dd>${esc(r.bill_ref || '-')}</dd>
            <dt>Status</dt><dd>${badge(r.status)}</dd>
          </dl>
        </div>
        <div style="margin-top:14px">
          <span class="mini-note">Purpose</span>
          <div style="margin-top:4px">${esc(r.purpose)}</div>
        </div>

        <h4 style="margin:18px 0 8px">Approval trail</h4>
        <ul class="timeline">
          <li class="done">
            <b>Raised by ${esc(r.requested_by_name || 'unknown')}</b>
            <span>${fmt.dateTime(r.created_at)}</span>
          </li>
          <li class="${r.verified_at ? 'done' : ''}">
            <b>${r.verified_at ? `Verified by ${esc(r.verified_by_name)}` : 'Verification by finance'}</b>
            <span>${r.verified_at ? fmt.dateTime(r.verified_at) : 'not done yet'}
              ${r.verify_remarks ? ` &middot; ${esc(r.verify_remarks)}` : ''}</span>
          </li>
          <li class="${r.approved_at ? 'done' : (r.rejected_at ? 'rejected' : '')}">
            <b>${r.approved_at ? `Approved by ${esc(r.approved_by_name)}`
                  : (r.rejected_at ? `Rejected by ${esc(r.rejected_by_name)}` : 'Owner approval')}</b>
            <span>${r.approved_at ? fmt.dateTime(r.approved_at)
                    : (r.rejected_at ? fmt.dateTime(r.rejected_at) : 'waiting')}
              ${r.approve_remarks ? ` &middot; ${esc(r.approve_remarks)}` : ''}
              ${r.reject_reason ? ` &middot; ${esc(r.reject_reason)}` : ''}</span>
          </li>
          <li class="${r.paid_date ? 'done' : ''}">
            <b>${r.paid_date ? `Paid by ${esc(r.paid_by_name || '')}` : 'Payment'}</b>
            <span>${r.paid_date
                    ? `${fmt.date(r.paid_date)} &middot; ${esc(fmt.label(r.paid_mode || ''))}${r.paid_ref ? ` &middot; ${esc(r.paid_ref)}` : ''}`
                    : 'not paid yet'}</span>
          </li>
        </ul>`,
      footer: `
        <button class="btn" data-act="close">Close</button>
        <div class="spacer"></div>
        ${r.can_verify && !r.can_approve ? '<button class="btn primary" data-act="verify">Verify</button>' : ''}
        ${r.can_reject ? '<button class="btn danger" data-act="reject">Reject</button>' : ''}
        ${r.can_approve ? '<button class="btn ok" data-act="approve">Approve</button>' : ''}
        ${r.can_pay ? '<button class="btn primary" data-act="pay">Mark paid</button>' : ''}`
    });
    modal.querySelector('[data-act="close"]').onclick = () => Modal.close();
    ['verify', 'reject', 'approve', 'pay'].forEach((act) => {
      const btn = modal.querySelector(`[data-act="${act}"]`);
      if (btn) btn.onclick = () => { Modal.close(); handle(act, r, after); };
    });
  }

  window.Petty = { render, requestForm };
})();
