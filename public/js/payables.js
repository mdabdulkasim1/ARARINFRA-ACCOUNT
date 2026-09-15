/* Supplier invoices, payments in every mode, the cheque register and the
   supplier statement. This is where the cash-out control actually happens. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge, API, Modal, toast } = C;

  // ================================================================ invoices

  const INVOICE_TABS = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'due_soon', label: 'Due in 7 days' },
    { key: 'unsubmitted', label: 'Not submitted' }
  ];

  let invoiceFilters = { view: 'open', supplier_id: '', status: '', q: '', from: '', to: '' };

  async function renderInvoices(host, query) {
    if (query && query.view) invoiceFilters.view = query.view;
    if (query && query.supplier_id) invoiceFilters.supplier_id = query.supplier_id;

    host.innerHTML = shell();
    await refreshInvoices(host);

    host.querySelector('#new-invoice').onclick = () => invoiceForm(null, () => refreshInvoices(host));
    host.querySelectorAll('.tabs button').forEach((b) => {
      b.onclick = () => {
        invoiceFilters.view = b.dataset.view;
        host.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        refreshInvoices(host);
      };
    });
    bindFilters(host, invoiceFilters, () => refreshInvoices(host));

    function shell() {
      return `
        <div class="tabs">
          ${INVOICE_TABS.map((t) =>
            `<button data-view="${t.key}" class="${invoiceFilters.view === t.key ? 'active' : ''}">${t.label}</button>`
          ).join('')}
        </div>
        <div class="toolbar">
          <div class="field grow">
            <label>Search</label>
            <input type="search" data-filter="q" value="${esc(invoiceFilters.q)}"
                   placeholder="Invoice number, supplier, LPO or project">
          </div>
          <div class="field">
            <label>Supplier</label>
            <select data-filter="supplier_id">
              ${optionsHtml(C.opt.suppliers(true), invoiceFilters.supplier_id)}
            </select>
          </div>
          <div class="field">
            <label>Submitted from</label>
            <input type="date" data-filter="from" value="${esc(invoiceFilters.from)}">
          </div>
          <div class="field">
            <label>to</label>
            <input type="date" data-filter="to" value="${esc(invoiceFilters.to)}">
          </div>
          <div class="spacer"></div>
          <button class="btn" data-act="export">Export CSV</button>
          ${C.can('invoice.create') ? '<button class="btn primary" id="new-invoice">+ New invoice</button>' : ''}
        </div>
        <div id="invoice-summary"></div>
        <div class="card"><div class="body tight" id="invoice-table"><div class="loading">Loading&hellip;</div></div></div>`;
    }
  }

  async function refreshInvoices(host) {
    const box = host.querySelector('#invoice-table');
    box.innerHTML = '<div class="loading">Loading invoices&hellip;</div>';
    const params = new URLSearchParams();
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    Object.entries(invoiceFilters).forEach(([k, v]) => { if (v) params.set(k, v); });

    const data = await API.get(`/api/purchase-invoices?${params}`);
    const t = data.totals;

    host.querySelector('#invoice-summary').innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi is-primary">
          <div class="label">Invoice value</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.total)}</div>
          <div class="foot">${fmt.int(t.count)} invoices listed</div>
        </div>
        <div class="kpi is-ok">
          <div class="label">Paid</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.paid)}</div>
          <div class="foot">Money that has actually gone out</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Covered by cheques</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.pdc)}</div>
          <div class="foot">PDC issued, waiting to clear</div>
        </div>
        <div class="kpi is-primary">
          <div class="label">Outstanding</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.outstanding)}</div>
          <div class="foot">Still to arrange: ${fmt.money(t.net_payable)}</div>
        </div>
        <div class="kpi is-danger">
          <div class="label">Overdue</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.overdue_amount)}</div>
          <div class="foot">${fmt.int(t.overdue_count)} invoices past due</div>
        </div>
      </div>`;

    box.innerHTML = C.table(data.rows, [
      { label: 'Supplier', render: (r) => `<b>${esc(r.supplier_name)}</b><br><span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Invoice no', mono: true, render: (r) => esc(r.invoice_no) },
      { label: 'Invoice date', render: (r) => `<span class="nowrap">${fmt.date(r.invoice_date)}</span>` },
      { label: 'Submitted', render: (r) => r.submitted_date
          ? `<span class="nowrap">${fmt.date(r.submitted_date)}</span>`
          : '<span class="badge amber">Not submitted</span>' },
      { label: 'Terms', num: true, render: (r) => `${r.payment_terms_days} d` },
      { label: 'Due date', render: (r) => r.due_date
          ? `<span class="nowrap ${r.is_overdue ? 'amount-danger strong' : ''}">${fmt.date(r.due_date)}</span>
             ${r.is_overdue ? `<br><span class="mini-note amount-danger">${r.days_overdue} days late</span>`
               : (r.is_due_soon ? `<br><span class="mini-note">in ${r.days_to_due} days</span>` : '')}`
          : '<span class="mini-note">-</span>' },
      { label: 'Total', num: true, render: (r) => fmt.money(r.total_amount) },
      { label: 'Paid', num: true, render: (r) => r.paid_amount ? fmt.money(r.paid_amount) : '<span class="mini-note">-</span>' },
      { label: 'PDC', num: true, render: (r) => r.pdc_amount ? `<span class="badge blue">${fmt.money(r.pdc_amount)}</span>` : '<span class="mini-note">-</span>' },
      { label: 'Outstanding', num: true, render: (r) =>
          `<b class="${r.is_overdue ? 'amount-danger' : ''}">${fmt.money(r.outstanding)}</b>` },
      { label: 'Status', render: (r) => badge(r.status) },
      { label: '', render: (r) => actionsFor(r) }
    ], {
      rowClass: C.invoiceRowClass,
      empty: 'No invoices match this filter',
      emptyHint: C.can('invoice.create') ? 'Use "New invoice" to record a supplier bill.' : '',
      footer: ['<b>Totals</b>', '', '', '', '', '',
        fmt.money(t.total), fmt.money(t.paid), fmt.money(t.pdc),
        fmt.money(t.outstanding), '', '']
    });

    box.querySelectorAll('[data-act]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const act = btn.dataset.act;
      btn.onclick = async () => {
        const row = data.rows.find((r) => r.id === id);
        if (act === 'view') return invoiceDetail(id, () => refreshInvoices(host));
        if (act === 'pay') return openPaymentForInvoice(id, () => refreshInvoices(host));
        if (act === 'edit') return invoiceForm(row, () => refreshInvoices(host));
        if (act === 'hold') {
          const reason = await Modal.prompt({
            title: 'Put this invoice on hold',
            label: 'Why is it on hold?',
            hint: 'It stays out of the due and overdue lists until you release it.',
            required: true, confirmText: 'Put on hold'
          });
          if (reason === null) return;
          await API.post(`/api/purchase-invoices/${id}/hold`, { hold: true, reason });
          toast('Invoice put on hold', 'ok');
          return refreshInvoices(host);
        }
        if (act === 'release') {
          await API.post(`/api/purchase-invoices/${id}/hold`, { hold: false });
          toast('Invoice released', 'ok');
          return refreshInvoices(host);
        }
        if (act === 'delete') {
          const ok = await Modal.confirm({
            title: 'Delete this invoice?',
            message: `Invoice ${row.invoice_no} from ${row.supplier_name}. If payments have been recorded against it, it will be cancelled instead of deleted so the history stays.`,
            confirmText: 'Delete', danger: true
          });
          if (!ok) return;
          const res = await API.del(`/api/purchase-invoices/${id}`);
          toast(res.cancelled ? 'Invoice cancelled, history kept' : 'Invoice deleted', 'ok');
          return refreshInvoices(host);
        }
      };
    });

    const exportBtn = host.querySelector('[data-act="export"]');
    if (exportBtn) {
      exportBtn.onclick = () => C.downloadCsv(`supplier-invoices-${C.today()}.csv`, [
        { label: 'Company', key: 'company_name' },
        { label: 'Supplier', key: 'supplier_name' },
        { label: 'Invoice no', key: 'invoice_no' },
        { label: 'Invoice date', key: 'invoice_date' },
        { label: 'Submitted date', key: 'submitted_date' },
        { label: 'Terms (days)', key: 'payment_terms_days' },
        { label: 'Due date', key: 'due_date' },
        { label: 'Days overdue', key: 'days_overdue' },
        { label: 'Total', key: 'total_amount' },
        { label: 'Paid', key: 'paid_amount' },
        { label: 'PDC issued', key: 'pdc_amount' },
        { label: 'Outstanding', key: 'outstanding' },
        { label: 'Status', key: 'status' }
      ], data.rows);
    }
  }

  function actionsFor(r) {
    const b = [];
    b.push(`<button class="btn small" data-act="view" data-id="${r.id}">View</button>`);
    if (C.can('payment.create') && r.outstanding > 0 && r.status !== 'CANCELLED' && r.status !== 'ON_HOLD') {
      b.push(`<button class="btn small primary" data-act="pay" data-id="${r.id}">Pay</button>`);
    }
    if (C.can('invoice.edit') && r.status !== 'CANCELLED') {
      b.push(`<button class="btn small" data-act="edit" data-id="${r.id}">Edit</button>`);
    }
    if (C.can('invoice.hold') && r.status !== 'CANCELLED') {
      b.push(r.status === 'ON_HOLD'
        ? `<button class="btn small" data-act="release" data-id="${r.id}">Release</button>`
        : `<button class="btn small" data-act="hold" data-id="${r.id}">Hold</button>`);
    }
    if (C.can('invoice.delete') && r.status !== 'CANCELLED') {
      b.push(`<button class="btn small danger" data-act="delete" data-id="${r.id}">Delete</button>`);
    }
    return `<div class="btn-row">${b.join('')}</div>`;
  }

  // ---------------------------------------------------------------- invoice form

  function invoiceForm(invoice, after) {
    const isEdit = !!invoice;
    const companyId = invoice ? invoice.company_id : (C.State.companyId || (C.State.companies[0] || {}).id);
    const supplier = invoice ? C.State.suppliers.find((s) => s.id === invoice.supplier_id) : null;

    const modal = Modal.open({
      title: isEdit ? `Edit invoice ${invoice.invoice_no}` : 'New supplier invoice',
      subtitle: 'The credit period is counted from the date the invoice was submitted to us',
      size: 'wide',
      body: `
        ${C.formFields([
          { type: 'group', className: 'grid-2', fields: [
            { name: 'company_id', label: 'Company', type: 'select', required: true,
              options: C.opt.companies(false), value: companyId },
            { name: 'supplier_id', label: 'Supplier', type: 'select', required: true,
              options: [{ value: '', label: 'Choose a supplier' }].concat(C.opt.suppliers()),
              value: invoice ? invoice.supplier_id : '' }
          ] },
          { type: 'group', className: 'grid-3', fields: [
            { name: 'invoice_no', label: "Supplier's invoice reference no", required: true,
              value: invoice ? invoice.invoice_no : '',
              hint: 'Exactly as printed on their bill' },
            { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true,
              value: invoice ? invoice.invoice_date : C.today() },
            { name: 'submitted_date', label: 'Submitted to us on', type: 'date',
              value: invoice ? invoice.submitted_date : C.today(),
              hint: 'Leave blank if not received yet' }
          ] },
          { type: 'group', className: 'grid-3', fields: [
            { name: 'payment_terms_days', label: 'Payment terms', type: 'terms', required: true,
              value: invoice ? invoice.payment_terms_days : (supplier ? supplier.payment_terms_days : C.State.defaultTerms) },
            { type: 'html', html: `
              <div class="field">
                <label>Payment due on</label>
                <div id="due-preview" style="padding:8px 10px;border:1px solid var(--border);border-radius:5px;background:var(--surface-2);font-weight:600">-</div>
                <div class="hint">Submitted date plus the terms</div>
              </div>` },
            { name: 'category_id', label: 'Expense category', type: 'select',
              options: C.opt.categories('EXPENSE'), value: invoice ? invoice.category_id : '' }
          ] },
          { type: 'group', className: 'grid-3', fields: [
            { name: 'subtotal', label: 'Amount before VAT', type: 'number', required: true,
              value: invoice ? invoice.subtotal : '' },
            { name: 'tax_amount', label: 'VAT', type: 'number', value: invoice ? invoice.tax_amount : '0' },
            { name: 'total_amount', label: 'Invoice total', type: 'number', required: true,
              value: invoice ? invoice.total_amount : '' }
          ] },
          { type: 'group', className: 'grid-2', fields: [
            { name: 'lpo_no', label: 'Our LPO / PO number', value: invoice ? invoice.lpo_no : '' },
            { name: 'project_ref', label: 'Project reference', value: invoice ? invoice.project_ref : '' }
          ] },
          { name: 'description', label: 'Description', type: 'textarea', value: invoice ? invoice.description : '' }
        ])}`,
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">${isEdit ? 'Save changes' : 'Save invoice'}</button>`
    });

    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const $ = (sel) => modal.querySelector(sel);
    const subtotal = $('[name="subtotal"]');
    const tax = $('[name="tax_amount"]');
    const total = $('[name="total_amount"]');
    const submitted = $('[name="submitted_date"]');
    const terms = $('[name="payment_terms_days"]');
    const supplierSel = $('[name="supplier_id"]');

    // Keep the total in step with the parts, unless the user typed a total themselves.
    let totalTouched = isEdit;
    total.oninput = () => { totalTouched = true; };
    const syncTotal = () => {
      if (totalTouched) return;
      const v = Number(subtotal.value || 0) + Number(tax.value || 0);
      total.value = v ? v.toFixed(2) : '';
    };
    subtotal.oninput = syncTotal;
    tax.oninput = syncTotal;

    const syncDue = () => {
      const box = $('#due-preview');
      if (!submitted.value) {
        box.innerHTML = '<span class="mini-note">No submitted date, so the clock has not started</span>';
        return;
      }
      const due = C.addDays(submitted.value, Number(terms.value || 0));
      const late = due < C.today();
      box.innerHTML = `<span class="${late ? 'amount-danger' : ''}">${fmt.date(due)}</span>` +
        (late ? ' <span class="badge red">Already overdue</span>' : '');
    };
    submitted.oninput = syncDue;
    terms.oninput = syncDue;
    syncDue();

    // Picking a supplier pulls in their agreed credit period.
    supplierSel.onchange = () => {
      const s = C.State.suppliers.find((x) => String(x.id) === supplierSel.value);
      if (s && !isEdit) {
        terms.value = s.payment_terms_days;
        // Move the dropdown with it, or it keeps showing the previous supplier's terms.
        const select = modal.querySelector('[data-terms-select="payment_terms_days"]');
        if (select) {
          const known = [...select.options].some((o) => o.value === String(s.payment_terms_days));
          select.value = known ? String(s.payment_terms_days) : '__other';
          terms.hidden = known;
        }
        syncDue();
      }
    };

    C.wireSave(modal, async (body) => {
      if (isEdit) await API.put(`/api/purchase-invoices/${invoice.id}`, body);
      else await API.post('/api/purchase-invoices', body);
    }, { success: isEdit ? 'Invoice updated' : 'Invoice saved', after });
  }

  // ---------------------------------------------------------------- invoice detail

  async function invoiceDetail(id, after) {
    const inv = await API.get(`/api/purchase-invoices/${id}`);
    const modal = Modal.open({
      title: `Invoice ${inv.invoice_no}`,
      subtitle: `${inv.supplier_name} - ${inv.company_name}`,
      size: 'wide',
      body: `
        ${inv.is_overdue ? `<div class="alert error"><b>Overdue by ${inv.days_overdue} days.</b> This was due on ${fmt.date(inv.due_date)}.</div>` : ''}
        ${inv.status === 'ON_HOLD' ? `<div class="alert warn"><b>On hold.</b> ${esc(inv.hold_reason || '')}</div>` : ''}
        ${!inv.submitted_date ? '<div class="alert">No submitted date recorded, so the credit period has not started.</div>' : ''}

        <div class="grid-2" style="gap:0 24px">
          <dl class="kv">
            <dt>Supplier</dt><dd>${esc(inv.supplier_name)} <span class="mini-note">${esc(inv.supplier_code)}</span></dd>
            <dt>Company</dt><dd>${esc(inv.company_name)}</dd>
            <dt>Invoice date</dt><dd>${fmt.date(inv.invoice_date)}</dd>
            <dt>Submitted on</dt><dd>${inv.submitted_date ? fmt.date(inv.submitted_date) : '<span class="badge amber">Not submitted</span>'}</dd>
            <dt>Payment terms</dt><dd>${inv.payment_terms_days} days from submission</dd>
            <dt>Due date</dt><dd>${inv.due_date ? fmt.date(inv.due_date) : '-'}</dd>
          </dl>
          <dl class="kv">
            <dt>Invoice total</dt><dd>${C.State.currency} ${fmt.money(inv.total_amount)}</dd>
            <dt>Paid</dt><dd class="amount-ok">${C.State.currency} ${fmt.money(inv.paid_amount)}</dd>
            <dt>PDC issued</dt><dd>${C.State.currency} ${fmt.money(inv.pdc_amount)}</dd>
            <dt>Outstanding</dt><dd class="${inv.is_overdue ? 'amount-danger' : ''}"><b>${C.State.currency} ${fmt.money(inv.outstanding)}</b></dd>
            <dt>Still to arrange</dt><dd>${C.State.currency} ${fmt.money(inv.net_payable)}</dd>
            <dt>Status</dt><dd>${badge(inv.status)}</dd>
          </dl>
        </div>

        ${inv.lpo_no || inv.project_ref || inv.description ? `
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
            <dl class="kv">
              ${inv.lpo_no ? `<dt>LPO</dt><dd>${esc(inv.lpo_no)}</dd>` : ''}
              ${inv.project_ref ? `<dt>Project</dt><dd>${esc(inv.project_ref)}</dd>` : ''}
              ${inv.category_name ? `<dt>Category</dt><dd>${esc(inv.category_name)}</dd>` : ''}
              ${inv.description ? `<dt>Description</dt><dd>${esc(inv.description)}</dd>` : ''}
              ${inv.created_by_name ? `<dt>Entered by</dt><dd>${esc(inv.created_by_name)} on ${fmt.dateTime(inv.created_at)}</dd>` : ''}
            </dl>
          </div>` : ''}

        <h4 style="margin:18px 0 8px">Payments against this invoice</h4>
        ${C.table(inv.payments, [
          { label: 'Date', render: (p) => fmt.date(p.payment_date) },
          { label: 'Reference', mono: true, render: (p) => esc(p.payment_no) },
          { label: 'Mode', render: (p) => `${esc(C.MODE_LABEL[p.mode] || p.mode)}${p.cheque_no ? `<br><span class="mini-note">Chq ${esc(p.cheque_no)} dated ${fmt.date(p.cheque_date)}</span>` : ''}${p.party_bank_name ? `<br><span class="mini-note">${esc(p.party_bank_name)}</span>` : ''}` },
          { label: 'Cheque status', render: (p) => p.pdc_status ? badge(p.pdc_status) : '<span class="mini-note">-</span>' },
          { label: 'Applied', num: true, render: (p) => `<b>${fmt.money(p.allocated)}</b>` }
        ], { empty: 'Nothing paid against this invoice yet', emptyIcon: '&#128181;' })}`,
      footer: `
        <button class="btn" data-act="close">Close</button>
        <div class="spacer"></div>
        ${C.can('payment.create') && inv.outstanding > 0 && inv.status !== 'CANCELLED'
          ? '<button class="btn primary" data-act="pay">Record a payment</button>' : ''}`
    });
    modal.querySelector('[data-act="close"]').onclick = () => Modal.close();
    const payBtn = modal.querySelector('[data-act="pay"]');
    if (payBtn) payBtn.onclick = () => { Modal.close(); openPaymentForInvoice(id, after); };
  }

  // ================================================================ payments

  let paymentFilters = { view: 'all', supplier_id: '', mode: '', payment_type: '', q: '', from: '', to: '' };

  const PAYMENT_TABS = [
    { key: 'all', label: 'All payments' },
    { key: 'pdc_pending', label: 'Cheques to clear' },
    { key: 'advances_open', label: 'Advances on account' }
  ];

  async function renderPayments(host, query) {
    if (query && query.view) paymentFilters.view = query.view;
    if (query && query.supplier_id) paymentFilters.supplier_id = query.supplier_id;

    host.innerHTML = `
      <div class="tabs">
        ${PAYMENT_TABS.map((t) =>
          `<button data-view="${t.key}" class="${paymentFilters.view === t.key ? 'active' : ''}">${t.label}</button>`
        ).join('')}
      </div>
      <div class="toolbar">
        <div class="field grow">
          <label>Search</label>
          <input type="search" data-filter="q" value="${esc(paymentFilters.q)}"
                 placeholder="Payment number, cheque number, UTR or supplier">
        </div>
        <div class="field">
          <label>Supplier</label>
          <select data-filter="supplier_id">${optionsHtml(C.opt.suppliers(true), paymentFilters.supplier_id)}</select>
        </div>
        <div class="field">
          <label>Mode</label>
          <select data-filter="mode">
            ${optionsHtml([{ value: '', label: 'All modes' }].concat(C.opt.modes()), paymentFilters.mode)}
          </select>
        </div>
        <div class="field">
          <label>Type</label>
          <select data-filter="payment_type">
            ${optionsHtml([
              { value: '', label: 'All' },
              { value: 'INVOICE', label: 'Against invoice' },
              { value: 'ADVANCE', label: 'Advance' }
            ], paymentFilters.payment_type)}
          </select>
        </div>
        <div class="spacer"></div>
        <button class="btn" data-act="export">Export CSV</button>
        ${C.can('payment.create') ? '<button class="btn primary" id="new-payment">+ New payment</button>' : ''}
      </div>
      <div id="payment-summary"></div>
      <div class="card"><div class="body tight" id="payment-table"><div class="loading">Loading&hellip;</div></div></div>`;

    host.querySelectorAll('.tabs button').forEach((b) => {
      b.onclick = () => {
        paymentFilters.view = b.dataset.view;
        host.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
        refreshPayments(host);
      };
    });
    bindFilters(host, paymentFilters, () => refreshPayments(host));
    const nb = host.querySelector('#new-payment');
    if (nb) nb.onclick = () => paymentForm({}, () => refreshPayments(host));

    await refreshPayments(host);
  }

  async function refreshPayments(host) {
    const box = host.querySelector('#payment-table');
    box.innerHTML = '<div class="loading">Loading payments&hellip;</div>';
    const params = new URLSearchParams();
    if (C.State.companyId) params.set('company_id', C.State.companyId);
    Object.entries(paymentFilters).forEach(([k, v]) => { if (v) params.set(k, v); });

    const data = await API.get(`/api/payments?${params}`);
    const t = data.totals;

    host.querySelector('#payment-summary').innerHTML = `
      <div class="kpi-grid" style="margin-bottom:14px">
        <div class="kpi is-primary">
          <div class="label">Payments listed</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.total)}</div>
          <div class="foot">${fmt.int(t.count)} entries</div>
        </div>
        <div class="kpi is-ok">
          <div class="label">Actually settled</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.settled)}</div>
          <div class="foot">Cash, transfers and cleared cheques</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Cheques still to clear</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.pdc_pending)}</div>
          <div class="foot">Issued or presented</div>
        </div>
        <div class="kpi is-warn">
          <div class="label">Advances on account</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(t.advance_unallocated)}</div>
          <div class="foot">Paid but not yet set against an invoice</div>
        </div>
      </div>`;

    box.innerHTML = C.table(data.rows, [
      { label: 'Date', render: (r) => `<span class="nowrap">${fmt.date(r.payment_date)}</span>` },
      { label: 'Reference', mono: true, render: (r) => esc(r.payment_no) },
      { label: 'Supplier', render: (r) => `<b>${esc(r.supplier_name)}</b><br><span class="mini-note">${esc(r.company_code)}</span>` },
      { label: 'Mode', render: (r) => modeCell(r) },
      { label: 'Type', render: (r) => r.is_advance
          ? '<span class="badge purple">Advance</span>'
          : '<span class="badge grey">Against invoice</span>' },
      { label: 'Cheque status', render: (r) => r.is_cheque ? badge(r.pdc_status) : '<span class="mini-note">-</span>' },
      { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` },
      { label: 'Unapplied', num: true, render: (r) => r.unallocated_amount > 0.005
          ? `<span class="badge purple">${fmt.money(r.unallocated_amount)}</span>`
          : '<span class="mini-note">-</span>' },
      { label: '', render: (r) => paymentActions(r) }
    ], {
      rowClass: (r) => r.status === 'CANCELLED' ? 'row-muted' : (r.cheque_date_passed ? 'row-overdue' : (r.cheque_due_soon ? 'row-due-soon' : '')),
      empty: 'No payments match this filter',
      emptyIcon: '&#128181;',
      footer: ['<b>Totals</b>', '', '', '', '', '', fmt.money(t.total), fmt.money(t.advance_unallocated), '']
    });

    wirePaymentActions(box, data.rows, () => refreshPayments(host));

    host.querySelector('[data-act="export"]').onclick = () =>
      C.downloadCsv(`payments-${C.today()}.csv`, [
        { label: 'Company', key: 'company_name' },
        { label: 'Payment no', key: 'payment_no' },
        { label: 'Date', key: 'payment_date' },
        { label: 'Supplier', key: 'supplier_name' },
        { label: 'Mode', value: (r) => C.MODE_LABEL[r.mode] || r.mode },
        { label: 'Type', key: 'payment_type' },
        { label: 'Party bank', key: 'party_bank_name' },
        { label: 'Transfer ref', key: 'transfer_ref' },
        { label: 'Cheque no', key: 'cheque_no' },
        { label: 'Cheque date', key: 'cheque_date' },
        { label: 'Cheque bank', key: 'cheque_bank_name' },
        { label: 'Cheque status', key: 'pdc_status' },
        { label: 'Amount', key: 'amount' },
        { label: 'Unapplied', key: 'unallocated_amount' }
      ], data.rows);
  }

  function modeCell(r) {
    const bits = [`<b>${esc(C.MODE_LABEL[r.mode] || r.mode)}</b>`];
    if (r.party_bank_name) bits.push(`<span class="mini-note">to ${esc(r.party_bank_name)}</span>`);
    if (r.transfer_ref) bits.push(`<span class="mini-note">ref ${esc(r.transfer_ref)}</span>`);
    if (r.cheque_no) bits.push(`<span class="mini-note">chq ${esc(r.cheque_no)} &middot; ${fmt.date(r.cheque_date)}</span>`);
    if (r.cheque_bank_name) bits.push(`<span class="mini-note">on ${esc(r.cheque_bank_name)}</span>`);
    return bits.join('<br>');
  }

  function paymentActions(r) {
    const b = [`<button class="btn small" data-act="view" data-id="${r.id}">View</button>`];
    if (C.can('payment.pdcstatus') && r.is_cheque && r.pdc_status !== 'CLEARED' && r.status !== 'CANCELLED') {
      b.push(`<button class="btn small primary" data-act="cheque" data-id="${r.id}">Cheque status</button>`);
    }
    if (C.can('payment.edit') && r.unallocated_amount > 0.005 && r.status !== 'CANCELLED') {
      b.push(`<button class="btn small" data-act="allocate" data-id="${r.id}">Apply</button>`);
    }
    if (C.can('payment.delete')) {
      b.push(`<button class="btn small danger" data-act="delete" data-id="${r.id}">Delete</button>`);
    }
    return `<div class="btn-row">${b.join('')}</div>`;
  }

  function wirePaymentActions(box, rows, after) {
    box.querySelectorAll('[data-act]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const row = rows.find((r) => r.id === id);
      btn.onclick = async () => {
        if (btn.dataset.act === 'view') return paymentDetail(id);
        if (btn.dataset.act === 'cheque') return chequeStatusForm(row, after);
        if (btn.dataset.act === 'allocate') return allocateForm(row, after);
        if (btn.dataset.act === 'delete') {
          const ok = await Modal.confirm({
            title: 'Delete this payment?',
            message: `${row.payment_no} of ${C.State.currency} ${fmt.money(row.amount)} to ${row.supplier_name}. The invoices it was applied to will go back to outstanding.`,
            confirmText: 'Delete', danger: true
          });
          if (!ok) return;
          await API.del(`/api/payments/${id}`);
          toast('Payment deleted', 'ok');
          after();
        }
      };
    });
  }

  // ---------------------------------------------------------------- payment form

  async function openPaymentForInvoice(invoiceId, after) {
    const inv = await API.get(`/api/purchase-invoices/${invoiceId}`);
    paymentForm({
      company_id: inv.company_id,
      supplier_id: inv.supplier_id,
      amount: inv.outstanding,
      preselect: [{ invoice_id: inv.id, amount: inv.outstanding }]
    }, after);
  }

  function paymentForm(preset, after) {
    const companyId = preset.company_id || C.State.companyId || (C.State.companies[0] || {}).id;

    const modal = Modal.open({
      title: 'Record a payment to a supplier',
      subtitle: 'Cash, bank transfer, post dated cheque, or an advance before delivery',
      size: 'wide',
      body: `
        ${C.formFields([
          { type: 'group', className: 'grid-2', fields: [
            { name: 'company_id', label: 'Company', type: 'select', required: true,
              options: C.opt.companies(false), value: companyId },
            { name: 'supplier_id', label: 'Supplier', type: 'select', required: true,
              options: [{ value: '', label: 'Choose a supplier' }].concat(C.opt.suppliers()),
              value: preset.supplier_id || '' }
          ] },
          { type: 'group', className: 'grid-3', fields: [
            { name: 'payment_date', label: 'Payment date', type: 'date', required: true, value: C.today() },
            { name: 'amount', label: 'Amount', type: 'number', required: true, value: preset.amount || '' },
            { name: 'payment_type', label: 'This payment is', type: 'select', required: true,
              options: [
                { value: 'INVOICE', label: 'Against invoice(s)' },
                { value: 'ADVANCE', label: 'An advance, before delivery' }
              ],
              value: preset.payment_type || 'INVOICE' }
          ] },
          { name: 'mode', label: 'Mode of payment', type: 'select', required: true,
            options: C.opt.modes(), value: preset.mode || 'BANK_TRANSFER' }
        ])}

        <div id="mode-fields"></div>

        <div id="advance-note" class="alert" hidden>
          This is recorded as an advance and stays on the supplier's account. Apply it to an
          invoice later, once the material or service has been delivered.
        </div>

        <div id="alloc-wrap">
          <div style="display:flex;align-items:center;gap:10px;margin:6px 0 8px">
            <h4 style="font-size:13px">Which invoices does this settle?</h4>
            <div class="spacer" style="flex:1"></div>
            <button type="button" class="btn small" id="auto-fill">Fill oldest first</button>
            <button type="button" class="btn small" id="clear-alloc">Clear</button>
          </div>
          <div id="alloc-box"><div class="mini-note">Choose a supplier to see their open invoices.</div></div>
          <div id="alloc-summary" class="mini-note" style="margin-top:8px"></div>
        </div>

        ${C.formFields([{ name: 'narration', label: 'Narration', type: 'textarea',
          attrs: { placeholder: 'Anything worth noting about this payment' } }])}`,
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">Save payment</button>`
    });

    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const $ = (s) => modal.querySelector(s);
    const modeSel = $('[name="mode"]');
    const typeSel = $('[name="payment_type"]');
    const supplierSel = $('[name="supplier_id"]');
    const companySel = $('[name="company_id"]');
    const amountInput = $('[name="amount"]');
    let openInvoices = [];

    function renderModeFields() {
      const mode = modeSel.value;
      const supplier = C.State.suppliers.find((s) => String(s.id) === supplierSel.value);
      const box = $('#mode-fields');
      if (mode === 'CASH') {
        box.innerHTML = '<div class="alert">Paid in cash. Nothing further to record.</div>';
        return;
      }
      if (mode === 'BANK_TRANSFER' || mode === 'ONLINE' || mode === 'OTHER') {
        box.innerHTML = `
          <div class="mode-fields">
            <div class="mode-title">Where the money went</div>
            ${C.formFields([
              { type: 'group', className: 'grid-2', fields: [
                { name: 'party_bank_name', label: "Supplier's bank name",
                  required: mode !== 'OTHER',
                  value: supplier ? supplier.bank_name : '',
                  hint: 'The bank that received the money' },
                { name: 'party_account_no', label: "Supplier's account / IBAN",
                  value: supplier ? (supplier.iban || supplier.bank_account_no || '') : '' }
              ] },
              { type: 'group', className: 'grid-2', fields: [
                { name: 'from_bank_account_id', label: 'Paid from our account', type: 'select',
                  options: C.opt.banks(companySel.value, 'Not recorded') },
                { name: 'transfer_ref', label: 'Transfer reference / UTR' }
              ] }
            ])}
          </div>`;
        return;
      }
      // PDC and ordinary cheques
      box.innerHTML = `
        <div class="mode-fields">
          <div class="mode-title">${mode === 'PDC' ? 'Post dated cheque details' : 'Cheque details'}</div>
          ${C.formFields([
            { type: 'group', className: 'grid-3', fields: [
              { name: 'cheque_no', label: 'Cheque number', required: true },
              { name: 'cheque_date', label: mode === 'PDC' ? 'Cheque date (post dated)' : 'Cheque date',
                type: 'date', required: true,
                value: mode === 'PDC' ? C.addDays(C.today(), 30) : C.today(),
                hint: 'The date written on the cheque' },
              { name: 'from_bank_account_id', label: 'Drawn on our account', type: 'select',
                options: C.opt.banks(companySel.value, 'Choose the bank') }
            ] },
            { type: 'group', className: 'grid-2', fields: [
              { name: 'cheque_bank_name', label: 'Bank name on the cheque', required: true,
                hint: 'Filled in from the account above if you leave it blank' },
              { name: 'party_bank_name', label: "Supplier's bank (if known)",
                value: supplier ? supplier.bank_name : '' }
            ] }
          ])}
        </div>`;
      const bankSel = $('[name="from_bank_account_id"]');
      const bankName = $('[name="cheque_bank_name"]');
      const syncBank = () => {
        const acc = C.State.bankAccounts.find((b) => String(b.id) === bankSel.value);
        if (acc && !bankName.value) bankName.value = acc.bank_name;
      };
      bankSel.onchange = syncBank;
      syncBank();
    }

    function renderAllocations(preselect) {
      const wrap = $('#alloc-wrap');
      const advance = typeSel.value === 'ADVANCE';
      $('#advance-note').hidden = !advance;
      wrap.hidden = false;

      const box = $('#alloc-box');
      if (!supplierSel.value) {
        box.innerHTML = '<div class="mini-note">Choose a supplier to see their open invoices.</div>';
        return;
      }
      if (!openInvoices.length) {
        box.innerHTML = `<div class="alert">This supplier has no open invoices in ${esc(C.companyName(companySel.value) || 'this company')}.
          ${advance ? '' : ' Switch the type above to <b>An advance</b> to pay them anyway.'}</div>`;
        return;
      }
      box.innerHTML = `
        <div class="table-scroll">
          <table class="alloc-table">
            <thead>
              <tr>
                <th style="width:30px"></th>
                <th>Invoice no</th><th>Submitted</th><th>Due</th>
                <th class="num">Outstanding</th><th class="num" style="width:135px">Apply</th>
              </tr>
            </thead>
            <tbody>
              ${openInvoices.map((inv) => {
                const pre = (preselect || []).find((p) => Number(p.invoice_id) === inv.id);
                return `
                <tr class="${inv.is_overdue ? 'row-overdue' : ''}">
                  <td><input type="checkbox" class="alloc-check" data-id="${inv.id}" ${pre ? 'checked' : ''}></td>
                  <td class="mono">${esc(inv.invoice_no)}</td>
                  <td>${inv.submitted_date ? fmt.date(inv.submitted_date) : '<span class="mini-note">not submitted</span>'}</td>
                  <td>${inv.due_date
                        ? `<span class="${inv.is_overdue ? 'amount-danger strong' : ''}">${fmt.date(inv.due_date)}</span>
                           ${inv.is_overdue ? `<br><span class="mini-note amount-danger">${inv.days_overdue}d late</span>` : ''}`
                        : '<span class="mini-note">-</span>'}</td>
                  <td class="num">${fmt.money(inv.outstanding)}</td>
                  <td class="num">
                    <input type="number" step="0.01" min="0" max="${inv.outstanding}"
                           class="alloc-amount" data-id="${inv.id}" data-max="${inv.outstanding}"
                           value="${pre ? Number(pre.amount).toFixed(2) : ''}">
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;

      box.querySelectorAll('.alloc-check').forEach((cb) => {
        cb.onchange = () => {
          const amt = box.querySelector(`.alloc-amount[data-id="${cb.dataset.id}"]`);
          if (cb.checked && !Number(amt.value)) amt.value = Number(amt.dataset.max).toFixed(2);
          if (!cb.checked) amt.value = '';
          syncAllocSummary();
        };
      });
      box.querySelectorAll('.alloc-amount').forEach((inp) => {
        inp.oninput = () => {
          const cb = box.querySelector(`.alloc-check[data-id="${inp.dataset.id}"]`);
          cb.checked = Number(inp.value) > 0;
          syncAllocSummary();
        };
      });
      syncAllocSummary();
    }

    function currentAllocations() {
      return [...modal.querySelectorAll('.alloc-amount')]
        .map((i) => ({ invoice_id: Number(i.dataset.id), amount: Number(i.value || 0) }))
        .filter((a) => a.amount > 0);
    }

    function syncAllocSummary() {
      const allocated = currentAllocations().reduce((s, a) => s + a.amount, 0);
      const amount = Number(amountInput.value || 0);
      const left = amount - allocated;
      const el = $('#alloc-summary');
      if (!amount && !allocated) { el.textContent = ''; return; }
      if (left < -0.005) {
        el.innerHTML = `<span class="amount-danger"><b>${fmt.money(-left)} more</b> has been applied than the payment amount.</span>`;
      } else if (left > 0.005) {
        el.innerHTML = `Applied ${fmt.money(allocated)} of ${fmt.money(amount)}. <b>${fmt.money(left)}</b> will stay on the supplier's account as an advance.`;
      } else if (allocated > 0) {
        el.innerHTML = `<span class="amount-ok">The whole payment of ${fmt.money(allocated)} is applied to invoices.</span>`;
      } else {
        el.textContent = '';
      }
    }

    async function loadOpenInvoices(preselect) {
      if (!supplierSel.value) { openInvoices = []; return renderAllocations(); }
      const qs = companySel.value ? `?company_id=${encodeURIComponent(companySel.value)}` : '';
      openInvoices = await API.get(`/api/purchase-invoices/open/for-supplier/${supplierSel.value}${qs}`);
      renderAllocations(preselect);
    }

    modeSel.onchange = renderModeFields;
    typeSel.onchange = () => renderAllocations(currentAllocations());
    companySel.onchange = () => { renderModeFields(); loadOpenInvoices(); };
    supplierSel.onchange = () => { renderModeFields(); loadOpenInvoices(); };
    amountInput.oninput = syncAllocSummary;

    $('#auto-fill').onclick = () => {
      let left = Number(amountInput.value || 0);
      modal.querySelectorAll('.alloc-amount').forEach((inp) => {
        const max = Number(inp.dataset.max);
        const take = Math.max(0, Math.min(max, left));
        inp.value = take > 0 ? take.toFixed(2) : '';
        modal.querySelector(`.alloc-check[data-id="${inp.dataset.id}"]`).checked = take > 0;
        left = Math.round((left - take) * 100) / 100;
      });
      syncAllocSummary();
    };
    $('#clear-alloc').onclick = () => {
      modal.querySelectorAll('.alloc-amount').forEach((i) => { i.value = ''; });
      modal.querySelectorAll('.alloc-check').forEach((c) => { c.checked = false; });
      syncAllocSummary();
    };

    renderModeFields();
    loadOpenInvoices(preset.preselect);

    C.wireSave(modal, async (body) => {
      body.allocations = currentAllocations();
      await API.post('/api/payments', body);
    }, { success: 'Payment recorded', after });
  }

  // ---------------------------------------------------------------- cheque status

  function chequeStatusForm(payment, after) {
    const modal = Modal.open({
      title: `Cheque ${payment.cheque_no || payment.payment_no}`,
      subtitle: `${C.State.currency} ${fmt.money(payment.amount)} to ${payment.supplier_name}, dated ${fmt.date(payment.cheque_date)}`,
      size: 'narrow',
      body: `
        <div class="alert">A cheque only reduces the payable once it is marked <b>cleared</b>.
          Until then it shows as a commitment.</div>
        ${C.formFields([
          { name: 'status', label: 'New status', type: 'select', required: true,
            value: payment.pdc_status === 'ISSUED' ? 'PRESENTED' : 'CLEARED',
            options: [
              { value: 'ISSUED', label: 'Issued - handed to the supplier' },
              { value: 'PRESENTED', label: 'Presented - given to the bank' },
              { value: 'CLEARED', label: 'Cleared - the money has gone' },
              { value: 'BOUNCED', label: 'Bounced - returned unpaid' },
              { value: 'REPLACED', label: 'Replaced by another cheque' },
              { value: 'CANCELLED', label: 'Cancelled' }
            ] },
          { name: 'cleared_date', label: 'Cleared on', type: 'date', value: C.today() },
          { name: 'reason', label: 'Reason', type: 'textarea',
            hint: 'Required when a cheque bounces' }
        ])}`,
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        <button class="btn primary" data-act="save">Update cheque</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const statusSel = modal.querySelector('[name="status"]');
    const toggle = () => {
      modal.querySelector('[data-field="cleared_date"]').hidden = statusSel.value !== 'CLEARED';
      const reason = modal.querySelector('[data-field="reason"]');
      reason.hidden = !['BOUNCED', 'CANCELLED', 'REPLACED'].includes(statusSel.value);
      reason.classList.toggle('required', statusSel.value === 'BOUNCED');
    };
    statusSel.onchange = toggle;
    toggle();

    C.wireSave(modal, async (body) => {
      await API.post(`/api/payments/${payment.id}/pdc-status`, body);
    }, { success: 'Cheque status updated', after });
  }

  // ---------------------------------------------------------------- apply an advance

  async function allocateForm(payment, after) {
    const qs = payment.company_id ? `?company_id=${payment.company_id}` : '';
    const invoices = await API.get(`/api/purchase-invoices/open/for-supplier/${payment.supplier_id}${qs}`);

    const modal = Modal.open({
      title: `Apply ${C.State.currency} ${fmt.money(payment.unallocated_amount)}`,
      subtitle: `${payment.payment_no} - ${payment.supplier_name}`,
      size: 'wide',
      body: invoices.length ? `
        <div class="alert">Set the unapplied part of this payment against the supplier's open invoices.</div>
        <div class="table-scroll">
          <table class="alloc-table">
            <thead><tr>
              <th style="width:30px"></th><th>Invoice no</th><th>Due</th>
              <th class="num">Outstanding</th><th class="num" style="width:135px">Apply</th>
            </tr></thead>
            <tbody>
              ${invoices.map((inv) => `
                <tr class="${inv.is_overdue ? 'row-overdue' : ''}">
                  <td><input type="checkbox" class="alloc-check" data-id="${inv.id}"></td>
                  <td class="mono">${esc(inv.invoice_no)}</td>
                  <td>${inv.due_date ? fmt.date(inv.due_date) : '-'}</td>
                  <td class="num">${fmt.money(inv.outstanding)}</td>
                  <td class="num"><input type="number" step="0.01" min="0" class="alloc-amount"
                        data-id="${inv.id}" data-max="${inv.outstanding}"></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div id="alloc-summary" class="mini-note" style="margin-top:9px"></div>`
        : '<div class="alert warn">This supplier has no open invoices to apply the payment to.</div>',
      footer: `
        <button class="btn" data-act="cancel">Cancel</button>
        ${invoices.length ? '<button class="btn primary" data-act="save">Apply</button>' : ''}`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    if (!invoices.length) return;

    const summary = modal.querySelector('#alloc-summary');
    const sync = () => {
      const total = [...modal.querySelectorAll('.alloc-amount')].reduce((s, i) => s + Number(i.value || 0), 0);
      const left = payment.unallocated_amount - total;
      summary.innerHTML = left < -0.005
        ? `<span class="amount-danger">That is ${fmt.money(-left)} more than the ${fmt.money(payment.unallocated_amount)} available.</span>`
        : `Applying ${fmt.money(total)}, leaving ${fmt.money(left)} on account.`;
    };
    modal.querySelectorAll('.alloc-check').forEach((cb) => {
      cb.onchange = () => {
        const amt = modal.querySelector(`.alloc-amount[data-id="${cb.dataset.id}"]`);
        amt.value = cb.checked
          ? Math.min(Number(amt.dataset.max), payment.unallocated_amount).toFixed(2)
          : '';
        sync();
      };
    });
    modal.querySelectorAll('.alloc-amount').forEach((i) => { i.oninput = sync; });
    sync();

    C.wireSave(modal, async () => {
      const allocations = [...modal.querySelectorAll('.alloc-amount')]
        .map((i) => ({ invoice_id: Number(i.dataset.id), amount: Number(i.value || 0) }))
        .filter((a) => a.amount > 0);
      if (!allocations.length) throw new Error('Choose at least one invoice and an amount');
      await API.post(`/api/payments/${payment.id}/allocate`, { allocations });
    }, { success: 'Payment applied', after });
  }

  async function paymentDetail(id) {
    const p = await API.get(`/api/payments/${id}`);
    Modal.open({
      title: p.payment_no,
      subtitle: `${p.supplier_name} - ${p.company_name}`,
      size: 'wide',
      body: `
        <div class="grid-2" style="gap:0 24px">
          <dl class="kv">
            <dt>Date</dt><dd>${fmt.date(p.payment_date)}</dd>
            <dt>Amount</dt><dd><b>${C.State.currency} ${fmt.money(p.amount)}</b></dd>
            <dt>Mode</dt><dd>${esc(C.MODE_LABEL[p.mode] || p.mode)}</dd>
            <dt>Type</dt><dd>${p.payment_type === 'ADVANCE' ? 'Advance before delivery' : 'Against invoice'}</dd>
            <dt>Status</dt><dd>${badge(p.status)}</dd>
          </dl>
          <dl class="kv">
            ${p.party_bank_name ? `<dt>Supplier bank</dt><dd>${esc(p.party_bank_name)}</dd>` : ''}
            ${p.party_account_no ? `<dt>Their account</dt><dd>${esc(p.party_account_no)}</dd>` : ''}
            ${p.transfer_ref ? `<dt>Transfer ref</dt><dd>${esc(p.transfer_ref)}</dd>` : ''}
            ${p.from_bank_name ? `<dt>Paid from</dt><dd>${esc(p.from_bank_name)} ${esc(p.from_bank_account_no || '')}</dd>` : ''}
            ${p.cheque_no ? `<dt>Cheque no</dt><dd>${esc(p.cheque_no)}</dd>` : ''}
            ${p.cheque_date ? `<dt>Cheque date</dt><dd>${fmt.date(p.cheque_date)}</dd>` : ''}
            ${p.cheque_bank_name ? `<dt>Drawn on</dt><dd>${esc(p.cheque_bank_name)}</dd>` : ''}
            ${p.pdc_status ? `<dt>Cheque status</dt><dd>${badge(p.pdc_status)}</dd>` : ''}
            ${p.cleared_date ? `<dt>Cleared on</dt><dd>${fmt.date(p.cleared_date)}</dd>` : ''}
            ${p.bounce_reason ? `<dt>Bounce reason</dt><dd class="amount-danger">${esc(p.bounce_reason)}</dd>` : ''}
          </dl>
        </div>
        ${p.narration ? `<div style="margin-top:12px"><span class="mini-note">Narration</span><br>${esc(p.narration)}</div>` : ''}
        <h4 style="margin:18px 0 8px">Applied to</h4>
        ${C.table(p.allocations, [
          { label: 'Invoice no', mono: true, render: (a) => esc(a.invoice_no) },
          { label: 'Invoice date', render: (a) => fmt.date(a.invoice_date) },
          { label: 'Due', render: (a) => a.due_date ? fmt.date(a.due_date) : '-' },
          { label: 'Invoice total', num: true, render: (a) => fmt.money(a.total_amount) },
          { label: 'Applied', num: true, render: (a) => `<b>${fmt.money(a.amount)}</b>` }
        ], { empty: 'Not applied to any invoice - it sits on the supplier account as an advance' })}
        ${p.unallocated_amount > 0.005
          ? `<div class="alert warn" style="margin-top:12px">
               <b>${C.State.currency} ${fmt.money(p.unallocated_amount)}</b> of this payment is still on account.
             </div>` : ''}
        <div class="mini-note" style="margin-top:14px">
          Entered by ${esc(p.created_by_name || 'unknown')} on ${fmt.dateTime(p.created_at)}
        </div>`,
      footer: '<button class="btn" data-act="close">Close</button>',
      onMount: (m) => { m.querySelector('[data-act="close"]').onclick = () => Modal.close(); }
    });
  }

  // ================================================================ cheque register

  async function renderPdc(host) {
    host.innerHTML = `
      <div class="toolbar">
        <div class="field">
          <label>Cheque status</label>
          <select id="pdc-status">
            <option value="">Still to clear (issued or presented)</option>
            <option value="CLEARED">Cleared</option>
            <option value="BOUNCED">Bounced</option>
            <option value="CANCELLED">Cancelled</option>
            <option value="REPLACED">Replaced</option>
          </select>
        </div>
        <div class="field"><label>Cheque date from</label><input type="date" id="pdc-from"></div>
        <div class="field"><label>to</label><input type="date" id="pdc-to"></div>
        <div class="spacer"></div>
        <button class="btn" id="pdc-export">Export CSV</button>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
      <div id="pdc-body"><div class="loading">Loading the cheque register&hellip;</div></div>`;

    const load = async () => {
      const params = new URLSearchParams();
      if (C.State.companyId) params.set('company_id', C.State.companyId);
      const st = host.querySelector('#pdc-status').value;
      const from = host.querySelector('#pdc-from').value;
      const to = host.querySelector('#pdc-to').value;
      if (st) params.set('pdc_status', st);
      if (from) params.set('from', from);
      if (to) params.set('to', to);

      const box = host.querySelector('#pdc-body');
      box.innerHTML = '<div class="loading">Loading&hellip;</div>';
      const data = await API.get(`/api/reports/pdc-register?${params}`);

      box.innerHTML = `
        <div class="kpi-grid" style="margin-bottom:14px">
          <div class="kpi is-accent">
            <div class="label">Cheques listed</div>
            <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(data.total)}</div>
            <div class="foot">${fmt.int(data.count)} cheques</div>
          </div>
          ${data.by_month.slice(0, 3).map((m) => `
            <div class="kpi is-primary">
              <div class="label">${esc(fmt.month(m.month))}</div>
              <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(m.amount)}</div>
              <div class="foot">${fmt.int(m.count)} cheques fall due</div>
            </div>`).join('')}
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px" class="dash-split">
          <div class="card">
            <header><h3>Load by month</h3><span class="sub">plan the bank balance</span></header>
            <div class="body">${monthBars(data.by_month)}</div>
          </div>
          <div class="card">
            <header><h3>By our bank</h3></header>
            <div class="body tight">
              ${C.table(data.by_bank, [
                { label: 'Bank', render: (b) => `<b>${esc(b.bank)}</b>` },
                { label: 'Cheques', num: true, render: (b) => fmt.int(b.count) },
                { label: 'Amount', num: true, render: (b) => fmt.money(b.amount) }
              ], { empty: 'No cheques' })}
            </div>
          </div>
        </div>

        <div class="card">
          <header>
            <h3>Cheque register</h3>
            <span class="sub">rows in red are dated in the past and not yet cleared</span>
          </header>
          <div class="body tight" id="pdc-table"></div>
        </div>`;

      const table = box.querySelector('#pdc-table');
      table.innerHTML = C.table(data.rows, [
        { label: 'Cheque date', render: (r) => `<b class="nowrap ${r.cheque_date < C.today() && ['ISSUED', 'PRESENTED'].includes(r.pdc_status) ? 'amount-danger' : ''}">${fmt.date(r.cheque_date)}</b>` },
        { label: 'Cheque no', mono: true, render: (r) => esc(r.cheque_no) },
        { label: 'Supplier', render: (r) => `<b>${esc(r.supplier_name)}</b>` },
        { label: 'Company', render: (r) => esc(r.company_code) },
        { label: 'Drawn on', render: (r) => esc(r.cheque_bank_name || r.from_bank_name || '-') },
        { label: 'Reference', mono: true, render: (r) => esc(r.payment_no) },
        { label: 'Issued on', render: (r) => fmt.date(r.payment_date) },
        { label: 'Status', render: (r) => badge(r.pdc_status) },
        { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` },
        { label: '', render: (r) => C.can('payment.pdcstatus') && r.pdc_status !== 'CLEARED'
            ? `<button class="btn small primary" data-act="cheque" data-id="${r.id}">Update</button>`
            : `<button class="btn small" data-act="view" data-id="${r.id}">View</button>` }
      ], {
        empty: 'No cheques match this filter',
        emptyIcon: '&#128179;',
        rowClass: (r) => (r.cheque_date < C.today() && ['ISSUED', 'PRESENTED'].includes(r.pdc_status))
          ? 'row-overdue'
          : (r.cheque_date <= C.addDays(C.today(), 7) && ['ISSUED', 'PRESENTED'].includes(r.pdc_status) ? 'row-due-soon' : ''),
        footer: ['<b>Total</b>', '', '', '', '', '', '', '', fmt.money(data.total), '']
      });
      wirePaymentActions(table, data.rows, load);

      host.querySelector('#pdc-export').onclick = () =>
        C.downloadCsv(`pdc-register-${C.today()}.csv`, [
          { label: 'Cheque date', key: 'cheque_date' },
          { label: 'Cheque no', key: 'cheque_no' },
          { label: 'Supplier', key: 'supplier_name' },
          { label: 'Company', key: 'company_name' },
          { label: 'Drawn on', value: (r) => r.cheque_bank_name || r.from_bank_name || '' },
          { label: 'Payment ref', key: 'payment_no' },
          { label: 'Issued on', key: 'payment_date' },
          { label: 'Status', key: 'pdc_status' },
          { label: 'Amount', key: 'amount' }
        ], data.rows);
    };

    ['#pdc-status', '#pdc-from', '#pdc-to'].forEach((sel) => {
      host.querySelector(sel).onchange = load;
    });
    await load();
  }

  function monthBars(months) {
    if (!months.length) return '<div class="empty"><div class="big">&#128179;</div><div>No cheques outstanding</div></div>';
    const max = Math.max(1, ...months.map((m) => m.amount));
    return `<div class="bars">${months.map((m) => `
      <div class="bar-row">
        <div>${esc(fmt.month(m.month))}<br><span class="cnt">${fmt.int(m.count)} cheques</span></div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${Math.max(1, (m.amount / max) * 100)}%;background:#1c456c"></div>
        </div>
        <div class="amt">${fmt.money(m.amount)}</div>
      </div>`).join('')}</div>`;
  }

  // ================================================================ supplier statement

  async function renderSupplier(host, supplierId) {
    host.innerHTML = '<div class="loading">Loading the supplier statement&hellip;</div>';
    const qs = C.companyParam();
    const data = await API.get(`/api/reports/supplier-statement/${supplierId}${qs ? `?${qs}` : ''}`);
    const s = data.summary;

    host.innerHTML = `
      <div class="toolbar">
        <div>
          <h2 style="font-size:17px">${esc(data.supplier.name)}</h2>
          <div class="mini-note">${esc(data.supplier.code)}
            ${data.supplier.bank_name ? ` &middot; ${esc(data.supplier.bank_name)}` : ''}
            &middot; ${data.supplier.payment_terms_days} day terms from submission</div>
        </div>
        <div class="spacer"></div>
        <button class="btn" onclick="window.print()">Print</button>
        ${C.can('payment.create') ? '<button class="btn primary" id="pay-supplier">Record a payment</button>' : ''}
      </div>

      <div class="kpi-grid">
        <div class="kpi is-primary">
          <div class="label">Outstanding</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(s.outstanding)}</div>
          <div class="foot">Invoiced ${fmt.money(s.invoiced)}, settled ${fmt.money(s.settled)}</div>
        </div>
        <div class="kpi is-accent">
          <div class="label">Cheques with them</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(s.pdc_pending)}</div>
          <div class="foot">Issued, waiting to clear</div>
        </div>
        <div class="kpi is-primary">
          <div class="label">Still to arrange</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(s.net_payable)}</div>
          <div class="foot">Outstanding less the cheques</div>
        </div>
        <div class="kpi is-danger">
          <div class="label">Overdue</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(s.overdue)}</div>
          <div class="foot">${fmt.int(s.overdue_count)} invoices</div>
        </div>
        <div class="kpi is-warn">
          <div class="label">Advance on account</div>
          <div class="value"><span class="cur">${esc(C.State.currency)}</span>${fmt.compact(s.unallocated_advance)}</div>
          <div class="foot">Paid, not yet applied</div>
        </div>
      </div>

      <div class="card">
        <header><h3>Invoices</h3></header>
        <div class="body tight">
          ${C.table(data.invoices, [
            { label: 'Invoice no', mono: true, render: (r) => esc(r.invoice_no) },
            { label: 'Company', render: (r) => esc(r.company_code) },
            { label: 'Invoice date', render: (r) => fmt.date(r.invoice_date) },
            { label: 'Submitted', render: (r) => r.submitted_date ? fmt.date(r.submitted_date) : '<span class="badge amber">No</span>' },
            { label: 'Due', render: (r) => r.due_date ? `<span class="${r.is_overdue ? 'amount-danger strong' : ''}">${fmt.date(r.due_date)}</span>` : '-' },
            { label: 'Total', num: true, render: (r) => fmt.money(r.total_amount) },
            { label: 'Paid', num: true, render: (r) => fmt.money(r.paid_amount) },
            { label: 'PDC', num: true, render: (r) => r.pdc_amount ? fmt.money(r.pdc_amount) : '-' },
            { label: 'Outstanding', num: true, render: (r) => `<b>${fmt.money(r.outstanding)}</b>` },
            { label: 'Status', render: (r) => badge(r.status) }
          ], { rowClass: C.invoiceRowClass, empty: 'No invoices recorded for this supplier' })}
        </div>
      </div>

      <div class="card">
        <header><h3>Payments</h3></header>
        <div class="body tight">
          ${C.table(data.payments, [
            { label: 'Date', render: (r) => fmt.date(r.payment_date) },
            { label: 'Reference', mono: true, render: (r) => esc(r.payment_no) },
            { label: 'Mode', render: (r) => modeCell(r) },
            { label: 'Type', render: (r) => r.payment_type === 'ADVANCE' ? '<span class="badge purple">Advance</span>' : '<span class="badge grey">Invoice</span>' },
            { label: 'Cheque status', render: (r) => r.pdc_status ? badge(r.pdc_status) : '-' },
            { label: 'Amount', num: true, render: (r) => `<b>${fmt.money(r.amount)}</b>` },
            { label: 'Unapplied', num: true, render: (r) => r.unallocated_amount > 0.005 ? fmt.money(r.unallocated_amount) : '-' }
          ], { empty: 'No payments recorded for this supplier' })}
        </div>
      </div>`;

    const btn = host.querySelector('#pay-supplier');
    if (btn) {
      btn.onclick = () => paymentForm({ supplier_id: Number(supplierId) }, () => renderSupplier(host, supplierId));
    }
  }

  // ================================================================ shared bits

  function optionsHtml(options, value) {
    return options.map((o) =>
      `<option value="${esc(o.value)}" ${String(o.value) === String(value || '') ? 'selected' : ''}>${esc(o.label)}</option>`
    ).join('');
  }

  /** Search boxes settle before firing; dropdowns fire at once. */
  function bindFilters(host, target, onChange) {
    let timer;
    host.querySelectorAll('[data-filter]').forEach((el) => {
      const key = el.dataset.filter;
      const fire = () => { target[key] = el.value; onChange(); };
      if (el.type === 'search' || el.type === 'text') {
        el.oninput = () => { clearTimeout(timer); timer = setTimeout(fire, 320); };
      } else {
        el.onchange = fire;
      }
    });
  }

  window.Payables = {
    renderInvoices, renderPayments, renderPdc, renderSupplier,
    openPaymentForInvoice, paymentForm, invoiceForm, optionsHtml, bindFilters
  };
})();
