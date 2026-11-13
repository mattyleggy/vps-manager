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

function topTable(title, rows, total, mono = true) {
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
            return h('div', { class: 'top-row', title: `${r.key} — ${r.count} (${pct(r.count, total)})` }, h('span', { class: mono ? 'mono top-key' : 'top-key' }, r.key), h('span', { class: 'top-bar' }, fill), h('b', null, String(r.count)));
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

  const search = h('input', { type: 'search', class: 'traffic-search', placeholder: 'Filter by path, IP, method, user agent…', spellcheck: 'false' });
  search.addEventListener('input', () => ((filter = search.value.trim().toLowerCase()), drawRequests()));
  const seg = h('div', { class: 'seg' });
  const drawSeg = () =>
    seg.replaceChildren(
      ...[['all', 'All'], ['2', '2xx'], ['3', '3xx'], ['4', '4xx'], ['5', '5xx']].map(([v, label]) =>
        h('button', { type: 'button', class: v === only ? 'on' : '', onclick: () => ((only = v), drawSeg(), drawRequests()) }, label)
      )
    );
  drawSeg();

  const notice = h('div');
  const summary = h('div');
  const requests = h('div');
  const body = h('div', null, h('div', { class: 'loading' }, 'Loading…'));

  root.append(
    breadcrumbs([['Sites', () => ctx.go('domains')], [name, () => ctx.go('site', false, { name, kind })], ['Traffic']]),
    h('div', { class: 'page-head' }, h('h1', null, name), h('span', { class: 'muted page-sub' }, 'Traffic'), h('span', { class: 'spacer' }), status, pauseBtn, button('Refresh', () => tick()), button('Edit config', () => ctx.go('site', false, { name, kind })), pinBtn),
    body
  );

  function drawRequests() {
    if (!data) return;
    const rows = data.entries.filter((e) => {
      if (only !== 'all' && String(Math.floor(e.status / 100)) !== only) return false;
      if (!filter) return true;
      return `${e.method} ${e.path} ${e.ip} ${e.status} ${e.agent} ${e.referer}`.toLowerCase().includes(filter);
    });
    const shown = rows.slice(0, ROWS);
    requests.replaceChildren(
      table(
        ['Time', 'Client', 'Request', 'Status', 'Size', 'User agent'],
        shown.map((e) =>
          h(
            'tr',
            null,
            h('td', { class: 'mono muted nowrap', title: e.time ? new Date(e.time).toLocaleString() : '' }, e.time ? (data.now - e.time > 86400000 ? `${day(e.time)} ${clock(e.time)}` : clock(e.time)) : '—'),
            h('td', { class: 'mono nowrap' }, e.ip, e.user && h('div', { class: 'muted' }, e.user)),
            h('td', { class: 'mono req-cell', title: `${e.method} ${e.path}${e.referer ? `\nfrom ${e.referer}` : ''}` }, e.method && h('span', { class: 'method' }, e.method), ' ', e.path),
            h('td', null, badge(String(e.status), statusKind(e.status))),
            h('td', { class: 'muted nowrap' }, fmtBytes(e.bytes)),
            h('td', { class: 'muted ua-cell', title: e.agent }, e.agent || '—')
          )
        ),
        filter || only !== 'all' ? 'No requests match.' : 'No requests in the log yet.',
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
        stat('Requests', String(s.total), `last ${span} · ${fmtBytes(s.bytes)} sent`),
        stat('Visitors', String(s.uniqueIps), 'unique client IPs'),
        stat('Success', pct(s.classes[2] + s.classes[3], s.total), `${s.classes[2]} 2xx · ${s.classes[3]} 3xx`, 'text-ok'),
        stat('Errors', pct(errors, s.total), `${s.classes[4]} 4xx · ${s.classes[5]} 5xx`, s.classes[5] ? 'text-bad' : errors ? 'text-warn' : ''),
        stat('Last request', s.last ? `${fmtDuration(Math.max(0, (d.now - s.last) / 1000))} ago` : '—', s.last ? new Date(s.last).toLocaleString() : 'none in the log')
      ),
      h('div', { class: 'traffic-grid section-gap' }, h('div', { class: 'card chart-card' }, h('div', { class: 'chart-title' }, 'Requests per minute', h('span', { class: 'muted' }, 'last hour')), rateChart(s.perMinute)), topTable('Top paths', s.topPaths, s.total), topTable('Top clients', s.topIps, s.total))
    );

    if (body.querySelector('.loading')) {
      body.replaceChildren(
        notice,
        summary,
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'section-head' }, h('h2', null, 'Recent requests'), h('span', { class: 'muted mono' }, d.path), h('span', { class: 'spacer' }), seg, search),
          requests
        )
      );
    }
    drawRequests();
  }

  async function tick() {
    clearTimeout(timer);
    if (!root.isConnected || busy) return;
    busy = true;
    try {
      const d = await api('nginx:traffic', { name, kind, match });
      if (!root.isConnected) return;
      draw(d);
      if (!paused) status.replaceChildren(h('span', { class: 'dot ok' }), `Live · ${new Date().toLocaleTimeString()}`);
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
    if (root.isConnected && !paused) timer = setTimeout(tick, POLL_MS);
  }
  ctx.onLeave(() => clearTimeout(timer));
  tick();
}
