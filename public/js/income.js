/* The income side: what customers owe us and what has come in. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge, API, Modal, toast } = C;
  const P = () => window.Payables;

  let tab = 'invoices';
  let invFilters = { view: 'all', customer_id: '', q: '', from: '', to: '' };
  let rcpFilters = { view: 'all', customer_id: '', mode: '', q: '' };

  async function render(host, query) {
    if (query && query.tab) tab = query.tab;
    host.innerHTML = `
      <div class="tabs" id="income-tabs">
        <button data-tab="invoices" class="${tab === 'invoices' ? 'active' : ''}">Customer invoices</button>
        <button data-tab="receipts" class="${tab === 'receipts' ? 'active' : ''}">Money received</button>
      </div>
      <div id="income-body"><div class="loading">Loading&hellip;</div></div>`;

    host.querySelectorAll('#income-tabs button').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab;
        host.querySelectorAll('#income-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        draw(host);
      };
    });
    await draw(host);
  }

  function draw(host) {
    return tab === 'invoices' ? drawInvoices(host) : drawReceipts(host);
  }

  // ---------------------------------------------------------------- invoices

  async function drawInvoices(host) {
    const body = host.querySelector('#income-body');
    body.innerHTML = `
      <div class="toolbar">
        <div class="field grow">
          <label>Search</label>
          <input type="search" data-filter="q" value="${esc(invFilters.q)}" placeholder="Invoice number, customer or project">
        </div>
        <div class="field">
          <label>Customer</label>
          <select data-filter="customer_id">${P().optionsHtml(C.opt.customers(true), invFilters.customer_id)}</select>
        </div>
        <div class="field">
          <label>Show</label>
          <select data-filter="view">
            ${P().optionsHtml([
              { value: 'all', label: 'All' },
              { value: 'open', label: 'Outstanding' },
              { value: 'overdue', label: 'Overdue' }
            ], invFilters.view)}
          </select>
        </div>
        <div class="spacer"></div>
        ${C.can('sales.create') ? '<button class="btn primary" id="new-sales">+ New customer invoice</button>' : ''}
      </div>
      <div id="sales-summary"></div>
      <div class="card"><div class="body tight" id="sales-table"><div class="loading">Loading&hellip;</div></div></div>`;

    P().bindFilters(body, invFilters, () => drawInvoices(host));
    const nb = body.querySelector('#new-sales');
    if (nb) nb.onclick = () => salesForm(null, () => drawInvoices(host));

    const params = new URLSearchParams();
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    Object.entries(invFilters).forEach(([k, v]) => { if (v && v !== 'all') params.set(k, v); });

    const data = await API.get(`/api/sales/invoices?${params}`);
    const t = data.totals;

    body.querySelector('#sales-summary').innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi is-primary">
          <div class="label">Invoiced</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.total)}</div>
          <div class="foot">${fmt.int(t.count)} invoices</div>
        </div>
        <div class="kpi is-ok">
          <div class="label">Received</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.received)}</div>
          <div class="foot">Cleared into our accounts</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Outstanding</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.outstanding)}</div>
          <div class="foot">Still to collect</div>
        </div>
        <div class="kpi is-danger">
          <div class="label">Overdue</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.overdue)}</div>
          <div class="foot">${fmt.int(t.overdue_count)} invoices past due</div>
        </div>
      </div>`;

    body.querySelector('#sales-table').innerHTML = C.table(data.rows, [
      { label: 'Customer', render: (r) => `<b>${esc(r.customer_name)}</b><br><span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Invoice no', mono: true, render: (r) => esc(r.invoice_no) },
      { label: 'Invoice date', render: (r) => fmt.date(r.invoice_date) },
      { label: 'Due', render: (r) => r.due_date
          ? `<span class="nowrap ${r.is_overdue ? 'amount-danger strong' : ''}">${fmt.date(r.due_date)}</span>
             ${r.is_overdue ? `<br><span class="mini-note amount-danger">${r.days_overdue} days late</span>` : ''}`
          : '-' },
      { label: 'Total', num: true, render: (r) => fmt.money(r.total_amount) },
      { label: 'Received', num: true, render: (r) => fmt.money(r.received_amount) },
      { label: 'Outstanding', num: true, render: (r) => `<b class="${r.is_overdue ? 'amount-danger' : ''}">${fmt.money(r.outstanding)}</b>` },
      { label: 'Status', render: (r) => badge(r.status) },
      { label: '', render: (r) => `<div class="btn-row">
          ${C.can('receipt.create') && r.outstanding > 0 && r.status !== 'CANCELLED'
            ? `<button class="btn small primary" data-act="receive" data-id="${r.id}">Receive</button>` : ''}
          ${C.can('sales.edit') && r.status !== 'CANCELLED'
            ? `<button class="btn small" data-act="edit" data-id="${r.id}">Edit</button>` : ''}
          ${C.can('sales.delete') && r.status !== 'CANCELLED'
            ? `<button class="btn small danger" data-act="delete" data-id="${r.id}">Delete</button>` : ''}
        </div>` }
    ], {
      rowClass: (r) => r.status === 'CANCELLED' ? 'row-muted' : (r.is_overdue ? 'row-overdue' : ''),
      empty: 'No customer invoices yet',
      emptyIcon: '&#128181;',
      footer: ['<b>Totals</b>', '', '', '', fmt.money(t.total), fmt.money(t.received), fmt.money(t.outstanding), '', '']
    });

    body.querySelectorAll('[data-act]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const row = data.rows.find((r) => r.id === id);
      btn.onclick = async () => {
        if (btn.dataset.act === 'edit') return salesForm(row, () => drawInvoices(host));
        if (btn.dataset.act === 'receive') {
          return receiptForm({
            customer_id: row.customer_id, company_id: row.company_id,
            amount: row.outstanding, preselect: [{ invoice_id: row.id, amount: row.outstanding }]
          }, () => drawInvoices(host));
        }
        if (btn.dataset.act === 'delete') {
          const ok = await Modal.confirm({
            title: 'Delete this invoice?',
            message: `Invoice ${row.invoice_no} to ${row.customer_name}. If receipts exist it will be cancelled instead.`,
            confirmText: 'Delete', danger: true
          });
          if (!ok) return;
          const res = await API.del(`/api/sales/invoices/${id}`);
          toast(res.cancelled ? 'Invoice cancelled' : 'Invoice deleted', 'ok');
          drawInvoices(host);
        }
      };
    });
  }

  function salesForm(invoice, after) {
    const isEdit = !!invoice;
    const companyId = invoice ? invoice.company_id : (C.State.companyId || (C.State.companies[0] || {}).id);
    const modal = Modal.open({
      title: isEdit ? `Edit ${invoice.invoice_no}` : 'New customer invoice',
      size: 'wide',
      body: C.formFields([
        { type: 'group', className: 'grid-2', fields: [
          { name: 'company_id', label: 'Company', type: 'select', required: true,
            options: C.opt.companies(false), value: companyId },
          { name: 'customer_id', label: 'Customer', type: 'select', required: true,
            options: [{ value: '', label: 'Choose a customer' }].concat(C.opt.customers()),
            value: invoice ? invoice.customer_id : '' }
        ] },
        { type: 'group', className: 'grid-4', fields: [
          { name: 'invoice_no', label: 'Invoice number', required: true, value: invoice ? invoice.invoice_no : '' },
          { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true,
            value: invoice ? invoice.invoice_date : C.today() },
          { name: 'submitted_date', label: 'Submitted to customer', type: 'date',
            value: invoice ? invoice.submitted_date : C.today() },
          { name: 'payment_terms_days', label: 'Terms (days)', type: 'number', step: '1',
            value: invoice ? invoice.payment_terms_days : 60 }
        ] },
        { type: 'group', className: 'grid-3', fields: [
          { name: 'subtotal', label: 'Amount before VAT', type: 'number', required: true,
            value: invoice ? invoice.subtotal : '' },
          { name: 'tax_amount', label: 'VAT', type: 'number', value: invoice ? invoice.tax_amount : '0' },
          { name: 'total_amount', label: 'Invoice total', type: 'number', required: true,
            value: invoice ? invoice.total_amount : '' }
        ] },
        { type: 'group', className: 'grid-3', fields: [
          { name: 'category_id', label: 'Income category', type: 'select',
            options: C.opt.categories('INCOME'), value: invoice ? invoice.category_id : '' },
          { name: 'lpo_no', label: 'Customer LPO', value: invoice ? invoice.lpo_no : '' },
          { name: 'project_ref', label: 'Project reference', value: invoice ? invoice.project_ref : '' }
        ] },
        { name: 'description', label: 'Description', type: 'textarea', value: invoice ? invoice.description : '' }
      ]),
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">${isEdit ? 'Save changes' : 'Save invoice'}</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const sub = modal.querySelector('[name="subtotal"]');
    const tax = modal.querySelector('[name="tax_amount"]');
    const total = modal.querySelector('[name="total_amount"]');
    let touched = isEdit;
    total.oninput = () => { touched = true; };
    const sync = () => {
      if (touched) return;
      const v = Number(sub.value || 0) + Number(tax.value || 0);
      total.value = v ? v.toFixed(2) : '';
    };
    sub.oninput = sync;
    tax.oninput = sync;

    C.wireSave(modal, async (b) => {
      if (isEdit) await API.put(`/api/sales/invoices/${invoice.id}`, b);
      else await API.post('/api/sales/invoices', b);
    }, { success: isEdit ? 'Invoice updated' : 'Invoice saved', after });
  }

  // ---------------------------------------------------------------- receipts

  async function drawReceipts(host) {
    const body = host.querySelector('#income-body');
    body.innerHTML = `
      <div class="toolbar">
        <div class="field grow">
          <label>Search</label>
          <input type="search" data-filter="q" value="${esc(rcpFilters.q)}" placeholder="Receipt number, cheque number or customer">
        </div>
        <div class="field">
          <label>Customer</label>
          <select data-filter="customer_id">${P().optionsHtml(C.opt.customers(true), rcpFilters.customer_id)}</select>
        </div>
        <div class="field">
          <label>Mode</label>
          <select data-filter="mode">${P().optionsHtml([{ value: '', label: 'All modes' }].concat(C.opt.modes()), rcpFilters.mode)}</select>
        </div>
        <div class="field">
          <label>Show</label>
          <select data-filter="view">
            ${P().optionsHtml([
              { value: 'all', label: 'All' },
              { value: 'pdc_pending', label: 'Customer cheques to clear' }
            ], rcpFilters.view)}
          </select>
        </div>
        <div class="spacer"></div>
        ${C.can('receipt.create') ? '<button class="btn primary" id="new-receipt">+ Record money received</button>' : ''}
      </div>
      <div class="card"><div class="body tight" id="receipt-table"><div class="loading">Loading&hellip;</div></div></div>`;

    P().bindFilters(body, rcpFilters, () => drawReceipts(host));
    const nb = body.querySelector('#new-receipt');
    if (nb) nb.onclick = () => receiptForm({}, () => drawReceipts(host));

    const params = new URLSearchParams();
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    Object.entries(rcpFilters).forEach(([k, v]) => { if (v && v !== 'all') params.set(k, v); });

    const data = await API.get(`/api/sales/receipts?${params}`);

    body.querySelector('#receipt-table').innerHTML = C.table(data.rows, [
      { label: 'Date', render: (r) => fmt.date(r.receipt_date) },
      { label: 'Receipt no', mono: true, render: (r) => esc(r.receipt_no) },
      { label: 'Customer', render: (r) => `<b>${esc(r.customer_name)}</b><br><span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Mode', render: (r) => `${esc(C.MODE_LABEL[r.mode] || r.mode)}
          ${r.cheque_no ? `<br><span class="mini-note">chq ${esc(r.cheque_no)} &middot; ${fmt.date(r.cheque_date)}</span>` : ''}
          ${r.transfer_ref ? `<br><span class="mini-note">ref ${esc(r.transfer_ref)}</span>` : ''}` },
      { label: 'Cheque status', render: (r) => r.is_cheque ? badge(r.pdc_status) : '<span class="mini-note">-</span>' },
      { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` },
      { label: 'Unapplied', num: true, render: (r) => r.unallocated_amount > 0.005 ? fmt.money(r.unallocated_amount) : '-' },
      { label: '', render: (r) => C.can('receipt.edit') && r.is_cheque && r.pdc_status !== 'CLEARED'
          ? `<button class="btn small primary" data-act="cheque" data-id="${r.id}">Cheque status</button>` : '' }
    ], {
      empty: 'No receipts recorded yet',
      emptyIcon: '&#128176;',
      footer: ['<b>Totals</b>', '', '', '', '', fmt.money(data.totals.total), '', '']
    });

    body.querySelectorAll('[data-act="cheque"]').forEach((btn) => {
      const row = data.rows.find((r) => r.id === Number(btn.dataset.id));
      btn.onclick = () => customerChequeForm(row, () => drawReceipts(host));
    });
  }

  function receiptForm(preset, after) {
    const companyId = preset.company_id || C.State.companyId || (C.State.companies[0] || {}).id;
    const modal = Modal.open({
      title: 'Record money received',
      size: 'wide',
      body: `
        ${C.formFields([
          { type: 'group', className: 'grid-2', fields: [
            { name: 'company_id', label: 'Company', type: 'select', required: true,
              options: C.opt.companies(false), value: companyId },
            { name: 'customer_id', label: 'Customer', type: 'select', required: true,
              options: [{ value: '', label: 'Choose a customer' }].concat(C.opt.customers()),
              value: preset.customer_id || '' }
          ] },
          { type: 'group', className: 'grid-4', fields: [
            { name: 'receipt_date', label: 'Received on', type: 'date', required: true, value: C.today() },
            { name: 'amount', label: 'Amount', type: 'number', required: true, value: preset.amount || '' },
            { name: 'mode', label: 'Mode', type: 'select', required: true,
              options: C.opt.modes(), value: 'BANK_TRANSFER' },
            { name: 'receipt_type', label: 'Type', type: 'select',
              options: [
                { value: 'INVOICE', label: 'Against invoice(s)' },
                { value: 'ADVANCE', label: 'Advance from customer' }
              ], value: 'INVOICE' }
          ] }
        ])}
        <div id="rcp-mode"></div>
        <div id="rcp-alloc"><div class="mini-note">Choose a customer to see their open invoices.</div></div>
        ${C.formFields([{ name: 'narration', label: 'Narration', type: 'textarea' }])}`,
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">Save receipt</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const $ = (s) => modal.querySelector(s);
    const modeSel = $('[name="mode"]');
    const custSel = $('[name="customer_id"]');
    const compSel = $('[name="company_id"]');

    function modeFields() {
      const mode = modeSel.value;
      const box = $('#rcp-mode');
      if (mode === 'CASH') { box.innerHTML = ''; return; }
      if (mode === 'PDC' || mode === 'CHEQUE') {
        box.innerHTML = `<div class="mode-fields"><div class="mode-title">Customer cheque</div>
          ${C.formFields([{ type: 'group', className: 'grid-3', fields: [
            { name: 'cheque_no', label: 'Cheque number', required: true },
            { name: 'cheque_date', label: 'Cheque date', type: 'date', required: true, value: C.today() },
            { name: 'cheque_bank_name', label: 'Their bank' }
          ] }])}</div>`;
        return;
      }
      box.innerHTML = `<div class="mode-fields"><div class="mode-title">Transfer details</div>
        ${C.formFields([{ type: 'group', className: 'grid-3', fields: [
          { name: 'party_bank_name', label: 'Sent from which bank' },
          { name: 'transfer_ref', label: 'Reference / UTR' },
          { name: 'to_bank_account_id', label: 'Into our account', type: 'select',
            options: C.opt.banks(compSel.value, 'Not recorded') }
        ] }])}</div>`;
    }

    async function loadInvoices() {
      const box = $('#rcp-alloc');
      if (!custSel.value) { box.innerHTML = '<div class="mini-note">Choose a customer to see their open invoices.</div>'; return; }
      const qs = compSel.value ? `?company_id=${compSel.value}` : '';
      const invoices = await API.get(`/api/sales/invoices/open/for-customer/${custSel.value}${qs}`);
      if (!invoices.length) {
        box.innerHTML = '<div class="alert">No open invoices for this customer. Save it as an advance if the money has come in early.</div>';
        return;
      }
      box.innerHTML = `
        <h4 style="font-size:13px;margin:8px 0">Apply to invoices</h4>
        <div class="table-scroll"><table class="alloc-table">
          <thead><tr><th style="width:30px"></th><th>Invoice no</th><th>Due</th>
            <th class="num">Outstanding</th><th class="num" style="width:135px">Apply</th></tr></thead>
          <tbody>${invoices.map((inv) => {
            const pre = (preset.preselect || []).find((p) => Number(p.invoice_id) === inv.id);
            return `<tr class="${inv.is_overdue ? 'row-overdue' : ''}">
              <td><input type="checkbox" class="ra-check" data-id="${inv.id}" ${pre ? 'checked' : ''}></td>
              <td class="mono">${esc(inv.invoice_no)}</td>
              <td>${inv.due_date ? fmt.date(inv.due_date) : '-'}</td>
              <td class="num">${fmt.money(inv.outstanding)}</td>
              <td class="num"><input type="number" step="0.01" min="0" class="ra-amount"
                    data-id="${inv.id}" data-max="${inv.outstanding}"
                    value="${pre ? Number(pre.amount).toFixed(2) : ''}"></td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>`;
      box.querySelectorAll('.ra-check').forEach((cb) => {
        cb.onchange = () => {
          const amt = box.querySelector(`.ra-amount[data-id="${cb.dataset.id}"]`);
          amt.value = cb.checked ? Number(amt.dataset.max).toFixed(2) : '';
        };
      });
    }

    modeSel.onchange = modeFields;
    custSel.onchange = loadInvoices;
    compSel.onchange = () => { modeFields(); loadInvoices(); };
    modeFields();
    loadInvoices();

    C.wireSave(modal, async (b) => {
      b.allocations = [...modal.querySelectorAll('.ra-amount')]
        .map((i) => ({ invoice_id: Number(i.dataset.id), amount: Number(i.value || 0) }))
        .filter((a) => a.amount > 0);
      await API.post('/api/sales/receipts', b);
    }, { success: 'Receipt recorded', after });
  }

  function customerChequeForm(receipt, after) {
    const modal = Modal.open({
      title: `Customer cheque ${receipt.cheque_no || receipt.receipt_no}`,
      subtitle: `${C.State.currency} ${fmt.money(receipt.amount)} from ${receipt.customer_name}`,
      size: 'narrow',
      body: C.formFields([
        { name: 'status', label: 'New status', type: 'select', required: true, value: 'CLEARED',
          options: [
            { value: 'PRESENTED', label: 'Presented to the bank' },
            { value: 'CLEARED', label: 'Cleared' },
            { value: 'BOUNCED', label: 'Bounced' },
            { value: 'REPLACED', label: 'Replaced' },
            { value: 'CANCELLED', label: 'Cancelled' }
          ] },
        { name: 'cleared_date', label: 'Cleared on', type: 'date', value: C.today() },
        { name: 'reason', label: 'Reason', type: 'textarea' }
      ]),
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">Update</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      await API.post(`/api/sales/receipts/${receipt.id}/pdc-status`, b);
    }, { success: 'Cheque updated', after });
  }

  window.Income = { render };
})();
