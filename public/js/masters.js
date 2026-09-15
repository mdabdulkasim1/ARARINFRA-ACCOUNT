/* Master data: suppliers, customers, employees, companies, our bank accounts,
   categories and the people who use the system. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, badge, API, Modal, toast } = C;
  const P = () => window.Payables;

  const TABS = [
    { key: 'suppliers', label: 'Suppliers' },
    { key: 'customers', label: 'Customers' },
    { key: 'employees', label: 'Employees' },
    { key: 'banks', label: 'Our bank accounts' },
    { key: 'companies', label: 'Companies', perm: 'company.view' },
    { key: 'categories', label: 'Categories' },
    { key: 'users', label: 'Users', perm: 'user.view' }
  ];

  let tab = 'suppliers';

  async function render(host, query) {
    if (query && query.tab) tab = query.tab;
    const visible = TABS.filter((t) => !t.perm || C.can(t.perm));
    if (!visible.some((t) => t.key === tab)) tab = visible[0].key;

    host.innerHTML = `
      <div class="tabs" id="master-tabs">
        ${visible.map((t) => `<button data-tab="${t.key}" class="${tab === t.key ? 'active' : ''}">${t.label}</button>`).join('')}
      </div>
      <div id="master-body"><div class="loading">Loading&hellip;</div></div>`;

    host.querySelectorAll('#master-tabs button').forEach((b) => {
      b.onclick = () => {
        tab = b.dataset.tab;
        host.querySelectorAll('#master-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        draw(host);
      };
    });
    await draw(host);
  }

  function draw(host) {
    const body = host.querySelector('#master-body');
    const map = {
      suppliers: drawSuppliers, customers: drawCustomers, employees: drawEmployees,
      banks: drawBanks, companies: drawCompanies, categories: drawCategories, users: drawUsers
    };
    return map[tab](body, () => draw(host));
  }

  function header(title, hint, addLabel, canAdd) {
    return `
      <div class="toolbar">
        <div><h2 style="font-size:16px">${esc(title)}</h2><div class="mini-note">${esc(hint)}</div></div>
        <div class="spacer"></div>
        ${canAdd ? `<button class="btn primary" id="add-btn">+ ${esc(addLabel)}</button>` : ''}
      </div>`;
  }

  // ---------------------------------------------------------------- suppliers

  async function drawSuppliers(body, refresh) {
    const rows = await API.get('/api/suppliers?active_only=0');
    body.innerHTML = header(
      'Suppliers', 'Their bank details and agreed credit period feed the payment screens.',
      'New supplier', C.can('master.edit')
    ) + `<div class="card"><div class="body tight" id="tbl"></div></div>`;

    body.querySelector('#tbl').innerHTML = C.table(rows, [
      { label: 'Code', mono: true, render: (r) => esc(r.code) },
      { label: 'Supplier', render: (r) => `<a href="#/supplier/${r.id}"><b>${esc(r.name)}</b></a>` },
      { label: 'Contact', render: (r) => `${esc(r.contact_person || '-')}<br><span class="mini-note">${esc(r.phone || '')}</span>` },
      { label: 'Bank', render: (r) => `${esc(r.bank_name || '-')}<br><span class="mini-note">${esc(r.iban || r.bank_account_no || '')}</span>` },
      { label: 'Terms', num: true, render: (r) => `<b>${r.payment_terms_days}</b> days` },
      { label: 'TRN', render: (r) => esc(r.trn || '-') },
      { label: 'Active', render: (r) => r.active ? '<span class="badge green">Yes</span>' : '<span class="badge grey">No</span>' },
      { label: '', render: (r) => `<div class="btn-row">
          ${C.can('master.edit') ? `<button class="btn small" data-act="edit" data-id="${r.id}">Edit</button>` : ''}
          ${C.can('supplier.merge') && r.active ? `<button class="btn small" data-act="merge" data-id="${r.id}">Merge</button>` : ''}
        </div>` }
    ], { empty: 'No suppliers yet', emptyIcon: '&#127970;', rowClass: (r) => r.active ? '' : 'row-muted' });

    wireAdd(body, () => supplierForm(null, refresh));
    body.querySelectorAll('#tbl [data-act]').forEach((b) => {
      const row = rows.find((r) => r.id === Number(b.dataset.id));
      b.onclick = () => b.dataset.act === 'merge'
        ? mergeForm(row, rows, refresh)
        : supplierForm(row, refresh);
    });
  }

  /** Fold duplicate or internal supplier accounts into one. */
  function mergeForm(row, allRows, after) {
    const others = allRows.filter((r) => r.id !== row.id && r.active);
    const modal = Modal.open({
      title: `Fold ${row.name} into another supplier`,
      subtitle: 'Invoices, payments and loans all move across',
      body: `
        <div class="alert warn">
          Everything recorded against <b>${esc(row.name)}</b> moves to the supplier you
          choose, and this account is switched off. Balances follow the invoices, so
          nothing is lost - but it is not undone with a button, so check the name first.
        </div>
        ${C.formFields([
          { name: 'mode', label: 'Move it into', type: 'select', value: 'existing',
            options: [
              { value: 'existing', label: 'A supplier that already exists' },
              { value: 'new', label: 'A new supplier I name here' }
            ] }
        ])}
        <div id="merge-existing">
          ${C.formFields([
            { name: 'into_supplier_id', label: 'Supplier', type: 'select',
              options: [{ value: '', label: 'Choose a supplier' }]
                .concat(others.map((o) => ({ value: o.id, label: `${o.name} (${o.code})` }))) }
          ])}
        </div>
        <div id="merge-new" hidden>
          ${C.formFields([
            { name: 'into_name', label: 'New supplier name',
              hint: 'If a supplier with this name already exists, that one is used' },
            { type: 'terms', name: 'payment_terms_days', label: 'Credit period',
              value: row.payment_terms_days }
          ])}
        </div>
        <div class="field">
          <label>Also fold in these accounts (optional)</label>
          <div style="max-height:190px;overflow:auto;border:1px solid var(--border);border-radius:5px;padding:9px">
            ${others.map((o) => `
              <label style="display:block;font-weight:400;font-size:13px;padding:2px 0">
                <input type="checkbox" class="also-merge" value="${o.id}" style="width:auto"> ${esc(o.name)}
              </label>`).join('') || '<span class="mini-note">No other active suppliers</span>'}
          </div>
        </div>`,
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn danger" data-act="save">Fold together</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const mode = modal.querySelector('[name="mode"]');
    const sync = () => {
      modal.querySelector('#merge-existing').hidden = mode.value !== 'existing';
      modal.querySelector('#merge-new').hidden = mode.value === 'existing';
    };
    mode.onchange = sync;
    sync();

    C.wireSave(modal, async (b) => {
      const extra = [...modal.querySelectorAll('.also-merge:checked')].map((c) => Number(c.value));
      const body = { from_supplier_ids: [row.id].concat(extra) };
      if (b.mode === 'existing') {
        if (!b.into_supplier_id) throw new Error('Choose the supplier to move everything into');
        body.into_supplier_id = Number(b.into_supplier_id);
      } else {
        if (!b.into_name) throw new Error('Name the supplier everything should sit under');
        body.into_name = b.into_name;
        body.payment_terms_days = b.payment_terms_days;
      }
      const res = await API.post('/api/suppliers/merge', body);
      await window.App.reloadLookups();
      toast(`Moved ${res.moved.invoices} invoice(s) into ${res.into.name}`, 'ok');
    }, { after });
  }

  function supplierForm(row, after) {
    const modal = Modal.open({
      title: row ? `Edit ${row.name}` : 'New supplier',
      size: 'wide',
      body: C.formFields([
        { type: 'group', className: 'grid-2', fields: [
          { name: 'name', label: 'Supplier name', required: true, value: row ? row.name : '' },
          { name: 'code', label: 'Code', value: row ? row.code : '', hint: 'Leave blank and one is generated' }
        ] },
        { type: 'group', className: 'grid-3', fields: [
          { name: 'contact_person', label: 'Contact person', value: row ? row.contact_person : '' },
          { name: 'phone', label: 'Phone', value: row ? row.phone : '' },
          { name: 'email', label: 'Email', type: 'email', value: row ? row.email : '' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'trn', label: 'TRN / tax number', value: row ? row.trn : '' },
          { name: 'payment_terms_days', label: 'Agreed credit period', type: 'terms',
            required: true, value: row ? row.payment_terms_days : C.State.defaultTerms,
            hint: 'Counted from the day we submit their invoice' }
        ] },
        { type: 'group', className: 'grid-3', fields: [
          { name: 'bank_name', label: 'Their bank name', value: row ? row.bank_name : '',
            hint: 'Used as the default for transfers' },
          { name: 'bank_account_no', label: 'Account number', value: row ? row.bank_account_no : '' },
          { name: 'iban', label: 'IBAN', value: row ? row.iban : '' }
        ] },
        { name: 'address', label: 'Address', type: 'textarea', value: row ? row.address : '' },
        { name: 'notes', label: 'Notes', type: 'textarea', value: row ? row.notes : '' },
        { name: 'active', label: 'Status', type: 'select',
          options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
          value: row ? String(!!row.active) : 'true' }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      if (row) await API.put(`/api/suppliers/${row.id}`, b);
      else await API.post('/api/suppliers', b);
      await window.App.reloadLookups();
    }, { success: 'Supplier saved', after });
  }

  // ---------------------------------------------------------------- customers

  async function drawCustomers(body, refresh) {
    const rows = await API.get('/api/customers?active_only=0');
    body.innerHTML = header('Customers', 'Who we invoice on the income side.', 'New customer', C.can('master.edit'))
      + '<div class="card"><div class="body tight" id="tbl"></div></div>';

    body.querySelector('#tbl').innerHTML = C.table(rows, [
      { label: 'Code', mono: true, render: (r) => esc(r.code) },
      { label: 'Customer', render: (r) => `<b>${esc(r.name)}</b>` },
      { label: 'Contact', render: (r) => `${esc(r.contact_person || '-')}<br><span class="mini-note">${esc(r.phone || '')}</span>` },
      { label: 'Terms', num: true, render: (r) => `${r.payment_terms_days} days` },
      { label: 'TRN', render: (r) => esc(r.trn || '-') },
      { label: 'Active', render: (r) => r.active ? '<span class="badge green">Yes</span>' : '<span class="badge grey">No</span>' },
      { label: '', render: (r) => C.can('master.edit') ? `<button class="btn small" data-id="${r.id}">Edit</button>` : '' }
    ], { empty: 'No customers yet', emptyIcon: '&#127970;', rowClass: (r) => r.active ? '' : 'row-muted' });

    wireAdd(body, () => customerForm(null, refresh));
    body.querySelectorAll('#tbl [data-id]').forEach((b) => {
      b.onclick = () => customerForm(rows.find((r) => r.id === Number(b.dataset.id)), refresh);
    });
  }

  function customerForm(row, after) {
    const modal = Modal.open({
      title: row ? `Edit ${row.name}` : 'New customer',
      body: C.formFields([
        { type: 'group', className: 'grid-2', fields: [
          { name: 'name', label: 'Customer name', required: true, value: row ? row.name : '' },
          { name: 'code', label: 'Code', value: row ? row.code : '' }
        ] },
        { type: 'group', className: 'grid-3', fields: [
          { name: 'contact_person', label: 'Contact person', value: row ? row.contact_person : '' },
          { name: 'phone', label: 'Phone', value: row ? row.phone : '' },
          { name: 'email', label: 'Email', type: 'email', value: row ? row.email : '' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'trn', label: 'TRN', value: row ? row.trn : '' },
          { name: 'payment_terms_days', label: 'Credit period', type: 'terms',
            value: row ? row.payment_terms_days : 60 }
        ] },
        { name: 'address', label: 'Address', type: 'textarea', value: row ? row.address : '' },
        { name: 'active', label: 'Status', type: 'select',
          options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
          value: row ? String(!!row.active) : 'true' }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      if (row) await API.put(`/api/customers/${row.id}`, b);
      else await API.post('/api/customers', b);
      await window.App.reloadLookups();
    }, { success: 'Customer saved', after });
  }

  // ---------------------------------------------------------------- employees

  async function drawEmployees(body, refresh) {
    const rows = await API.get('/api/employees?active_only=0');
    body.innerHTML = header(
      'Employees', 'Petty cash requests are raised in the name of an employee from this list.',
      'New employee', C.can('master.edit')
    ) + '<div class="card"><div class="body tight" id="tbl"></div></div>';

    body.querySelector('#tbl').innerHTML = C.table(rows, [
      { label: 'Code', mono: true, render: (r) => esc(r.code) },
      { label: 'Name', render: (r) => `<b>${esc(r.name)}</b>` },
      { label: 'Designation', render: (r) => esc(r.designation || '-') },
      { label: 'Department', render: (r) => esc(r.department || '-') },
      { label: 'Company', render: (r) => esc(r.company_name || 'Group') },
      { label: 'Phone', render: (r) => esc(r.phone || '-') },
      { label: 'Active', render: (r) => r.active ? '<span class="badge green">Yes</span>' : '<span class="badge grey">No</span>' },
      { label: '', render: (r) => C.can('master.edit') ? `<button class="btn small" data-id="${r.id}">Edit</button>` : '' }
    ], { empty: 'No employees yet', emptyIcon: '&#128100;', rowClass: (r) => r.active ? '' : 'row-muted' });

    wireAdd(body, () => employeeForm(null, refresh));
    body.querySelectorAll('#tbl [data-id]').forEach((b) => {
      b.onclick = () => employeeForm(rows.find((r) => r.id === Number(b.dataset.id)), refresh);
    });
  }

  function employeeForm(row, after) {
    const modal = Modal.open({
      title: row ? `Edit ${row.name}` : 'New employee',
      body: C.formFields([
        { type: 'group', className: 'grid-2', fields: [
          { name: 'name', label: 'Full name', required: true, value: row ? row.name : '' },
          { name: 'code', label: 'Employee code', value: row ? row.code : '' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'designation', label: 'Designation', value: row ? row.designation : '' },
          { name: 'department', label: 'Department', value: row ? row.department : '' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'company_id', label: 'Company', type: 'select',
            options: [{ value: '', label: 'Group / not set' }].concat(C.opt.companies(false)),
            value: row ? row.company_id : '' },
          { name: 'phone', label: 'Phone', value: row ? row.phone : '' }
        ] },
        { name: 'active', label: 'Status', type: 'select',
          options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
          value: row ? String(!!row.active) : 'true' }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      if (row) await API.put(`/api/employees/${row.id}`, b);
      else await API.post('/api/employees', b);
      await window.App.reloadLookups();
    }, { success: 'Employee saved', after });
  }

  // ---------------------------------------------------------------- our banks

  async function drawBanks(body, refresh) {
    const rows = await API.get('/api/bank-accounts?active_only=0');
    body.innerHTML = header(
      'Our bank accounts', 'The accounts money goes out from, and the banks our cheques are drawn on.',
      'New account', C.can('master.edit')
    ) + '<div class="card"><div class="body tight" id="tbl"></div></div>';

    body.querySelector('#tbl').innerHTML = C.table(rows, [
      { label: 'Company', render: (r) => esc(r.company_name) },
      { label: 'Bank', render: (r) => `<b>${esc(r.bank_name)}</b>` },
      { label: 'Account name', render: (r) => esc(r.account_name || '-') },
      { label: 'Account no', mono: true, render: (r) => esc(r.account_no || '-') },
      { label: 'IBAN', mono: true, render: (r) => esc(r.iban || '-') },
      { label: 'Active', render: (r) => r.active ? '<span class="badge green">Yes</span>' : '<span class="badge grey">No</span>' },
      { label: '', render: (r) => C.can('master.edit') ? `<button class="btn small" data-id="${r.id}">Edit</button>` : '' }
    ], { empty: 'No bank accounts recorded', emptyIcon: '&#127974;', rowClass: (r) => r.active ? '' : 'row-muted' });

    wireAdd(body, () => bankForm(null, refresh));
    body.querySelectorAll('#tbl [data-id]').forEach((b) => {
      b.onclick = () => bankForm(rows.find((r) => r.id === Number(b.dataset.id)), refresh);
    });
  }

  function bankForm(row, after) {
    const modal = Modal.open({
      title: row ? `Edit ${row.bank_name}` : 'New bank account',
      body: C.formFields([
        { name: 'company_id', label: 'Company', type: 'select', required: true,
          options: C.opt.companies(false), value: row ? row.company_id : (C.State.companyId || ''),
          attrs: row ? { disabled: 'disabled' } : {} },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'bank_name', label: 'Bank name', required: true, value: row ? row.bank_name : '' },
          { name: 'account_name', label: 'Account name', value: row ? row.account_name : '' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'account_no', label: 'Account number', value: row ? row.account_no : '' },
          { name: 'iban', label: 'IBAN', value: row ? row.iban : '' }
        ] },
        { name: 'active', label: 'Status', type: 'select',
          options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
          value: row ? String(!!row.active) : 'true' }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      if (row) await API.put(`/api/bank-accounts/${row.id}`, b);
      else await API.post('/api/bank-accounts', b);
      await window.App.reloadLookups();
    }, { success: 'Bank account saved', after });
  }

  // ---------------------------------------------------------------- companies

  async function drawCompanies(body, refresh) {
    const rows = await API.get('/api/companies?all=1');
    body.innerHTML = header(
      'Companies', 'The code appears in every payment and petty cash number, so keep it short.',
      'New company', C.can('company.edit')
    ) + '<div class="card"><div class="body tight" id="tbl"></div></div>';

    body.querySelector('#tbl').innerHTML = C.table(rows, [
      { label: 'Code', mono: true, render: (r) => `<b>${esc(r.code)}</b>` },
      { label: 'Name', render: (r) => `<b>${esc(r.name)}</b>` },
      { label: 'Legal name', render: (r) => esc(r.legal_name || '-') },
      { label: 'TRN', render: (r) => esc(r.trn || '-') },
      { label: 'Currency', render: (r) => esc(r.currency) },
      { label: 'Active', render: (r) => r.active ? '<span class="badge green">Yes</span>' : '<span class="badge grey">No</span>' },
      { label: '', render: (r) => C.can('company.edit')
          ? `<button class="btn small" data-id="${r.id}">Edit</button>` +
            (rows.length > 1 ? ` <button class="btn small danger" data-del="${r.id}">Remove</button>` : '')
          : '' }
    ], { empty: 'No companies yet', emptyIcon: '&#127970;', rowClass: (r) => r.active ? '' : 'row-muted' });

    wireAdd(body, () => companyForm(null, refresh));
    body.querySelectorAll('#tbl [data-id]').forEach((b) => {
      b.onclick = () => companyForm(rows.find((r) => r.id === Number(b.dataset.id)), refresh);
    });
    body.querySelectorAll('#tbl [data-del]').forEach((b) => {
      b.onclick = async () => {
        const row = rows.find((r) => r.id === Number(b.dataset.del));
        const ok = await Modal.confirm({
          title: `Remove ${row.name}?`,
          message: 'This only works while the company is empty. If anything has been ' +
                   'entered against it, nothing is removed and you will be told what is ' +
                   'there - set it to Inactive instead.',
          confirmText: 'Remove', danger: true
        });
        if (!ok) return;
        await API.del(`/api/companies/${row.id}`);
        await window.App.reloadLookups();
        toast(`${row.name} removed`, 'ok');
        refresh();
      };
    });
  }

  function companyForm(row, after) {
    const modal = Modal.open({
      title: row ? `Edit ${row.name}` : 'New company',
      body: C.formFields([
        { type: 'group', className: 'grid-2', fields: [
          { name: 'name', label: 'Trading name', required: true, value: row ? row.name : '' },
          { name: 'code', label: 'Short code', required: true, value: row ? row.code : '',
            hint: 'Three or four letters, used in document numbers' }
        ] },
        { type: 'group', className: 'grid-2', fields: [
          { name: 'legal_name', label: 'Legal name', value: row ? row.legal_name : '' },
          { name: 'trn', label: 'TRN', value: row ? row.trn : '' }
        ] },
        { type: 'group', className: 'grid-3', fields: [
          { name: 'currency', label: 'Currency', value: row ? row.currency : C.State.currency },
          { name: 'phone', label: 'Phone', value: row ? row.phone : '' },
          { name: 'email', label: 'Email', type: 'email', value: row ? row.email : '' }
        ] },
        { name: 'address', label: 'Address', type: 'textarea', value: row ? row.address : '' },
        { name: 'active', label: 'Status', type: 'select',
          options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive' }],
          value: row ? String(!!row.active) : 'true' }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      if (row) await API.put(`/api/companies/${row.id}`, b);
      else await API.post('/api/companies', b);
      await window.App.reloadLookups();
    }, { success: 'Company saved', after });
  }

  // ---------------------------------------------------------------- categories

  async function drawCategories(body, refresh) {
    const rows = await API.get('/api/categories');
    const groups = { EXPENSE: 'Supplier expenses', PETTY: 'Petty cash', INCOME: 'Income' };
    body.innerHTML = header('Categories', 'How spending and income are grouped in the reports.', 'New category', C.can('master.edit'))
      + Object.entries(groups).map(([kind, label]) => `
        <div class="card">
          <header><h3>${esc(label)}</h3></header>
          <div class="body">
            <div class="btn-row">
              ${rows.filter((r) => r.kind === kind).map((r) => `
                <span class="badge grey" style="padding:5px 9px;font-size:12px">
                  ${esc(r.name)}
                  ${C.can('master.edit') ? `<a href="#" data-del="${r.id}" style="margin-left:6px;color:var(--danger)" title="Remove">&times;</a>` : ''}
                </span>`).join('') || '<span class="mini-note">None yet</span>'}
            </div>
          </div>
        </div>`).join('');

    wireAdd(body, () => categoryForm(refresh));
    body.querySelectorAll('[data-del]').forEach((a) => {
      a.onclick = async (e) => {
        e.preventDefault();
        const ok = await Modal.confirm({
          title: 'Remove this category?',
          message: 'Existing entries keep it, but it will not be offered for new ones.',
          confirmText: 'Remove', danger: true
        });
        if (!ok) return;
        await API.del(`/api/categories/${a.dataset.del}`);
        await window.App.reloadLookups();
        toast('Category removed', 'ok');
        refresh();
      };
    });
  }

  function categoryForm(after) {
    const modal = Modal.open({
      title: 'New category',
      size: 'narrow',
      body: C.formFields([
        { name: 'name', label: 'Name', required: true },
        { name: 'kind', label: 'Used for', type: 'select', required: true,
          options: [
            { value: 'EXPENSE', label: 'Supplier expenses' },
            { value: 'PETTY', label: 'Petty cash' },
            { value: 'INCOME', label: 'Income' }
          ] }
      ]),
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();
    C.wireSave(modal, async (b) => {
      await API.post('/api/categories', b);
      await window.App.reloadLookups();
    }, { success: 'Category added', after });
  }

  // ---------------------------------------------------------------- users

  async function drawUsers(body, refresh) {
    const rows = await API.get('/api/users');
    body.innerHTML = header(
      'Users', 'Owner approves petty cash. Finance manager verifies and runs the cheques. Accountants do the entry.',
      'New user', C.can('user.edit')
    ) + '<div class="card"><div class="body tight" id="tbl"></div></div>';

    body.querySelector('#tbl').innerHTML = C.table(rows, [
      { label: 'Name', render: (r) => `<b>${esc(r.name)}</b>` },
      { label: 'Username', mono: true, render: (r) => esc(r.username || '-') },
      { label: 'Email', render: (r) => esc(r.email) },
      { label: 'Role', render: (r) => badge(r.role_label, r.role === 'OWNER' ? 'purple' : (r.role === 'FINANCE_MANAGER' ? 'blue' : 'grey')) },
      { label: 'Companies', render: (r) => r.companies.length === C.State.companies.length
          ? '<span class="mini-note">All companies</span>'
          : `<span class="mini-note">${esc(r.companies.map((c) => c.code).join(', ') || 'None')}</span>` },
      { label: 'Last signed in', render: (r) => r.last_login_at ? fmt.dateTime(r.last_login_at) : '<span class="mini-note">never</span>' },
      { label: 'Active', render: (r) => r.active ? '<span class="badge green">Yes</span>' : '<span class="badge grey">No</span>' },
      { label: '', render: (r) => C.can('user.edit') ? `<button class="btn small" data-id="${r.id}">Edit</button>` : '' }
    ], { empty: 'No users', emptyIcon: '&#128100;', rowClass: (r) => r.active ? '' : 'row-muted' });

    wireAdd(body, () => userForm(null, refresh));
    body.querySelectorAll('#tbl [data-id]').forEach((b) => {
      b.onclick = () => userForm(rows.find((r) => r.id === Number(b.dataset.id)), refresh);
    });
  }

  function userForm(row, after) {
    const companyIds = row ? row.companies.map((c) => c.id) : C.State.companies.map((c) => c.id);
    const modal = Modal.open({
      title: row ? `Edit ${row.name}` : 'New user',
      body: `
        ${C.formFields([
          { type: 'group', className: 'grid-3', fields: [
            { name: 'name', label: 'Full name', required: true, value: row ? row.name : '' },
            { name: 'username', label: 'Username', value: row ? row.username : '',
              hint: 'What they type to sign in' },
            { name: 'email', label: 'Email', type: 'email', required: true, value: row ? row.email : '' }
          ] },
          { type: 'group', className: 'grid-2', fields: [
            { name: 'role', label: 'Role', type: 'select', required: true, value: row ? row.role : 'ACCOUNTANT',
              options: [
                { value: 'OWNER', label: 'Owner - approves petty cash, manages everything' },
                { value: 'FINANCE_MANAGER', label: 'Finance manager - verifies, runs cheques, can delete' },
                { value: 'ACCOUNTANT', label: 'Accountant - enters invoices, payments and requests' }
              ] },
            { name: 'phone', label: 'Phone', value: row ? row.phone : '' }
          ] },
          { name: 'password', label: row ? 'New password' : 'Starting password', type: 'password',
            required: !row,
            hint: row ? 'Leave blank to keep the current password' : 'At least 8 characters. They will be asked to change it.' }
        ])}
        <div class="field">
          <label>Companies this user can work in</label>
          <div class="btn-row" style="gap:12px;margin-top:4px">
            ${C.State.companies.map((c) => `
              <label style="display:flex;align-items:center;gap:6px;font-weight:400;font-size:13px">
                <input type="checkbox" class="co-check" value="${c.id}" ${companyIds.includes(c.id) ? 'checked' : ''}
                       style="width:auto"> ${esc(c.name)}
              </label>`).join('')}
          </div>
          <div class="hint">Owners and finance managers always see every company, whatever is ticked here.</div>
        </div>
        ${C.formFields([
          { name: 'active', label: 'Status', type: 'select',
            options: [{ value: 'true', label: 'Active' }, { value: 'false', label: 'Inactive - cannot sign in' }],
            value: row ? String(!!row.active) : 'true' }
        ])}`,
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn primary" data-act="save">Save</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    C.wireSave(modal, async (b) => {
      b.company_ids = [...modal.querySelectorAll('.co-check:checked')].map((c) => Number(c.value));
      if (row && !b.password) delete b.password;
      if (row) await API.put(`/api/users/${row.id}`, b);
      else await API.post('/api/users', b);
    }, { success: 'User saved', after });
  }

  function wireAdd(body, fn) {
    const btn = body.querySelector('#add-btn');
    if (btn) btn.onclick = fn;
  }

  window.Masters = { render };
})();
