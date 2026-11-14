// Recent HTTP traffic for one site, from its nginx access log. Reached from a site's "Traffic"
// button (Sites screen, config editor) or from a site pinned to the menu. Refreshes while open.
import { h, api, act, button, copyButton, badge, breadcrumbs, table, toast, modal, field, input, fmtBytes, fmtDuration } from '../ui.js';

const POLL_MS = 5000;
const ROWS = 200;

const statusKind = (s) => (s >= 500 ? 'bad' : s >= 400 ? 'warn' : s >= 300 ? 'info' : 'ok');
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '—');

function stat(label, value, sub, cls = '') {
  return h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), sub && h('div', { class: 'sub' }, sub));
}

/** Requests per minute over the last hour, as bars; the 4xx/5xx part of each bar in red. */
function rateChart({ start, values }) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 600;
  const H = 90;
  const max = Math.max(1, ...values.map((v) => v.total));
  const bw = W / values.length;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'chart-svg traffic-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Requests per minute over the last hour');
  values.forEach((v, i) => {
    const t = start + i * 60000;
    for (const [n, cls] of [[v.total, 'bar-ok'], [v.errors, 'bar-err']]) {
      if (!n) continue;
      const r = document.createElementNS(NS, 'rect');
      const bh = Math.max(1.5, (n / max) * (H - 4));
      r.setAttribute('x', (i * bw + 1).toFixed(1));
      r.setAttribute('width', Math.max(1, bw - 2).toFixed(1));
      r.setAttribute('y', (H - bh).toFixed(1));
      r.setAttribute('height', bh.toFixed(1));
      r.setAttribute('class', cls);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${clock(t).slice(0, 5)} · ${v.total} request${v.total === 1 ? '' : 's'}${v.errors ? `, ${v.errors} error${v.errors === 1 ? '' : 's'}` : ''}`;
      r.append(title);
      svg.append(r);
    }
  });
  return h(
    'div',
    { class: 'chart' },
    h('div', { class: 'chart-plot' }, svg, h('div', { class: 'chart-scale' }, `${max}/min`)),
    h('div', { class: 'chart-axis' }, h('span', null, '60 min ago'), h('span', null, 'now')),
    h('div', { class: 'chart-legend' }, h('span', { class: 'chart-key' }, h('i', { style: 'background:var(--accent-2)' }), 'Requests'), h('span', { class: 'chart-key' }, h('i', { style: 'background:var(--bad)' }), '4xx / 5xx'))
  );
}

// The access log has no session ID, so a visit is a run of requests from one client (IP + user
// agent) with no gap longer than this, the same rule web analytics tools use.
const VISIT_GAP_MS = 30 * 60000;
const PRIVATE_IP = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd])/i;

// Country of each client IP, shared by every Traffic page and filled in by net:geo (which caches
// on disk). Flags are flag-icons' SVGs; Windows has no emoji flags, so text is the fallback.
const geo = new Map(); // ip -> { cc, country, city, isp, org, as, hosting, proxy } | { private: true }
const geoAsked = new Map(); // ip -> when it was asked for, so a failed lookup is retried a minute later
const FLAGS = new URL('../../../node_modules/flag-icons/flags/4x3/', import.meta.url).href;

/** The client's flag (or a text stand-in), with the place as its tooltip. */
function flag(ip) {
  const g = geo.get(ip);
  if (!g) return h('span', { class: 'flag' });
  if (g.private) return h('span', { class: 'flag flag-text', title: 'Private network address' }, 'LAN');
  if (!g.cc) return h('span', { class: 'flag', title: 'Location unknown' });
  const title = [g.city, g.country].filter(Boolean).join(', ');
  const img = h('img', { class: 'flag', src: `${FLAGS}${g.cc}.svg`, alt: g.cc.toUpperCase(), title });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: 'flag flag-text', title }, g.cc.toUpperCase())), { once: true });
  return img;
}

/** Look up the IPs not known yet. Resolves true when something new came back. */
async function lookupGeo(ips) {
  const now = Date.now();
  const want = [...new Set(ips)].filter((ip) => !geo.has(ip) && now - (geoAsked.get(ip) || 0) > 60000).slice(0, 300);
  if (!want.length) return false;
  want.forEach((ip) => geoAsked.set(ip, now));
  const r = await api('net:geo', { ips: want }).catch(() => ({}));
  for (const [ip, v] of Object.entries(r)) geo.set(ip, v);
  return Object.keys(r).length > 0;
}

const botBadge = (name) => name && h('span', { class: 'bot-badge', title: name === 'No user agent' ? 'Sent no user agent, which real browsers always do' : `Automated client: ${name}` }, name === 'No user agent' ? 'No UA' : name);

/** User agent cell: the bot's name as a badge, then the raw string. */
const agentCell = (e) => h('td', { class: 'muted ua-cell', title: e.agent || 'No user agent' }, botBadge(e.bot), e.agent || (e.bot ? '' : '—'));

/** Referrer cell: links from the site itself show just the path (dimmed), others the host and path. */
function refCell(ref, domains = []) {
  if (!ref) return h('td', { class: 'muted ref-cell' }, '—');
  let u = null;
  try {
    u = new URL(ref);
  } catch {}
  if (!u) return h('td', { class: 'ref-cell', title: ref }, ref);
  const host = u.hostname.replace(/^www\./, '');
  const own = domains.some((d) => d.replace(/^www\./, '') === host);
  const rest = u.pathname === '/' && !u.search ? '' : u.pathname + u.search;
  return h('td', { class: `ref-cell ${own ? 'muted' : 'ref-ext'}`, title: own ? `${ref}\n(from this site)` : ref }, own ? rest || '/' : host + rest);
}

/** One client's entries (any order) -> visits, newest first, each with its requests oldest first. */
function visitsOf(entries) {
  const sorted = [...entries].sort((a, b) => (a.time || 0) - (b.time || 0));
  const open = new Map(); // user agent -> visit in progress
  const visits = [];
  for (const e of sorted) {
    let v = open.get(e.agent);
    if (!v || (e.time != null && v.end != null && e.time - v.end > VISIT_GAP_MS)) {
      v = { agent: e.agent, start: e.time, end: e.time, requests: [] };
      open.set(e.agent, v);
      visits.push(v);
    }
    v.requests.push(e);
    if (e.time != null) v.end = e.time;
  }
  visits.forEach((v, i) => (v.id = i + 1));
  return visits.reverse();
}

function countBy(items, key) {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ key: k, count }));
}

const when = (ms, now) => (ms == null ? '—' : now - ms > 86400000 ? `${day(ms)} ${clock(ms)}` : clock(ms));

/**
 * Everything the loaded log says about one client IP: totals, user agents, paths and its visits.
 * `focus` (an entry) opens the visit it belongs to. onFilter(ip) narrows the page to this client.
 */
function clientDialog(ip, data, { focus, onFilter } = {}) {
  const mine = data.entries.filter((e) => e.ip === ip);
  const visits = visitsOf(mine);
  const now = data.now;
  const times = mine.map((e) => e.time).filter((t) => t != null);
  const errors = mine.filter((e) => e.status >= 400).length;
  const bytes = mine.reduce((n, e) => n + e.bytes, 0);

  const place = h('div', { class: 'client-place' });
  const drawPlace = () => {
    const g = geo.get(ip);
    if (!g) return place.replaceChildren(h('span', { class: 'muted' }, 'Looking up location…'));
    if (g.private) return place.replaceChildren();
    place.replaceChildren(
      flag(ip),
      h('span', null, [g.city, g.country].filter(Boolean).join(', ') || 'Location unknown'),
      (g.org || g.isp) && h('span', { class: 'muted' }, `· ${g.org || g.isp}`),
      g.as && h('span', { class: 'muted mono' }, `· ${g.as.split(' ')[0]}`),
      g.hosting && h('span', { class: 'bot-badge', title: 'This address belongs to a hosting or datacenter network, where crawlers and scripts usually run, not home or mobile internet' }, 'Datacenter'),
      g.proxy && h('span', { class: 'bot-badge', title: 'Known proxy, VPN or Tor exit' }, 'Proxy / VPN')
    );
  };
  drawPlace();
  if (!geo.has(ip)) lookupGeo([ip]).then(drawPlace);
  const bots = countBy(mine.filter((e) => e.bot), (e) => e.bot);
  const who = bots.length
    ? h('div', { class: 'client-place' }, h('span', null, bots.length === 1 && bots[0].count === mine.length ? 'Bot:' : 'Bots among its requests:'), ...bots.map((b) => botBadge(b.key)))
    : h('div', { class: 'client-place muted' }, "Its user agents look like a person's browser.");
  const host = h('span', { class: 'muted' }, 'Looking up host name…');
  if (PRIVATE_IP.test(ip)) {
    host.replaceChildren('Private network address: usually a proxy, load balancer or container in front of nginx, so the real visitor IP is not in this log.');
  } else {
    api('net:reverseDns', { ip })
      .then((r) => host.replaceChildren(r.names.length ? h('span', { class: 'mono' }, r.names.join(', ')) : 'No reverse DNS name.'))
      .catch(() => host.replaceChildren('Reverse DNS lookup failed.'));
  }

  const list = (title, rows, mono) =>
    h(
      'div',
      { class: 'card traffic-top' },
      h('div', { class: 'chart-title' }, title),
      h(
        'div',
        { class: 'top-list' },
        rows.slice(0, 8).map((r) => {
          const fill = h('i');
          fill.style.width = `${Math.max(2, (r.count / rows[0].count) * 100)}%`;
          return h('div', { class: 'top-row', title: r.key || '—' }, h('span', { class: mono ? 'mono top-key' : 'top-key' }, r.key || '—'), h('span', { class: 'top-bar' }, fill), h('b', null, String(r.count)));
        })
      )
    );

  const requestRows = (reqs) =>
    table(
      ['Time', 'Request', 'Status', 'Referrer'],
      [...reqs].reverse().map((e) =>
        h(
          'tr',
          { class: e === focus ? 'focus-row' : '' },
          h('td', { class: 'mono muted nowrap' }, when(e.time, now)),
          h('td', { class: 'mono req-cell', title: `${e.method} ${e.path}` }, e.method && h('span', { class: 'method' }, e.method), ' ', e.path),
          h('td', null, badge(String(e.status), statusKind(e.status))),
          refCell(e.referer, data.domains)
        )
      ),
      'No requests.',
      { fit: true }
    );

  const visitList = h(
    'div',
    { class: 'visit-list' },
    visits.map((v) => {
      const errs = v.requests.filter((e) => e.status >= 400).length;
      const pages = new Set(v.requests.map((e) => e.path.split('?')[0])).size;
      const detail = h('div', { class: 'visit-detail hidden' });
      const head = h(
        'button',
        { type: 'button', class: 'visit-head', 'aria-expanded': 'false' },
        h('span', { class: 'mono visit-id' }, `#${v.id}`),
        h('span', { class: 'mono nowrap' }, when(v.start, now)),
        h('span', { class: 'muted nowrap' }, v.start != null && v.end > v.start ? fmtDuration(Math.max(1, (v.end - v.start) / 1000)) : 'single hit'),
        h('span', { class: 'nowrap' }, `${v.requests.length} req · ${pages} path${pages === 1 ? '' : 's'}`),
        errs ? badge(`${errs} error${errs === 1 ? '' : 's'}`, 'warn') : h('span'),
        h('span', { class: 'mono muted visit-entry', title: v.requests[0].path }, v.requests[0].path),
        h('span', { class: 'muted ua-cell', title: v.agent }, botBadge(v.requests[0].bot), v.agent || '')
      );
      const toggle = (open) => {
        if (open && !detail.firstChild) detail.append(requestRows(v.requests));
        detail.classList.toggle('hidden', !open);
        head.setAttribute('aria-expanded', String(open));
      };
      head.addEventListener('click', () => toggle(detail.classList.contains('hidden')));
      if (focus && v.requests.includes(focus)) setTimeout(() => (toggle(true), detail.querySelector('.focus-row')?.scrollIntoView({ block: 'nearest' })));
      return h('div', { class: 'visit' }, head, detail);
    })
  );

  modal({
    title: h('span', { class: 'client-title' }, 'Client ', flag(ip), h('span', { class: 'mono' }, ip)),
    wide: true,
    body: h(
      'div',
      { class: 'client-drill' },
      place,
      who,
      h('div', { class: 'field' }, host),
      h(
        'div',
        { class: 'grid traffic-stats' },
        stat('Requests', String(mine.length), `${pct(mine.length, data.entries.length)} of the loaded ${data.pages ? 'page loads' : 'log'}`),
        stat('Visits', String(visits.length), 'no gap over 30 min'),
        stat('Errors', pct(errors, mine.length), `${errors} 4xx/5xx`, errors ? 'text-warn' : ''),
        stat('Data sent', fmtBytes(bytes), ''),
        stat('First seen', times.length ? when(Math.min(...times), now) : '—', ''),
        stat('Last seen', times.length ? `${fmtDuration(Math.max(0, (now - Math.max(...times)) / 1000))} ago` : '—', '')
      ),
      h('div', { class: 'client-grid section-gap' }, list('User agents', countBy(mine, (e) => (e.bot ? `[${e.bot}] ` : '') + (e.agent || '')), false), list('Paths', countBy(mine, (e) => e.path.split('?')[0]), true)),
      h('div', { class: 'section-head section-gap' }, h('h2', null, 'Visits'), h('span', { class: 'muted' }, 'Click a visit to see its requests. Nginx logs no session ID, so visits are grouped by user agent and a 30-minute gap.')),
      visitList
    ),
    actions: (close) => [copyButton(() => ip, 'Copy IP'), onFilter && button('Show only this client', () => (close(), onFilter(ip))), button('Close', close, 'primary')].filter(Boolean),
  });
}

function topTable(title, rows, total, mono = true, onPick) {
  return h(
    'div',
    { class: 'card traffic-top' },
    h('div', { class: 'chart-title' }, title),
    rows.length
      ? h(
          'div',
          { class: 'top-list' },
          rows.map((r) => {
            const fill = h('i');
            fill.style.width = `${Math.max(2, (r.count / rows[0].count) * 100)}%`;
            const key = onPick
              ? h('span', { class: 'top-key top-client' }, flag(r.key), h('button', { type: 'button', class: `link ${mono ? 'mono ' : ''}top-key`, onclick: () => onPick(r.key) }, r.key))
              : h('span', { class: mono ? 'mono top-key' : 'top-key' }, r.key);
            return h('div', { class: 'top-row', title: `${r.key} — ${r.count} (${pct(r.count, total)})` }, key, h('span', { class: 'top-bar' }, fill), h('b', null, String(r.count)));
          })
        )
      : h('div', { class: 'muted' }, 'Nothing yet.')
  );
}

/**
 * Ask for the log's size cap, then run nginx:siteLog (which shows its own review).
 * Resolves the result, or undefined when cancelled.
 */
function logLimitDialog(name, kind, current, adding) {
  return new Promise((resolve) => {
    const size = input({ type: 'number', min: 1, max: 10240, step: 1, value: String(current ? current.maxSizeMb : 50) });
    const keep = input({ type: 'number', min: 0, max: 20, step: 1, value: String(current ? current.keep : 1) });
    const err = h('div', { class: 'error-box hidden' });
    let done = false;
    modal({
      title: adding ? `Give ${name} its own access log` : `Size limit for ${name}'s log`,
      body: h(
        'div',
        null,
        adding && h('div', { class: 'field muted' }, 'Requests to this site will be written to ', h('span', { class: 'mono' }, `/var/log/nginx/sites/${name}.access.log`), ' instead of the shared log, so this screen shows exactly this site.'),
        field('Max size (MB)', size, 'When the log grows past this, it is rotated: the current file is emptied and the old lines moved to a compressed copy. Checked every hour.'),
        field('Old copies to keep', keep, '0 throws the old lines away; each kept copy is gzip-compressed (typically about a tenth of the size).'),
        err
      ),
      onClose: () => !done && resolve(undefined),
      actions: (closeIt) => [
        button('Cancel', closeIt),
        button(adding ? 'Continue' : 'Save limit', async (b) => {
          const r = await act(b, () => api('nginx:siteLog', { name, kind, maxSizeMb: Number(size.value), keep: Number(keep.value) })).catch(() => undefined);
          if (r) {
            done = true;
            closeIt();
            resolve(r);
          }
        }, 'primary'),
      ],
    });
  });
}

export function render(root, ctx) {
  const { name, kind = 'site' } = ctx.params || {};
  if (!name) return ctx.go('domains');
  root.classList.add('traffic-page');

  let timer = null;
  let busy = false;
  let paused = false;
  let data = null;
  let filter = '';
  let only = 'all';
  let client = ''; // narrow the request list to one IP, from the client drill-down
  let pages = false; // just page loads, not the scripts, styles and images they pull in
  try {
    pages = localStorage.getItem('traffic.pages') === '1';
  } catch {}
  let who = 'all'; // every client, only people's browsers, or only bots
  try {
    who = localStorage.getItem('traffic.who') || 'all';
  } catch {}
  let match = 'site'; // shared log: just this site's lines (grep for its domains), or all of them

  async function ownLog(adding) {
    const r = await logLimitDialog(name, kind, data && data.limit, adding);
    if (!r) return;
    toast(r.added ? `${name} now logs to ${r.path} (up to ${r.maxSizeMb} MB)` : `Log limit set to ${r.maxSizeMb} MB`, 'ok');
    tick();
  }

  const status = h('span', { class: 'muted live' }, h('span', { class: 'dot' }), 'Loading…');
  const pinned = () => ctx.isPinned(name, kind);
  const pinBtn = button('', async (b) => {
    const r = await act(b, () => ctx.togglePin(name, kind));
    if (r) {
      toast(pinned() ? `${name} pinned to the menu` : `${name} unpinned`, 'ok');
      drawPin();
    }
  });
  const drawPin = () => {
    pinBtn.textContent = pinned() ? 'Unpin from menu' : 'Pin to menu';
    pinBtn.title = pinned() ? 'Remove this site from the side menu' : 'Keep this site in the side menu for quick access to its traffic';
    pinBtn.classList.toggle('primary', !pinned());
  };
  drawPin();
  const pauseBtn = button('Pause', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (paused) {
      clearTimeout(timer);
      status.replaceChildren(h('span', { class: 'dot' }), 'Paused');
    } else tick();
  });

  const kindSeg = h('div', { class: 'seg', title: 'Page loads leaves out scripts, styles, images, fonts, framework assets (/_next/ and the like) and /api calls' });
  const drawKind = () =>
    kindSeg.replaceChildren(
      ...[[false, 'All requests'], [true, 'Page loads']].map(([v, label]) =>
        h('button', { type: 'button', class: v === pages ? 'on' : '', onclick: () => {
          if (pages === v) return;
          pages = v;
          try {
            localStorage.setItem('traffic.pages', v ? '1' : '0');
          } catch {}
          drawKind();
          tick();
        } }, label)
      )
    );
  drawKind();

  const whoSeg = h('div', { class: 'seg', title: 'Bots are told apart by user agent: crawlers, link previews, HTTP libraries, scanners and requests with no user agent' });
  const drawWho = () =>
    whoSeg.replaceChildren(
      ...[['all', 'Everyone'], ['humans', 'Humans'], ['bots', 'Bots']].map(([v, label]) =>
        h('button', { type: 'button', class: v === who ? 'on' : '', onclick: () => {
          if (who === v) return;
          who = v;
          try {
            localStorage.setItem('traffic.who', v);
          } catch {}
          drawWho();
          tick();
        } }, label)
      )
    );
  drawWho();

  const search =h('input', { type: 'search', class: 'traffic-search', placeholder: 'Filter by path, IP, country, user agent, bot…', spellcheck: 'false' });
  search.addEventListener('input', () => ((filter = search.value.trim().toLowerCase()), drawRequests()));
  const seg = h('div', { class: 'seg' });
  const drawSeg = () =>
    seg.replaceChildren(
      ...[['all', 'All'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']].map(([v, label]) =>
        h('button', { type: 'button', class: v === only ? 'on' : '', onclick: () => ((only = v), drawSeg(), drawRequests()) }, label)
      )
    );
  drawSeg();

  const showClient = (ip, focus) => data && clientDialog(ip, data, { focus, onFilter: (v) => ((client = v), drawRequests()) });
  const clientChip = h('span');

  const notice = h('div');
  const summary = h('div');
  const requests = h('div');
  const body = h('div', null, h('div', { class: 'loading' }, 'Loading…'));

  root.append(
    breadcrumbs([['Sites', () => ctx.go('domains')], [name, () => ctx.go('site', false, { name, kind })], ['Traffic']]),
    h('div', { class: 'page-head' }, h('h1', null, name), h('span', { class: 'muted page-sub' }, 'Traffic'), h('span', { class: 'spacer' }), whoSeg, kindSeg, status, pauseBtn, button('Refresh', () => tick()), button('Edit config', () => ctx.go('site', false, { name, kind })), pinBtn),
    body
  );

  function drawRequests() {
    if (!data) return;
    clientChip.replaceChildren(
      ...(client ? [h('span', { class: 'client-chip' }, 'Client ', h('span', { class: 'mono' }, client), h('button', { type: 'button', class: 'chip-x', title: 'Show all clients', onclick: () => ((client = ''), drawRequests()) }, '×'))] : [])
    );
    const rows = data.entries.filter((e) => {
      if (client && e.ip !== client) return false;
      if (only !== 'all' && String(Math.floor(e.status / 100)) !== only) return false;
      if (!filter) return true;
      const g = geo.get(e.ip);
      return `${e.method} ${e.path} ${e.ip} ${e.status} ${e.agent} ${e.referer} ${e.bot} ${g ? `${g.country} ${g.cc}` : ''}`.toLowerCase().includes(filter);
    });
    const shown = rows.slice(0, ROWS);
    requests.replaceChildren(
      table(
        ['Time', 'Client', 'Request', 'Status', 'Referrer', 'User agent'],
        shown.map((e) =>
          h(
            'tr',
            null,
            h('td', { class: 'mono muted nowrap', title: e.time ? new Date(e.time).toLocaleString() : '' }, e.time ? (data.now - e.time > 86400000 ? `${day(e.time)} ${clock(e.time)}` : clock(e.time)) : '—'),
            h('td', { class: 'mono nowrap client-cell' }, flag(e.ip), h('button', { type: 'button', class: 'link mono', title: `Drill into ${e.ip}`, onclick: () => showClient(e.ip, e) }, e.ip), e.user && h('div', { class: 'muted' }, e.user)),
            h('td', { class: 'mono req-cell', title: `${e.method} ${e.path}${e.referer ? `\nfrom ${e.referer}` : ''}` }, e.method && h('span', { class: 'method' }, e.method), ' ', e.path),
            h('td', null, badge(String(e.status), statusKind(e.status))),
            refCell(e.referer, data.domains),
            agentCell(e)
          )
        ),
        client || filter || only !== 'all' ? 'No requests match.' : 'No requests in the log yet.',
        { fit: true }
      ),
      rows.length > ROWS && h('div', { class: 'hint muted' }, `Showing the latest ${ROWS} of ${rows.length} matching requests.`)
    );
  }

  function draw(d) {
    data = d;
    const s = d.stats;
    const parts = [];
    if (d.shared) {
      const scope = h(
        'div',
        { class: 'seg' },
        [['site', 'This site'], ['all', 'Whole log']].map(([v, label]) =>
          h('button', { type: 'button', class: v === match ? 'on' : '', disabled: v === 'site' && !d.domains.length, onclick: () => { if (match !== v) { match = v; tick(); } } }, label)
        )
      );
      const text = d.grep
        ? [
            'This site has no access log of its own. Showing lines from the server-wide log ',
            h('span', { class: 'mono' }, d.path),
            ` that mention ${d.domains.join(', ')}, usually as the referring page. Direct visits with no referrer can't be matched, so the real numbers are higher.`,
          ]
        : ['This site has no access log of its own. Showing every line of the server-wide log ', h('span', { class: 'mono' }, d.path), ', including requests to other sites.'];
      parts.push(
        h(
          'div',
          { class: 'warn-box row traffic-note' },
          h('span', null, ...text),
          h('span', { class: 'spacer' }),
          scope,
          button('Give it its own log…', () => ownLog(true), 'small primary')
        )
      );
    } else if (d.canLimit) {
      parts.push(
        h(
          'div',
          { class: 'info-box row traffic-note' },
          h('span', null, d.limit ? `Own log, ${fmtBytes(d.size)} now. Rotated once it passes ${d.limit.maxSizeMb} MB, keeping ${d.limit.keep || 'no'} old cop${d.limit.keep === 1 ? 'y' : 'ies'}.` : `Own log, ${fmtBytes(d.size)} now, with no size limit.`),
          h('span', { class: 'spacer' }),
          button(d.limit ? 'Change limit…' : 'Set size limit…', () => ownLog(false), 'small')
        )
      );
    }
    if (!d.exists) parts.push(h('div', { class: 'info-box' }, 'The log file ', h('span', { class: 'mono' }, d.path), ' does not exist yet. nginx creates it with the first request after a reload.'));
    if (d.error) parts.push(h('div', { class: 'error-box' }, `Could not read ${d.path}: ${d.error}`));
    if (d.unparsed && !d.entries.length) {
      parts.push(
        h('div', { class: 'warn-box' }, `The log uses the format “${d.format}”, which this screen cannot read (it expects nginx's standard “combined” format). Last lines:`, h('pre', { class: 'output' }, d.sample.join('\n')), copyButton(() => d.sample.join('\n'), 'Copy to clipboard'))
      );
    }
    notice.replaceChildren(...parts);

    const errors = s.classes[4] + s.classes[5];
    const span = s.first && s.last ? fmtDuration(Math.max(1, (s.last - s.first) / 1000)) : '—';
    summary.replaceChildren(
      h(
        'div',
        { class: 'grid traffic-stats' },
        stat('Requests / min', s.perMinuteNow < 10 ? s.perMinuteNow.toFixed(1) : String(Math.round(s.perMinuteNow)), 'average, last 5 minutes'),
        d.pages || d.who !== 'all'
          ? stat(`${d.who === 'bots' ? 'Bot ' : d.who === 'humans' ? 'Human ' : ''}${d.pages ? 'page loads' : 'requests'}`, String(s.total), `of ${d.read} requests · last ${span}`)
          : stat('Requests', String(s.total), `last ${span} · ${fmtBytes(s.bytes)} sent`),
        stat('Visitors', String(s.uniqueIps), 'unique client IPs'),
        stat('Success', pct(s.classes[2] + s.classes[3], s.total), `${s.classes[2]} 2xx · ${s.classes[3]} 3xx`, 'text-ok'),
        stat('Errors', pct(errors, s.total), `${s.classes[4]} 4xx · ${s.classes[5]} 5xx`, s.classes[5] ? 'text-bad' : errors ? 'text-warn' : ''),
        stat('Last request', s.last ? `${fmtDuration(Math.max(0, (d.now - s.last) / 1000))} ago` : '—', s.last ? new Date(s.last).toLocaleString() : 'none in the log')
      ),
      h('div', { class: 'traffic-grid section-gap' }, h('div', { class: 'card chart-card' }, h('div', { class: 'chart-title' }, d.pages ? 'Page loads per minute' : 'Requests per minute', h('span', { class: 'muted' }, 'last hour')), rateChart(s.perMinute)), topTable(d.pages ? 'Top pages' : 'Top paths', s.topPaths, s.total), topTable('Top clients', s.topIps, s.total, true, (ip) => showClient(ip)))
    );

    if (body.querySelector('.loading')) {
      body.replaceChildren(
        notice,
        summary,
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'section-head' }, h('h2', null, 'Recent requests'), h('span', { class: 'muted mono' }, d.path), h('span', { class: 'spacer' }), clientChip, seg, search),
          requests
        )
      );
    }
    drawRequests();
    // Flags for the clients on screen; redraw once they arrive (later draws find them cached).
    const ips = [...s.topIps.map((r) => r.key), ...d.entries.map((e) => e.ip)];
    lookupGeo(ips).then((added) => added && data === d && root.isConnected && draw(d));
  }

  let again = false; // settings changed while a read was in flight: read again once it lands
  async function tick() {
    clearTimeout(timer);
    if (!root.isConnected) return;
    if (busy) return void (again = true);
    busy = true;
    again = false;
    try {
      const d = await api('nginx:traffic', { name, kind, match, pages, who });
      if (!root.isConnected) return;
      if (!again) draw(d);
      if (!paused && !again) status.replaceChildren(h('span', { class: 'dot ok' }), `Live · ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      if (!root.isConnected) return;
      status.replaceChildren(h('span', { class: 'dot bad' }), 'Update failed');
      if (!data) {
        body.replaceChildren(
          h('div', { class: 'error-box' }, e.message),
          pinned() &&
            h('div', { class: 'row section-gap' }, button('Unpin from menu', async (b) => {
              if (await act(b, () => ctx.togglePin(name, kind))) ctx.go('domains');
            }))
        );
        return;
      }
    } finally {
      busy = false;
    }
    if (again) return tick();
    if (root.isConnected && !paused) timer = setTimeout(tick, POLL_MS);
  }
  ctx.onLeave(() => clearTimeout(timer));
  tick();
}
