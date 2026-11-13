// Small DOM toolkit. Everything is built with createElement/textContent - server-provided
// strings (config files, container names, log output) are never interpreted as HTML.

export async function api(channel, payload) {
  const res = await window.api.invoke(channel, payload);
  if (res.ok) return res.data;
  // cancelled = the user declined the review dialog; callers treat it as "nothing happened".
  throw Object.assign(new Error(res.error), { hostKey: res.hostKey, cancelled: !!res.cancelled });
}

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  return el;
}

// Line icons (24px grid, stroke-based). Built with createElementNS, never innerHTML.
const ICONS = {
  overview: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  domains: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  dns: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  docker: 'M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  deploys: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  settings: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  server: 'M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01',
};

export function icon(name, size = 18) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.overview);
  svg.append(p);
  return svg;
}

export function toast(message, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 9000 : 3500);
}

/** Run an async action from a button: disables it while running, toasts on failure. */
export async function act(btn, fn, okMessage) {
  const label = btn && btn.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = `${label}…`;
  }
  try {
    const r = await fn();
    if (okMessage) toast(okMessage, 'ok');
    return r;
  } catch (e) {
    if (!e.cancelled) toast(e.message, 'error');
    return undefined;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

export function button(label, onClick, cls = '') {
  const b = h('button', { class: `btn ${cls}`, type: 'button' }, label);
  b.addEventListener('click', () => onClick(b));
  return b;
}

/** modal({ title, body, wide, actions: (close) => [buttons] }) -> close() */
export function modal({ title, body, actions, wide, onClose }) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    // Only the top-most dialog reacts, so Escape on a review never also closes the editor under it.
    if (e.key === 'Escape' && [...document.querySelectorAll('.overlay')].pop() === overlay) close();
  };
  const overlay = h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      h('header', null, title),
      h('div', { class: 'body' }, body),
      h('footer', null, actions ? actions(close) : button('Close', close))
    )
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  const first = overlay.querySelector('input, textarea, select');
  if (first) first.focus();
  return close;
}

export function confirm(title, message, { okLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title,
      body: h('div', { class: 'muted' }, message),
      actions: (close) => [
        button('Cancel', () => (close(), resolve(false))),
        button(okLabel, () => (close(), resolve(true)), danger ? 'danger' : 'primary'),
      ],
    });
  });
}

/**
 * Review dialog shown before anything is changed on the server: what will happen, and the
 * exact commands. Resolves true only if the user presses Run; Cancel/Escape resolve false.
 */
export function reviewModal(plan) {
  return new Promise((resolve) => {
    let approved = false;
    const n = plan.steps.length;
    const steps = plan.steps.map((s, i) =>
      h(
        'div',
        { class: 'step' },
        h('div', { class: 'step-head' }, h('span', { class: 'step-n' }, String(i + 1)), h('span', null, s.what || 'Run command'), h('span', { class: 'spacer' }), badge(s.via || (s.asRoot ? 'as root' : `as ${plan.user}`), s.via ? 'info' : '')),
        h('pre', { class: 'output' }, s.cmd),
        s.input != null &&
          h('details', null, h('summary', null, `Show the content sent to this command (${s.input.split('\n').length} lines)`), h('pre', { class: 'output' }, s.input))
      )
    );
    modal({
      title: plan.title,
      wide: true,
      onClose: () => resolve(approved),
      body: [
        plan.detail && h('div', { class: plan.danger ? 'warn-box' : 'info-box' }, plan.detail),
        h('div', { class: 'field muted' }, `Nothing has been changed yet. Pressing Run executes ${n === 1 ? 'this step' : `these ${n} steps, in order`}. Commands run on ${plan.target} unless a step is marked otherwise:`),
        steps,
      ],
      actions: (close) => [
        button('Cancel', close),
        button(n === 1 ? 'Run command' : `Run ${n} commands`, () => ((approved = true), close()), plan.danger ? 'danger' : 'primary'),
      ],
    });
  });
}

export function showOutput(title, text) {
  const pre = h('pre', { class: 'output' }, text || '(no output)');
  modal({ title, wide: true, body: pre });
  requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
}

export function field(label, control, hint) {
  return h('div', { class: 'field' }, h('label', null, label), control, hint && h('div', { class: 'hint' }, hint));
}

export const input = (attrs = {}) => h('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', ...attrs });

export function select(options, value) {
  const s = h('select', null, options.map(([v, label]) => h('option', { value: v }, label)));
  if (value != null) s.value = value;
  return s;
}

export function badge(text, kind = '') {
  return h('span', { class: `badge ${kind}` }, text);
}

export function copyLine(text, { display } = {}) {
  return h(
    'div',
    { class: 'copyline' },
    h('code', { title: display ? '' : text }, display || text),
    button('Copy', () => api('clipboard:write', text).then(() => toast('Copied', 'ok')), 'small')
  );
}

export function pageHead(title, ...actions) {
  return h('div', { class: 'page-head' }, h('h1', null, title), h('span', { class: 'spacer' }), actions);
}

export function table(headers, rows, emptyText) {
  if (!rows.length) return h('div', { class: 'table-wrap' }, h('div', { class: 'empty' }, emptyText));
  return h(
    'div',
    { class: 'table-wrap' },
    h('table', null, h('thead', null, h('tr', null, headers.map((t) => h('th', null, t)))), h('tbody', null, rows))
  );
}

/** Show a placeholder while `fn` builds the content; show the error if it fails. */
export async function load(root, fn) {
  const holder = h('div', { class: 'loading' }, 'Loading…');
  root.append(holder);
  try {
    const content = await fn();
    holder.replaceWith(...[content].flat(Infinity).filter(Boolean));
  } catch (e) {
    holder.replaceWith(h('div', { class: 'error-box' }, e.message));
  }
}

export function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtDuration(sec) {
  sec = Math.round(sec);
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${sec % 60}s`;
  return `${sec}s`;
}

export const timeAgo = (epochSec) => `${fmtDuration(Math.max(0, Date.now() / 1000 - epochSec))} ago`;
