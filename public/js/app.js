/* Sign in, the sidebar, and hash routing between the screens. */
(function () {
  'use strict';

  const C = window.Core;
  const { esc, fmt, API, Modal, toast } = C;

  const ROUTES = {
    '': { title: 'Dashboard', render: (h) => window.Dashboard.render(h) },
    'dashboard': { title: 'Dashboard', render: (h) => window.Dashboard.render(h) },
    'payables': { title: 'Supplier invoices', perm: 'invoice.view', render: (h, q) => window.Payables.renderInvoices(h, q) },
    'payments': { title: 'Payments', perm: 'payment.view', render: (h, q) => window.Payables.renderPayments(h, q) },
    'pdc': { title: 'Cheque register', perm: 'payment.view', render: (h) => window.Payables.renderPdc(h) },
    'petty': { title: 'Petty cash', perm: 'petty.view', render: (h, q) => window.Petty.render(h, q) },
    'monthly': { title: 'What has to be paid', perm: 'report.view', render: (h, q) => window.Monthly.renderMonthly(h, q) },
    'facilities': { title: 'Bank facilities', perm: 'facility.view', render: (h, q) => window.Monthly.renderFacilities(h, q) },
    'income': { title: 'Income', perm: 'sales.view', render: (h, q) => window.Income.render(h, q) },
    'ageing': { title: 'Supplier ageing', perm: 'report.view', render: (h) => window.Reports.renderAgeing(h) },
    'group': { title: 'Group summary', perm: 'report.group', render: (h) => window.Reports.renderGroup(h) },
    'cash-out': { title: 'Where the money went', perm: 'report.view', render: (h) => window.Reports.renderCashOut(h) },
    'petty-report': { title: 'Petty cash by employee', perm: 'report.view', render: (h) => window.Reports.renderPettySummary(h) },
    'audit': { title: 'Audit trail', perm: 'audit.view', render: (h) => window.Reports.renderAudit(h) },
    'masters': { title: 'Master data', perm: 'master.view', render: (h, q) => window.Masters.render(h, q) },
    'supplier': { title: 'Supplier statement', perm: 'report.view', render: (h, q, id) => window.Payables.renderSupplier(h, id) }
  };

  const NAV = [
    { group: 'Overview', items: [
      { href: '#/dashboard', icon: '&#9632;', label: 'Dashboard', key: 'dashboard' }
    ] },
    { group: 'Money out', items: [
      { href: '#/monthly', icon: '&#128197;', label: 'What to pay', key: 'monthly', perm: 'report.view' },
      { href: '#/payables', icon: '&#128195;', label: 'Supplier invoices', key: 'payables', perm: 'invoice.view' },
      { href: '#/payments', icon: '&#128181;', label: 'Payments', key: 'payments', perm: 'payment.view' },
      { href: '#/pdc', icon: '&#128179;', label: 'Cheque register', key: 'pdc', perm: 'payment.view' },
      { href: '#/petty', icon: '&#128176;', label: 'Petty cash', key: 'petty', perm: 'petty.view', badge: 'petty' },
      { href: '#/facilities', icon: '&#128663;', label: 'Loans & LC', key: 'facilities', perm: 'facility.view' }
    ] },
    { group: 'Money in', items: [
      { href: '#/income', icon: '&#128200;', label: 'Income', key: 'income', perm: 'sales.view' }
    ] },
    { group: 'Reports', items: [
      { href: '#/ageing', icon: '&#9202;', label: 'Supplier ageing', key: 'ageing', perm: 'report.view' },
      { href: '#/group', icon: '&#127970;', label: 'Group summary', key: 'group', perm: 'report.group' },
      { href: '#/cash-out', icon: '&#8595;', label: 'Where money went', key: 'cash-out', perm: 'report.view' },
      { href: '#/petty-report', icon: '&#128100;', label: 'Petty cash by staff', key: 'petty-report', perm: 'report.view' },
      { href: '#/audit', icon: '&#128220;', label: 'Audit trail', key: 'audit', perm: 'audit.view' }
    ] },
    { group: 'Setup', items: [
      { href: '#/masters', icon: '&#9881;', label: 'Master data', key: 'masters', perm: 'master.view' }
    ] }
  ];

  // ---------------------------------------------------------------- sign in

  function showLogin(message) {
    document.getElementById('app').hidden = true;
    const login = document.getElementById('login');
    login.hidden = false;
    const err = document.getElementById('login-error');
    if (message) { err.textContent = message; err.hidden = false; } else { err.hidden = true; }
  }

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = document.getElementById('login-btn');
    const err = document.getElementById('login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> Signing in';
    try {
      await API.post('/api/auth/login', {
        email: document.getElementById('login-email').value,
        password: document.getElementById('login-password').value
      });
      document.getElementById('login-password').value = '';
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  };

  function signedOut() {
    C.State.me = null;
    Modal.closeAll();
    showLogin('Your session has ended. Please sign in again.');
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    let me;
    try {
      me = await API.get('/api/auth/me');
    } catch {
      showLogin();
      return;
    }

    C.State.me = me.user;
    C.State.permissions = me.permissions;
    C.State.companies = me.companies;
    C.State.groupName = me.group_name;
    C.State.currency = me.default_currency;
    C.State.defaultTerms = me.default_terms;

    const saved = localStorage.getItem('arar.company');
    C.State.companyId = saved && me.companies.some((c) => String(c.id) === saved) ? saved : '';

    await reloadLookups();

    document.getElementById('login').hidden = true;
    document.getElementById('app').hidden = false;

    document.getElementById('user-name').textContent = me.user.name;
    document.getElementById('user-role').textContent = me.user.role_label;
    document.getElementById('user-initials').textContent = fmt.initials(me.user.name);

    const sel = document.getElementById('company-select');
    sel.innerHTML = `<option value="">All companies</option>` +
      me.companies.map((c) => `<option value="${c.id}" ${String(c.id) === C.State.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    sel.onchange = () => {
      C.State.companyId = sel.value;
      localStorage.setItem('arar.company', sel.value);
      route();
    };

    buildNav();
    await refreshPendingCount();
    window.addEventListener('hashchange', route);
    route();

    if (me.user.must_change_password) {
      setTimeout(() => changePasswordForm(true), 400);
    }
  }

  /** Suppliers, employees and the rest, cached for the dropdowns. */
  async function reloadLookups() {
    const data = await API.get('/api/bootstrap');
    C.State.companies = data.companies;
    C.State.suppliers = data.suppliers;
    C.State.customers = data.customers;
    C.State.employees = data.employees;
    C.State.categories = data.categories;
    C.State.bankAccounts = data.bank_accounts;
  }

  function buildNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = NAV.map((g) => {
      const items = g.items.filter((i) => !i.perm || C.can(i.perm));
      if (!items.length) return '';
      return `<div class="group">${esc(g.group)}</div>` + items.map((i) => `
        <a href="${i.href}" data-key="${i.key}">
          <span class="ico">${i.icon}</span>${esc(i.label)}
          ${i.badge === 'petty' ? '<span class="badge-count" id="petty-badge" hidden>0</span>' : ''}
        </a>`).join('');
    }).join('');
  }

  async function refreshPendingCount() {
    if (!C.can('petty.view')) return;
    try {
      const data = await API.get('/api/petty-cash?view=awaiting_me');
      const n = data.totals.pending_count + data.totals.verified_count;
      C.State.pendingPetty = n;
      const badge = document.getElementById('petty-badge');
      if (badge) {
        badge.textContent = n;
        badge.hidden = n === 0;
      }
    } catch { /* the badge is a nicety, never block the app for it */ }
  }

  // ---------------------------------------------------------------- routing

  function parseHash() {
    const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segments = pathPart.split('/').filter(Boolean);
    const query = {};
    new URLSearchParams(queryPart || '').forEach((v, k) => { query[k] = v; });
    return { key: segments[0] || '', id: segments[1], query };
  }

  let routeToken = 0;

  async function route() {
    const { key, id, query } = parseHash();
    const view = document.getElementById('view');
    const def = ROUTES[key];

    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('nav-backdrop').hidden = true;

    if (!def) {
      view.innerHTML = `<div class="empty"><div class="big">&#128533;</div>
        <div>That page does not exist.</div>
        <div style="margin-top:12px"><a class="btn" href="#/dashboard">Back to the dashboard</a></div></div>`;
      return;
    }
    if (def.perm && !C.can(def.perm)) {
      view.innerHTML = `<div class="empty"><div class="big">&#128274;</div>
        <div>Your role does not have access to this screen.</div></div>`;
      return;
    }

    document.getElementById('page-title').textContent = def.title;
    document.querySelectorAll('#nav a').forEach((a) => {
      a.classList.toggle('active', a.dataset.key === (key || 'dashboard'));
    });

    const token = ++routeToken;
    view.innerHTML = '<div class="loading">Loading&hellip;</div>';
    try {
      await def.render(view, query, id);
      if (token !== routeToken) return;   // the user moved on while this was loading
      refreshPendingCount();
    } catch (err) {
      if (token !== routeToken) return;
      view.innerHTML = `<div class="alert error"><b>Could not load this screen.</b><br>${esc(err.message)}</div>
        <button class="btn" onclick="location.reload()">Try again</button>`;
    }
  }

  // ---------------------------------------------------------------- account

  document.getElementById('account-btn').onclick = () => {
    const me = C.State.me;
    const modal = Modal.open({
      title: 'Your account',
      size: 'narrow',
      body: `
        <dl class="kv">
          <dt>Name</dt><dd>${esc(me.name)}</dd>
          <dt>Username</dt><dd><b>${esc(me.username || '-')}</b></dd>
          <dt>Email</dt><dd>${esc(me.email)}</dd>
          <dt>Role</dt><dd>${esc(me.role_label)}</dd>
          <dt>Companies</dt><dd>${esc(C.State.companies.map((c) => c.code).join(', '))}</dd>
        </dl>
        ${C.can('settings.edit') ? '<div id="storage-panel" style="margin-top:14px"></div>' : ''}
        <div class="btn-row" style="margin-top:16px">
          <button class="btn" data-act="password">Change password</button>
          ${C.can('settings.edit') ? '<button class="btn" data-act="backup">Download backup</button>' : ''}
          ${C.can('settings.edit') ? '<button class="btn" data-act="restore">Restore from a backup</button>' : ''}
          <button class="btn danger" data-act="logout">Sign out</button>
        </div>
        ${C.can('settings.edit')
          ? '<p class="mini-note" style="margin:12px 0 0">The backup is the whole system in one file. Keep a copy somewhere safe.</p>'
          : ''}`,
      footer: null
    });
    modal.querySelector('[data-act="password"]').onclick = () => { Modal.close(); changePasswordForm(false); };

    // Whether the data survives a restart is the thing an owner most needs to be
    // able to check, and it should not mean reading deploy logs.
    if (C.can('settings.edit')) loadStoragePanel(modal);

    const restoreBtn = modal.querySelector('[data-act="restore"]');
    if (restoreBtn) restoreBtn.onclick = () => { Modal.close(); restoreForm(); };

    const backupBtn = modal.querySelector('[data-act="backup"]');
    if (backupBtn) {
      backupBtn.onclick = () => {
        // A plain navigation, so the browser saves the file rather than the
        // fetch wrapper pulling a database into memory.
        window.location.href = '/api/admin/backup';
        toast('Preparing the backup, your download will start shortly', 'ok');
      };
    }
    modal.querySelector('[data-act="logout"]').onclick = async () => {
      await API.post('/api/auth/logout');
      Modal.closeAll();
      location.hash = '#/dashboard';
      showLogin('You have signed out.');
    };
  };

  async function loadStoragePanel(modal) {
    const box = modal.querySelector('#storage-panel');
    if (!box) return;
    box.innerHTML = '<div class="mini-note">Checking where the data is kept&hellip;</div>';
    try {
      const s = await API.get('/api/admin/system');
      const mb = s.database_size_bytes ? (s.database_size_bytes / 1048576).toFixed(1) : null;
      box.innerHTML = `
        <div class="alert ${s.storage_is_persistent ? 'ok' : 'error'}">
          <b>${s.storage_is_persistent
                ? 'Your data is kept on storage that survives a restart.'
                : 'Warning: this copy has no permanent storage attached.'}</b>
          ${s.storage_is_persistent
            ? ''
            : '<br>Everything entered will be lost on the next deploy. Attach a volume before entering real data.'}
        </div>
        <dl class="kv">
          <dt>Kept in</dt><dd class="mono" style="font-size:12px">${esc(s.data_dir)}</dd>
          ${mb ? `<dt>Database size</dt><dd>${mb} MB</dd>` : ''}
          <dt>Suppliers</dt><dd>${fmt.int(s.counts.suppliers)}</dd>
          <dt>Supplier invoices</dt><dd><b>${fmt.int(s.counts.purchase_invoices)}</b></dd>
          <dt>Payments</dt><dd>${fmt.int(s.counts.payments)}</dd>
          <dt>Sign in secret</dt><dd>${s.session_secret_is_set
            ? 'set in the environment'
            : 'generated and stored alongside the data'}</dd>
        </dl>`;
    } catch (err) {
      box.innerHTML = `<div class="mini-note">Could not read the storage details: ${esc(err.message)}</div>`;
    }
  }

  /** Replace everything in the app with the contents of a backup file. */
  function restoreForm() {
    const modal = Modal.open({
      title: 'Restore from a backup',
      subtitle: 'Everything currently in the app is replaced',
      body: `
        <div class="alert warn">
          <b>This replaces all the data in the app</b> with whatever is in the file you
          choose - invoices, payments, petty cash, suppliers, everyone's accounts.
          A copy of what is here now is saved first, so nothing is lost for good.
        </div>
        <div class="field required">
          <label>Backup file</label>
          <input type="file" id="restore-file" accept=".db,application/octet-stream">
          <div class="hint">A <b>.db</b> file downloaded from this app, or prepared for you.</div>
        </div>
        <div class="field">
          <label>Type <b>REPLACE</b> to confirm</label>
          <input type="text" id="restore-confirm" autocomplete="off" placeholder="REPLACE">
        </div>
        <div class="alert error" id="restore-error" hidden></div>
        <div id="restore-progress" hidden>
          <div class="mini-note">Uploading and restoring, this can take a moment&hellip;</div>
        </div>`,
      footer: `<button class="btn" data-act="cancel">Cancel</button>
               <button class="btn danger" data-act="go">Replace everything</button>`
    });
    modal.querySelector('[data-act="cancel"]').onclick = () => Modal.close();

    const fail = (message) => {
      const box = modal.querySelector('#restore-error');
      box.textContent = message;
      box.hidden = false;
    };

    modal.querySelector('[data-act="go"]').onclick = async () => {
      const file = modal.querySelector('#restore-file').files[0];
      const typed = modal.querySelector('#restore-confirm').value.trim().toUpperCase();
      modal.querySelector('#restore-error').hidden = true;

      if (!file) return fail('Choose the backup file first');
      if (typed !== 'REPLACE') return fail('Type REPLACE in the box to confirm');

      const btn = modal.querySelector('[data-act="go"]');
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Restoring';
      modal.querySelector('#restore-progress').hidden = false;

      try {
        // Sent as the raw body rather than a form, so the server does not need a
        // multipart parser just for this one screen.
        const res = await fetch('/api/admin/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
          credentials: 'same-origin'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Restore failed (${res.status})`);

        Modal.close();
        Modal.open({
          title: 'Restored',
          size: 'narrow',
          body: `
            <p>The app now holds:</p>
            <dl class="kv">
              <dt>Companies</dt><dd>${fmt.int(data.counts.companies)}</dd>
              <dt>Suppliers</dt><dd>${fmt.int(data.counts.suppliers)}</dd>
              <dt>Supplier invoices</dt><dd><b>${fmt.int(data.counts.purchase_invoices)}</b></dd>
              <dt>Payments</dt><dd>${fmt.int(data.counts.payments)}</dd>
              <dt>Users</dt><dd>${fmt.int(data.counts.users)}</dd>
            </dl>
            <p class="mini-note" style="margin-top:12px">
              What was here before was saved as <b>${esc(data.safety_copy)}</b> in the data folder.
            </p>`,
          footer: '<button class="btn primary" data-act="reload">Reload the app</button>',
          onMount: (m) => {
            m.querySelector('[data-act="reload"]').onclick = () => window.location.reload();
          }
        });
      } catch (err) {
        modal.querySelector('#restore-progress').hidden = true;
        fail(err.message);
        btn.disabled = false;
        btn.textContent = 'Replace everything';
      }
    };
  }

  function changePasswordForm(forced) {
    const modal = Modal.open({
      title: forced ? 'Please choose your own password' : 'Change your password',
      subtitle: forced ? 'You are still using the password you were given' : '',
      size: 'narrow',
      body: C.formFields([
        { name: 'current_password', label: 'Current password', type: 'password', required: true },
        { name: 'new_password', label: 'New password', type: 'password', required: true,
          hint: 'At least 8 characters' },
        { name: 'confirm', label: 'Type it again', type: 'password', required: true }
      ]),
      footer: `${forced ? '' : '<button class="btn" data-act="cancel">Cancel</button>'}
               <button class="btn primary" data-act="save">Change password</button>`
    });
    const cancel = modal.querySelector('[data-act="cancel"]');
    if (cancel) cancel.onclick = () => Modal.close();

    C.wireSave(modal, async (b) => {
      if (b.new_password !== b.confirm) throw new Error('The two new passwords do not match');
      await API.post('/api/auth/change-password', {
        current_password: b.current_password,
        new_password: b.new_password
      });
      C.State.me.must_change_password = false;
    }, { success: 'Password changed' });
  }

  function setNav(open) {
    document.getElementById('sidebar').classList.toggle('open', open);
    document.getElementById('nav-backdrop').hidden = !open;
  }
  document.getElementById('menu-toggle').onclick = () => {
    setNav(!document.getElementById('sidebar').classList.contains('open'));
  };
  document.getElementById('nav-backdrop').onclick = () => setNav(false);

  window.App = { boot, signedOut, reloadLookups, route, refreshPendingCount };
  boot();
})();
