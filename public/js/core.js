/* Shared front end plumbing: API calls, formatting, modals, forms and tables.
   Everything hangs off window so the view files can stay plain scripts. */
(function () {
  'use strict';

  // ---------------------------------------------------------------- state

  const State = {
    me: null,
    permissions: [],
    companies: [],
    suppliers: [],
    customers: [],
    employees: [],
    categories: [],
    bankAccounts: [],
    groupName: 'ARAR INFRA GROUP',
    currency: 'AED',
    defaultTerms: 90,
    companyId: '',          // '' means the whole group
    pendingPetty: 0
  };

  function can(permission) {
    return State.permissions.indexOf(permission) !== -1;
  }

  /** The company filter, as a query string piece. */
  function companyParam() {
    return State.companyId ? `company_id=${encodeURIComponent(State.companyId)}` : '';
  }

  function companyName(id) {
    const c = State.companies.find((x) => String(x.id) === String(id));
    return c ? c.name : '';
  }

  // ---------------------------------------------------------------- api

  async function request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin'
    });
    if (res.status === 401 && !url.includes('/auth/login')) {
      window.App && window.App.signedOut();
      throw new Error('Please sign in again');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  const API = {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
    put: (url, body) => request('PUT', url, body || {}),
    del: (url) => request('DELETE', url)
  };

  // ---------------------------------------------------------------- format

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const fmt = {
    money(n, opts) {
      const v = Number(n || 0);
      const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return (opts && opts.currency) ? `${State.currency} ${s}` : s;
    },
    /** Short form for the KPI cards: 1.25 M, 84.3 K. */
    compact(n) {
      const v = Math.abs(Number(n || 0));
      const sign = Number(n) < 0 ? '-' : '';
      if (v >= 1000000) return `${sign}${(v / 1000000).toFixed(2)} M`;
      if (v >= 1000) return `${sign}${(v / 1000).toFixed(1)} K`;
      return sign + v.toFixed(2);
    },
    int(n) { return Number(n || 0).toLocaleString('en-US'); },
    date(d) {
      if (!d) return '';
      const parts = String(d).slice(0, 10).split('-');
      if (parts.length !== 3) return String(d);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${parts[2]} ${months[Number(parts[1]) - 1]} ${parts[0]}`;
    },
    dateTime(d) {
      if (!d) return '';
      const s = String(d).replace(' ', 'T');
      const dt = new Date(s.endsWith('Z') || s.includes('+') ? s : `${s}Z`);
      if (isNaN(dt.getTime())) return String(d);
      return `${fmt.date(dt.toISOString())} ${dt.toTimeString().slice(0, 5)}`;
    },
    month(m) {
      if (!m) return '';
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const p = String(m).split('-');
      return `${months[Number(p[1]) - 1]} ${p[0]}`;
    },
    label(v) {
      return String(v || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    },
    initials(name) {
      return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
    }
  };

  const today = () => new Date().toISOString().slice(0, 10);

  function addDays(dateStr, days) {
    const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------- badges

  const STATUS_BADGE = {
    OPEN: 'grey', PARTIALLY_PAID: 'blue', PAID: 'green', ON_HOLD: 'amber', CANCELLED: 'grey',
    PENDING: 'amber', VERIFIED: 'blue', APPROVED: 'green', REJECTED: 'red',
    ISSUED: 'blue', PRESENTED: 'purple', CLEARED: 'green', BOUNCED: 'red', REPLACED: 'grey',
    COMPLETED: 'green'
  };

  function badge(value, cls) {
    if (!value) return '';
    return `<span class="badge ${cls || STATUS_BADGE[value] || 'grey'}">${esc(fmt.label(value))}</span>`;
  }

  const MODE_LABEL = {
    CASH: 'Cash',
    BANK_TRANSFER: 'Bank transfer',
    PDC: 'PDC',
    CHEQUE: 'Cheque',
    ONLINE: 'Online',
    OTHER: 'Other'
  };

  // ---------------------------------------------------------------- toast

  function toast(message, type) {
    const wrap = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = `toast ${type || ''}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, type === 'error' ? 5200 : 3200);
  }

  // ---------------------------------------------------------------- modal

  const Modal = {
    stack: [],

    open(opts) {
      const root = document.getElementById('modal-root');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal ${opts.size || ''}" role="dialog" aria-modal="true">
          <header>
            <div>
              <h3>${esc(opts.title || '')}</h3>
              ${opts.subtitle ? `<div class="sub">${esc(opts.subtitle)}</div>` : ''}
            </div>
            <button class="close" type="button" aria-label="Close">&times;</button>
          </header>
          <div class="modal-body">${opts.body || ''}</div>
          ${opts.footer === null ? '' : `<footer>${opts.footer || ''}</footer>`}
        </div>`;
      root.appendChild(backdrop);
      Modal.stack.push(backdrop);

      backdrop.querySelector('.close').onclick = () => Modal.close();
      backdrop.onclick = (e) => { if (e.target === backdrop) Modal.close(); };

      const first = backdrop.querySelector('input:not([type=hidden]), select, textarea');
      if (first) setTimeout(() => first.focus(), 40);
      if (opts.onMount) opts.onMount(backdrop);
      return backdrop;
    },

    close() {
      const top = Modal.stack.pop();
      if (top) top.remove();
    },

    closeAll() {
      Modal.stack.forEach((m) => m.remove());
      Modal.stack = [];
    },

    /** Yes / no, resolving to a boolean. */
    confirm(opts) {
      return new Promise((resolve) => {
        const m = Modal.open({
          title: opts.title || 'Please confirm',
          size: 'narrow',
          body: `<p style="margin:0">${esc(opts.message || '')}</p>`,
          footer: `
            <button class="btn" data-act="no">Cancel</button>
            <button class="btn ${opts.danger ? 'danger' : 'primary'}" data-act="yes">${esc(opts.confirmText || 'Confirm')}</button>`
        });
        m.querySelector('[data-act="no"]').onclick = () => { Modal.close(); resolve(false); };
        m.querySelector('[data-act="yes"]').onclick = () => { Modal.close(); resolve(true); };
      });
    },

    /** One line of text, resolving to the string or null. */
    prompt(opts) {
      return new Promise((resolve) => {
        const m = Modal.open({
          title: opts.title || '',
          size: 'narrow',
          body: `
            <div class="field ${opts.required ? 'required' : ''}">
              <label>${esc(opts.label || '')}</label>
              ${opts.multiline
                ? `<textarea id="prompt-value">${esc(opts.value || '')}</textarea>`
                : `<input type="text" id="prompt-value" value="${esc(opts.value || '')}">`}
              ${opts.hint ? `<div class="hint">${esc(opts.hint)}</div>` : ''}
            </div>
            <div class="alert error" id="prompt-error" hidden></div>`,
          footer: `
            <button class="btn" data-act="no">Cancel</button>
            <button class="btn primary" data-act="yes">${esc(opts.confirmText || 'Save')}</button>`
        });
        const input = m.querySelector('#prompt-value');
        const submit = () => {
          const v = input.value.trim();
          if (opts.required && !v) {
            const err = m.querySelector('#prompt-error');
            err.textContent = 'This is required';
            err.hidden = false;
            return;
          }
          Modal.close();
          resolve(v);
        };
        m.querySelector('[data-act="no"]').onclick = () => { Modal.close(); resolve(null); };
        m.querySelector('[data-act="yes"]').onclick = submit;
        input.onkeydown = (e) => { if (e.key === 'Enter' && !opts.multiline) submit(); };
      });
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && Modal.stack.length) Modal.close();
  });

  // ---------------------------------------------------------------- forms

  /**
   * Build a form from a simple field list.
   * { name, label, type, value, options, required, hint, colspan, attrs }
   */
  function formFields(fields) {
    return fields.map((f) => {
      if (f.type === 'group') {
        return `<div class="${f.className || 'grid-2'}">${formFields(f.fields)}</div>`;
      }
      if (f.type === 'html') return f.html;
      const id = `f_${f.name}`;
      const req = f.required ? 'required' : '';
      const attrs = Object.entries(f.attrs || {}).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
      let input;
      if (f.type === 'select') {
        const opts = (f.options || []).map((o) => {
          const val = o.value === undefined ? o : o.value;
          const text = o.label === undefined ? o : o.label;
          const sel = String(val) === String(f.value === undefined || f.value === null ? '' : f.value) ? 'selected' : '';
          return `<option value="${esc(val)}" ${sel}>${esc(text)}</option>`;
        }).join('');
        input = `<select id="${id}" name="${esc(f.name)}" ${req} ${attrs}>${opts}</select>`;
      } else if (f.type === 'textarea') {
        input = `<textarea id="${id}" name="${esc(f.name)}" ${req} ${attrs}>${esc(f.value || '')}</textarea>`;
      } else {
        const step = f.type === 'number' ? (f.step || '0.01') : null;
        input = `<input type="${f.type || 'text'}" id="${id}" name="${esc(f.name)}"
                    value="${esc(f.value === null || f.value === undefined ? '' : f.value)}"
                    ${step ? `step="${step}"` : ''} ${req} ${attrs}>`;
      }
      return `
        <div class="field ${req}" data-field="${esc(f.name)}">
          <label for="${id}">${esc(f.label || '')}</label>
          ${input}
          ${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}
        </div>`;
    }).join('');
  }

  /** Read every named input inside a container into a plain object. */
  function readForm(root) {
    const out = {};
    root.querySelectorAll('[name]').forEach((el) => {
      if (el.dataset.skip === '1') return;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value === '' ? null : el.value;
    });
    return out;
  }

  function showFormError(root, message) {
    let box = root.querySelector('.form-error');
    if (!box) {
      box = document.createElement('div');
      box.className = 'alert error form-error';
      const body = root.querySelector('.modal-body') || root;
      body.insertBefore(box, body.firstChild);
    }
    box.textContent = message;
    box.hidden = false;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Wire a save button: disable, call, close, refresh. */
  function wireSave(modal, handler, opts) {
    const btn = modal.querySelector('[data-act="save"]');
    if (!btn) return;
    btn.onclick = async () => {
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span> Saving';
      try {
        await handler(readForm(modal), modal);
        Modal.close();
        if (opts && opts.success) toast(opts.success, 'ok');
        if (opts && opts.after) opts.after();
      } catch (err) {
        showFormError(modal, err.message);
        btn.disabled = false;
        btn.innerHTML = original;
      }
    };
  }

  // ---------------------------------------------------------------- tables

  /**
   * Render a table. Columns are { key, label, num, mono, width, render(row) }.
   * `rowClass(row)` paints the overdue and due-soon rows.
   */
  function table(rows, columns, opts) {
    opts = opts || {};
    if (!rows.length) {
      return `<div class="empty">
                <div class="big">${opts.emptyIcon || '&#128203;'}</div>
                <div>${esc(opts.empty || 'Nothing to show yet')}</div>
                ${opts.emptyHint ? `<div class="mini-note" style="margin-top:6px">${esc(opts.emptyHint)}</div>` : ''}
              </div>`;
    }
    const head = columns.map((c) =>
      `<th class="${c.num ? 'num' : ''}" ${c.width ? `style="width:${c.width}"` : ''}>${esc(c.label)}</th>`
    ).join('');

    const body = rows.map((row, i) => {
      const cls = opts.rowClass ? opts.rowClass(row) : '';
      const cells = columns.map((c) => {
        const v = c.render ? c.render(row, i) : esc(row[c.key]);
        return `<td class="${c.num ? 'num' : ''} ${c.mono ? 'mono' : ''}">${v === null || v === undefined ? '' : v}</td>`;
      }).join('');
      return `<tr class="${cls}" ${opts.rowAttrs ? opts.rowAttrs(row) : ''}>${cells}</tr>`;
    }).join('');

    // A footer may be an array (one entry per column) or an object keyed by column key.
    const foot = opts.footer
      ? `<tfoot><tr>${columns.map((c, idx) => {
          const v = Array.isArray(opts.footer) ? opts.footer[idx] : opts.footer[c.key];
          return `<td class="${c.num ? 'num' : ''}">${v === undefined || v === null ? '' : v}</td>`;
        }).join('')}</tr></tfoot>`
      : '';

    return `<div class="table-scroll"><table class="data">
              <thead><tr>${head}</tr></thead>
              <tbody>${body}</tbody>${foot}
            </table></div>`;
  }

  /** Colour an invoice row by how late it is. */
  function invoiceRowClass(row) {
    if (row.status === 'CANCELLED') return 'row-muted';
    if (row.is_overdue) return 'row-overdue';
    if (row.is_due_soon) return 'row-due-soon';
    return '';
  }

  // ---------------------------------------------------------------- csv

  function downloadCsv(filename, columns, rows) {
    const cell = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.map((c) => cell(c.label)).join(',')];
    rows.forEach((r) => {
      lines.push(columns.map((c) => cell(c.value ? c.value(r) : r[c.key])).join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  // ---------------------------------------------------------------- options

  const opt = {
    companies(includeAll) {
      const list = State.companies.map((c) => ({ value: c.id, label: c.name }));
      return includeAll ? [{ value: '', label: 'All companies' }].concat(list) : list;
    },
    suppliers(includeBlank) {
      const list = State.suppliers.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }));
      return includeBlank ? [{ value: '', label: includeBlank === true ? 'All suppliers' : includeBlank }].concat(list) : list;
    },
    customers(includeBlank) {
      const list = State.customers.map((s) => ({ value: s.id, label: `${s.name} (${s.code})` }));
      return includeBlank ? [{ value: '', label: includeBlank === true ? 'All customers' : includeBlank }].concat(list) : list;
    },
    employees(includeBlank) {
      const list = State.employees.map((e) => ({
        value: e.id,
        label: e.designation ? `${e.name} - ${e.designation}` : e.name
      }));
      return includeBlank ? [{ value: '', label: 'Choose an employee' }].concat(list) : list;
    },
    categories(kind, blankLabel) {
      const list = State.categories.filter((c) => c.kind === kind).map((c) => ({ value: c.id, label: c.name }));
      return [{ value: '', label: blankLabel || 'Not set' }].concat(list);
    },
    banks(companyId, blankLabel) {
      const list = State.bankAccounts
        .filter((b) => !companyId || String(b.company_id) === String(companyId))
        .map((b) => ({ value: b.id, label: b.account_no ? `${b.bank_name} - ${b.account_no}` : b.bank_name }));
      return [{ value: '', label: blankLabel || 'Not set' }].concat(list);
    },
    modes() {
      return Object.entries(MODE_LABEL).map(([value, label]) => ({ value, label }));
    }
  };

  window.Core = {
    State, can, companyParam, companyName,
    API, esc, fmt, today, addDays,
    badge, STATUS_BADGE, MODE_LABEL,
    toast, Modal,
    formFields, readForm, showFormError, wireSave,
    table, invoiceRowClass, downloadCsv, opt
  };
})();
