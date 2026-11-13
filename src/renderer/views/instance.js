import { h, api, act, toast, button, badge, pageHead, table, load, fmtBytes, select } from '../ui.js';

// The Instance screen: what Vultr knows about the machine (plan, billing, bandwidth, backups,
// firewall) plus CPU, memory, network and disk graphs read from the server over SSH: the
// last 24 hours from sysstat, or live. Vultr's API has no CPU or disk history for instances,
// only daily bandwidth.

const SAMPLE_MS = 3000;
const LIVE_SPAN = 180; // seconds of live history shown
const PICK_KEY = 'instance.pick';
const NS = 'http://www.w3.org/2000/svg';

const money = (n) => (n == null || n === '' ? '—' : `$${Number(n).toFixed(2)}`);
const date = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const dateTime = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const rate = (n) => `${fmtBytes(Math.max(0, n))}/s`;
const pct = (n) => `${Math.max(0, n).toFixed(1)}%`;
const statusKind = (s) => (['active', 'running', 'ok', 'complete', 'completed', 'accept'].includes(String(s).toLowerCase()) ? 'ok' : ['pending', 'locked', 'installingbooting', 'resizing'].includes(String(s).toLowerCase()) ? 'warn' : ['stopped', 'suspended', 'drop', 'failed'].includes(String(s).toLowerCase()) ? 'bad' : '');

function readPick() {
  try {
    return localStorage.getItem(PICK_KEY) || '';
  } catch {
    return '';
  }
}
function savePick(id) {
  try {
    if (id) localStorage.setItem(PICK_KEY, id);
    else localStorage.removeItem(PICK_KEY);
  } catch {
    /* per-viewer convenience only */
  }
}

function svg(tag, attrs) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

/**
 * A line chart over time, drawn as SVG. update({ t, series, domain, gap }):
 *   t       sample times (seconds), shared by every series
 *   series  [{ label, color, values }] - one value per entry of t
 *   domain  [from, to] in seconds: the span the x axis covers
 *   gap     a jump between samples longer than this (seconds) breaks the line (server down)
 * max: fixed top of the scale (100 for percentages) or null to fit the data. Hovering shows the
 * values at that moment in the legend.
 */
function lineChart({ max = null, format = (v) => String(v), height = 120 }) {
  const W = 600;
  const H = height;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'chart-svg', role: 'img' });
  const grid = svg('g', { class: 'chart-grid' });
  for (const y of [0.25, 0.5, 0.75]) grid.append(svg('line', { x1: 0, x2: W, y1: H * y, y2: H * y }));
  root.append(grid);
  const layer = svg('g');
  const cursor = svg('line', { y1: 0, y2: H, class: 'chart-cursor', visibility: 'hidden' });
  root.append(layer, cursor);
  const scale = h('div', { class: 'chart-scale' });
  const axis = h('div', { class: 'chart-axis' });
  const legend = h('div', { class: 'chart-legend' });
  const plot = h('div', { class: 'chart-plot' }, root, scale);
  const el = h('div', { class: 'chart' }, plot, axis, legend);
  let last = null;
  let hover = null; // index of the sample under the mouse

  const clock = (sec, span) => new Date(sec * 1000).toLocaleTimeString([], span > 3600 ? { hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function drawLegend() {
    if (!last) return;
    const { t, series, domain } = last;
    const i = hover != null ? hover : t.length - 1;
    const keys = series.map((s) => h('span', { class: 'chart-key' }, h('i', { style: `background:${s.color}` }), `${s.label} `, h('b', null, i >= 0 && s.values[i] != null ? format(s.values[i]) : '—')));
    if (hover != null) keys.push(h('span', { class: 'chart-at' }, `at ${clock(t[i], domain[1] - domain[0])}`));
    legend.replaceChildren(...keys);
  }

  function update(data) {
    last = data;
    const { t, series, domain, gap } = data;
    const [t0, t1] = domain;
    const span = Math.max(1, t1 - t0);
    const top = max != null ? max : Math.max(1e-9, ...series.flatMap((s) => s.values)) * 1.15 || 1;
    scale.textContent = format(top);
    const x = (sec) => ((sec - t0) / span) * W;
    const y = (v) => H - (Math.min(Math.max(v, 0), top) / top) * (H - 4) - 2;
    layer.replaceChildren();
    // Split the samples into runs with no gap longer than `gap`.
    const runs = [];
    let run = [];
    t.forEach((sec, i) => {
      if (sec < t0) return;
      if (run.length && sec - t[run[run.length - 1]] > gap) {
        runs.push(run);
        run = [];
      }
      run.push(i);
    });
    if (run.length) runs.push(run);
    for (const s of series) {
      for (const r of runs) {
        if (r.length < 2) continue;
        const d = r.map((i, k) => `${k ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(s.values[i]).toFixed(1)}`).join('');
        layer.append(
          svg('path', { d: `${d}L${x(t[r[r.length - 1]]).toFixed(1)},${H}L${x(t[r[0]]).toFixed(1)},${H}Z`, fill: s.color, 'fill-opacity': '0.10', stroke: 'none' }),
          svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': '1.6', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' })
        );
      }
    }
    const ticks = span > 3600 ? 5 : 3;
    axis.replaceChildren(...Array.from({ length: ticks }, (_, k) => h('span', null, k === ticks - 1 && t1 >= Date.now() / 1000 - 5 ? 'now' : clock(t0 + (span * k) / (ticks - 1), span))));
    if (hover != null && hover >= t.length) hover = null;
    drawLegend();
  }

  plot.addEventListener('mousemove', (e) => {
    if (!last || !last.t.length) return;
    const rect = plot.getBoundingClientRect();
    const [t0, t1] = last.domain;
    const at = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    last.t.forEach((sec, i) => {
      if (Math.abs(sec - at) < Math.abs(last.t[best] - at)) best = i;
    });
    hover = best;
    const cx = ((last.t[best] - t0) / (t1 - t0)) * W;
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    cursor.setAttribute('visibility', 'visible');
    drawLegend();
  });
  plot.addEventListener('mouseleave', () => {
    hover = null;
    cursor.setAttribute('visibility', 'hidden');
    drawLegend();
  });
  return { el, update };
}

/** Daily bandwidth as paired bars (in / out), with a hover title per day. */
function bandwidthChart(days) {
  const W = 600;
  const H = 160;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'chart-svg tall', role: 'img' });
  const grid = svg('g', { class: 'chart-grid' });
  for (const y of [0.25, 0.5, 0.75]) grid.append(svg('line', { x1: 0, x2: W, y1: H * y, y2: H * y }));
  root.append(grid);
  const top = Math.max(1, ...days.flatMap((d) => [d.in, d.out])) * 1.1;
  const slot = W / Math.max(days.length, 1);
  const bw = Math.max(1, slot / 2 - 1.5);
  days.forEach((d, i) => {
    const x = i * slot + 1;
    const g = svg('g');
    const title = svg('title');
    title.textContent = `${d.date}: in ${fmtBytes(d.in)}, out ${fmtBytes(d.out)}`;
    const hIn = (d.in / top) * (H - 2);
    const hOut = (d.out / top) * (H - 2);
    g.append(
      title,
      svg('rect', { x: 0 + x, y: H - hIn, width: bw, height: hIn, fill: 'var(--accent-2)', rx: 1.5 }),
      svg('rect', { x: x + bw + 1, y: H - hOut, width: bw, height: hOut, fill: 'var(--accent)', rx: 1.5 }),
      svg('rect', { x: i * slot, y: 0, width: slot, height: H, fill: 'transparent' })
    );
    root.append(g);
  });
  const first = days[0];
  const last = days[days.length - 1];
  return h(
    'div',
    { class: 'chart' },
    h('div', { class: 'chart-plot' }, root, h('div', { class: 'chart-scale' }, fmtBytes(top))),
    h('div', { class: 'chart-axis' }, h('span', null, first ? date(first.date) : ''), h('span', null, last ? date(last.date) : '')),
    h('div', { class: 'chart-legend' }, h('span', { class: 'chart-key' }, h('i', { style: 'background:var(--accent-2)' }), 'Inbound'), h('span', { class: 'chart-key' }, h('i', { style: 'background:var(--accent)' }), 'Outbound'))
  );
}

function stat(label, value, sub, fill) {
  const card = h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub && h('div', { class: 'sub' }, sub));
  if (fill != null) {
    const f = h('div');
    f.style.width = `${Math.min(100, Math.max(0, fill)).toFixed(0)}%`;
    card.append(h('div', { class: `bar ${fill > 90 ? 'bad' : fill > 75 ? 'warn' : ''}` }, f));
  }
  return card;
}

const section = (title, ...kids) => h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title)), kids);
const kv = (pairs) =>
  h(
    'div',
    { class: 'kv' },
    pairs.filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => [h('div', { class: 'k' }, k), h('div', { class: 'mono' }, Array.isArray(v) ? v.join(', ') : v)])
  );

// ------------------------------------------------------------------ usage graphs (SSH)
// "24 hours" reads sysstat's history on the server (refreshed every 2 minutes while shown);
// "Live" samples the kernel counters every few seconds from here.

const KEYS = ['cpu', 'iowait', 'steal', 'mem', 'swap', 'rx', 'tx', 'rd', 'wr', 'rio', 'wio', 'l1'];
const RANGE_KEY = 'instance.range';
const DAY = 24 * 3600;
const HISTORY_REFRESH_MS = 120000;

function readRange() {
  try {
    return localStorage.getItem(RANGE_KEY) === 'live' ? 'live' : '24h';
  } catch {
    return '24h';
  }
}
function saveRange(v) {
  try {
    localStorage.setItem(RANGE_KEY, v);
  } catch {
    /* per-viewer convenience only */
  }
}

function usageSection(ctx) {
  const ops = (v) => `${v.toFixed(v < 10 ? 1 : 0)}/s`;
  const charts = {
    cpu: lineChart({ max: 100, format: pct }),
    mem: lineChart({ max: 100, format: pct }),
    net: lineChart({ format: rate }),
    disk: lineChart({ format: rate }),
    iops: lineChart({ format: ops }),
    load: lineChart({ format: (v) => v.toFixed(2) }),
  };
  const notes = Object.fromEntries(Object.keys(charts).map((k) => [k, h('span', { class: 'muted' })]));
  const status = h('span', { class: 'muted live-status' });
  const banner = h('div');
  let range = readRange();
  let timer = null;
  let gen = 0; // bumps on every mode switch so a late reply from the old mode is ignored

  const peak = (vals, t, fmt) => {
    if (!vals.length) return '';
    let i = 0;
    vals.forEach((v, k) => v > vals[i] && (i = k));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return `avg ${fmt(avg)} · peak ${fmt(vals[i])} at ${new Date(t[i] * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  };

  const pre = (label, text) => (text ? label + ' ' + text : '');

  /** Draw every chart from { t, cpu, iowait, ... } over [from, to]. */
  function draw(p, domain, gap, cpus) {
    const t = p.t;
    const hasSwap = p.swap.some((v) => v > 0);
    charts.cpu.update({ t, domain, gap, series: [{ label: 'Used', color: 'var(--accent)', values: p.cpu }, { label: 'I/O wait', color: 'var(--warn)', values: p.iowait }, { label: 'Steal', color: 'var(--bad)', values: p.steal }] });
    charts.mem.update({ t, domain, gap, series: [{ label: 'RAM', color: 'var(--accent-2)', values: p.mem }, ...(hasSwap ? [{ label: 'Swap', color: 'var(--warn)', values: p.swap }] : [])] });
    charts.net.update({ t, domain, gap, series: [{ label: 'In', color: 'var(--accent-2)', values: p.rx }, { label: 'Out', color: 'var(--accent)', values: p.tx }] });
    charts.disk.update({ t, domain, gap, series: [{ label: 'Read', color: 'var(--ok)', values: p.rd }, { label: 'Write', color: 'var(--warn)', values: p.wr }] });
    charts.iops.update({ t, domain, gap, series: [{ label: 'Read ops', color: 'var(--ok)', values: p.rio }, { label: 'Write ops', color: 'var(--warn)', values: p.wio }] });
    charts.load.update({ t, domain, gap, series: [{ label: `1 min${cpus ? ` (${cpus} vCPU)` : ''}`, color: 'var(--info)', values: p.l1 }] });
    if (range === '24h') {
      notes.cpu.textContent = peak(p.cpu, t, pct);
      notes.mem.textContent = peak(p.mem, t, pct);
      notes.net.textContent = pre('out', peak(p.tx, t, rate));
      notes.disk.textContent = pre('write', peak(p.wr, t, rate));
      notes.iops.textContent = pre('write', peak(p.wio, t, ops));
      notes.load.textContent = peak(p.l1, t, (v) => v.toFixed(2));
    } else {
      notes.cpu.textContent = 'steal = time taken by the host';
      notes.net.textContent = 'excluding loopback and Docker bridges';
      notes.mem.textContent = notes.disk.textContent = notes.iops.textContent = notes.load.textContent = '';
    }
  }

  const empty = () => Object.fromEntries(['t', ...KEYS].map((k) => [k, []]));

  function enableButton(label) {
    return button(
      label,
      async (b) => {
        const r = await act(b, () => api('system:enableHistory'));
        if (r && r.code === 0) {
          toast('sysstat is recording. The graphs fill in over the next few minutes.', 'ok');
          ctx.refresh();
        }
      },
      'primary'
    );
  }

  // ---- 24 hours ----
  async function history(my) {
    try {
      const r = await api('system:history');
      if (my !== gen) return;
      const p = { ...empty(), ...r.points };
      const now = Date.now() / 1000;
      const gap = Math.max(300, (r.interval || 600) * 2.5);
      draw(p, [now - DAY, now], gap, r.cpus);
      const n = p.t.length;
      if (!r.installed || !r.enabled) {
        banner.replaceChildren(
          h(
            'div',
            { class: 'card history-setup' },
            h('div', null, h('b', null, 'No usage history is being recorded on this server. '), 'Ubuntu’s sysstat package can keep a sample every 2 minutes (about a month of files in /var/log/sysstat, a few MB). Until then, switch to Live to watch the server now.'),
            enableButton(r.installed ? 'Turn on history' : 'Install sysstat and keep history')
          )
        );
      } else if (!r.collecting) {
        banner.replaceChildren(h('div', { class: 'warn-box history-setup' }, h('span', null, 'sysstat is installed but its collector timer is not running, so the history has stopped.'), enableButton('Restart collection')));
      } else {
        banner.replaceChildren();
      }
      status.textContent = n
        ? `${n} samples · every ${Math.round((r.interval || 600) / 60)} min · since ${new Date(p.t[0] * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
        : r.installed && r.enabled
          ? 'No samples yet. The first ones appear within a few minutes.'
          : '';
    } catch (e) {
      if (my !== gen) return;
      status.textContent = `Could not read the history: ${e.message}`;
    }
    if (my === gen) timer = setTimeout(() => history(my), HISTORY_REFRESH_MS);
  }

  // ---- live ----
  function live(my) {
    const p = empty();
    let prev = null;
    let cpus = null;
    const tick = async () => {
      try {
        const s = await api('system:sample');
        if (my !== gen) return;
        cpus = s.cpus;
        if (prev) {
          const dt = Math.max(0.1, s.t - prev.t);
          const sum = (a) => a.reduce((x, y) => x + y, 0);
          const total = sum(s.cpu) - sum(prev.cpu) || 1;
          const idle = s.cpu[3] + (s.cpu[4] || 0) - (prev.cpu[3] + (prev.cpu[4] || 0));
          const d = (i) => (((s.cpu[i] || 0) - (prev.cpu[i] || 0)) / total) * 100;
          const row = {
            cpu: (1 - idle / total) * 100,
            iowait: d(4),
            steal: d(7),
            mem: ((s.mem.total - s.mem.available) / s.mem.total) * 100,
            swap: s.mem.swapTotal ? ((s.mem.swapTotal - s.mem.swapFree) / s.mem.swapTotal) * 100 : 0,
            rx: (s.net.rx - prev.net.rx) / dt,
            tx: (s.net.tx - prev.net.tx) / dt,
            rd: (s.disk.readBytes - prev.disk.readBytes) / dt,
            wr: (s.disk.writeBytes - prev.disk.writeBytes) / dt,
            rio: (s.disk.reads - prev.disk.reads) / dt,
            wio: (s.disk.writes - prev.disk.writes) / dt,
            l1: s.load[0],
          };
          p.t.push(s.t);
          // A counter reset (interface restarted, say) gives a negative rate: show it as 0.
          for (const k of KEYS) p[k].push(Number.isFinite(row[k]) ? Math.max(0, row[k]) : 0);
          while (p.t.length && p.t[0] < s.t - LIVE_SPAN) for (const k of ['t', ...KEYS]) p[k].shift();
          const ps = s.psi || {};
          const psi = ['cpu', 'memory', 'io'].filter((k) => ps[k] != null).map((k) => `${k} ${ps[k].toFixed(1)}%`);
          status.textContent = `Every ${SAMPLE_MS / 1000}s · ${new Date().toLocaleTimeString()}${psi.length ? ` · pressure ${psi.join(', ')}` : ''}`;
        } else {
          status.textContent = 'Collecting…';
        }
        draw(p, [s.t - LIVE_SPAN, s.t], (SAMPLE_MS / 1000) * 4, cpus);
        prev = s;
      } catch (e) {
        if (my !== gen) return;
        status.textContent = `Sampling failed: ${e.message}`;
      }
      if (my === gen) timer = setTimeout(tick, SAMPLE_MS);
    };
    tick();
  }

  const tabs = h('div', { class: 'seg', role: 'tablist' });
  function start(mode) {
    range = mode;
    saveRange(mode);
    clearTimeout(timer);
    const my = ++gen;
    banner.replaceChildren();
    status.textContent = 'Loading…';
    const now = Date.now() / 1000;
    draw(empty(), mode === 'live' ? [now - LIVE_SPAN, now] : [now - DAY, now], 1, null);
    tabs.replaceChildren(
      ...[
        ['24h', '24 hours'],
        ['live', 'Live'],
      ].map(([id, label]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(id === mode), class: id === mode ? 'on' : '', onclick: () => id !== range && start(id) }, label))
    );
    if (mode === 'live') live(my);
    else history(my);
  }
  ctx.onLeave(() => {
    gen++;
    clearTimeout(timer);
  });

  const card = (title, key) => h('div', { class: 'card chart-card' }, h('div', { class: 'chart-title' }, h('span', { class: 'chart-name' }, title), notes[key]), charts[key].el);
  const el = h(
    'div',
    { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', null, 'Usage'), tabs, status),
    banner,
    h('div', { class: 'chart-grid-cards' }, card('CPU', 'cpu'), card('Memory', 'mem'), card('Network', 'net'), card('Disk throughput', 'disk'), card('Disk operations', 'iops'), card('Load average', 'load'))
  );
  start(range);
  return el;
}

// ------------------------------------------------------------------ Vultr

function picker(instances, current, ctx) {
  const sel = select([['', 'Match this server by IP'], ...instances.map((i) => [i.id, `${i.label || i.hostname || i.id} · ${i.main_ip} · ${i.region}`])], current);
  sel.addEventListener('change', () => {
    savePick(sel.value);
    ctx.refresh();
  });
  return sel;
}

function vultrSections(r, ctx) {
  const i = r.instance;
  const plan = r.plan || {};
  const region = r.region || {};
  const out = [];
  const errs = Object.entries(r.errors || {});

  const bwThisMonth = (() => {
    const month = new Date().toISOString().slice(0, 7);
    return r.bandwidth.filter((d) => d.date.startsWith(month)).reduce((a, d) => a + d.in + d.out, 0);
  })();
  const bwTotal = r.bandwidth.reduce((a, d) => ({ in: a.in + d.in, out: a.out + d.out }), { in: 0, out: 0 });
  const allowGB = Number(i.allowed_bandwidth) || Number(plan.bandwidth) || 0;
  const outThisMonth = r.bandwidth.filter((d) => d.date.startsWith(new Date().toISOString().slice(0, 7))).reduce((a, d) => a + d.out, 0);
  const balance = r.account ? Number(r.account.balance) : null;
  const pendingTotal = (r.pendingCharges || []).reduce((a, c) => a + (Number(c.total) || 0), 0);

  out.push(
    h(
      'div',
      { class: 'row instance-badges' },
      badge(`status ${i.status}`, statusKind(i.status)),
      badge(`power ${i.power_status}`, statusKind(i.power_status)),
      badge(`server ${i.server_status}`, statusKind(i.server_status)),
      (i.tags || []).map((t) => badge(t, 'info'))
    ),
    h(
      'div',
      { class: 'grid' },
      stat('Instance', i.label || i.hostname || i.id, `${i.hostname || ''}${i.hostname ? ' · ' : ''}created ${date(i.date_created)}`),
      stat('Plan', i.plan, `${i.vcpu_count} vCPU · ${fmtBytes(i.ram * 1024 * 1024)} RAM · ${i.disk} GB disk${plan.type ? ` · ${plan.type}` : ''}`),
      stat('Location', region.city ? `${region.city}` : i.region, [region.country, region.continent, i.region].filter(Boolean).join(' · ')),
      stat('Operating system', i.os || '—', i.os_id ? `os id ${i.os_id}` : null),
      stat('Monthly cost', plan.monthly_cost != null ? money(plan.monthly_cost) : '—', plan.hourly_cost != null ? `${money(plan.hourly_cost)}/h` : 'from the plan price list'),
      allowGB
        ? stat('Outbound this month', fmtBytes(outThisMonth), `of ${allowGB} GB allowance · ${fmtBytes(bwThisMonth)} in+out`, (outThisMonth / (allowGB * 1024 ** 3)) * 100)
        : stat('Traffic this month', fmtBytes(bwThisMonth), 'in + out'),
      r.account &&
        stat(
          'Account balance',
          balance < 0 ? `${money(-balance)} credit` : money(balance),
          `pending charges ${money(r.account.pending_charges)}${r.account.last_payment_date ? ` · last paid ${money(r.account.last_payment_amount)} on ${date(r.account.last_payment_date)}` : ''}`
        ),
      r.neighbors && stat('Neighbours', String(r.neighbors.length), 'your other instances on the same physical host')
    )
  );

  if (errs.length) {
    out.push(h('div', { class: 'warn-box section-gap' }, 'Some details could not be loaded: ', errs.map(([k, v]) => `${k}: ${v}`).join(' · ')));
  }

  // Bandwidth
  out.push(
    section(
      'Bandwidth (daily, from Vultr)',
      r.bandwidth.length
        ? h(
            'div',
            { class: 'card' },
            bandwidthChart(r.bandwidth),
            h('div', { class: 'sub muted' }, `${r.bandwidth.length} days · in ${fmtBytes(bwTotal.in)} · out ${fmtBytes(bwTotal.out)} · avg ${fmtBytes((bwTotal.in + bwTotal.out) / r.bandwidth.length)}/day`)
          )
        : h('div', { class: 'card muted' }, 'Vultr has no bandwidth figures for this instance yet.')
    )
  );

  // Network
  out.push(
    section(
      'Network',
      h(
        'div',
        { class: 'card' },
        kv([
          ['Main IPv4', i.main_ip],
          ['Netmask / gateway', i.netmask_v4 && `${i.netmask_v4} · ${i.gateway_v4}`],
          ['Main IPv6', i.v6_main_ip],
          ['IPv6 network', i.v6_network && `${i.v6_network}/${i.v6_network_size}`],
          ['Private IP', i.internal_ip],
          ['Features', i.features],
          ['VPCs', [...(i.vpcs || []), ...(i.vpc2s || [])].map((v) => (typeof v === 'string' ? v : v.id))],
        ])
      ),
      r.ipv4 && r.ipv4.length > 0 && table(['IPv4', 'Type', 'Gateway', 'Reverse DNS'], r.ipv4.map((a) => h('tr', null, h('td', { class: 'mono' }, a.ip), h('td', null, a.type), h('td', { class: 'mono' }, a.gateway), h('td', { class: 'mono' }, a.reverse || '—'))), ''),
      r.ipv6 && r.ipv6.length > 0 && table(['IPv6', 'Type', 'Network'], r.ipv6.map((a) => h('tr', null, h('td', { class: 'mono' }, a.ip), h('td', null, a.type), h('td', { class: 'mono' }, `${a.network}/${a.network_size}`))), '')
    )
  );

  // Firewall
  out.push(
    section(
      'Vultr firewall',
      r.firewall
        ? [
            h('div', { class: 'card' }, kv([['Group', r.firewall.group.description || r.firewall.group.id], ['Rules', String(r.firewall.group.rule_count)], ['Instances', String(r.firewall.group.instance_count)], ['Updated', dateTime(r.firewall.group.date_modified)]])),
            table(
              ['Action', 'IP', 'Protocol', 'Port', 'Source', 'Notes'],
              r.firewall.rules.map((x) =>
                h('tr', null, h('td', null, badge(x.action, statusKind(x.action))), h('td', null, x.ip_type), h('td', null, x.protocol), h('td', { class: 'mono' }, x.port || 'all'), h('td', { class: 'mono' }, x.source || `${x.subnet}/${x.subnet_size}`), h('td', { class: 'muted' }, x.notes || ''))
              ),
              'This group has no rules.'
            ),
          ]
        : h('div', { class: 'card muted' }, 'No Vultr firewall group is attached; only the firewall on the server itself (ufw) applies.')
    )
  );

  // Backups & snapshots
  const sch = r.backupSchedule;
  const DOW = ['', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  out.push(
    section(
      'Backups and snapshots',
      h(
        'div',
        { class: 'card' },
        sch && sch.enabled
          ? kv([
              ['Automatic backups', `${sch.type}${sch.hour != null ? ` at ${String(sch.hour).padStart(2, '0')}:00 UTC` : ''}${sch.type === 'weekly' && sch.dow ? ` on ${DOW[sch.dow]}` : ''}${sch.type === 'monthly' && sch.dom ? ` on day ${sch.dom}` : ''}`],
              ['Next backup', dateTime(sch.next_scheduled_time_utc)],
            ])
          : h('div', { class: 'muted' }, 'Automatic backups are off for this instance.')
      ),
      table(
        ['Backup', 'Created', 'Size', 'Status'],
        (r.backups || []).map((b) => h('tr', null, h('td', null, b.description || b.id), h('td', null, dateTime(b.date_created)), h('td', null, fmtBytes(b.size)), h('td', null, badge(b.status, statusKind(b.status))))),
        'No backups of this instance.'
      ),
      h('div', { class: 'section-gap' }),
      table(
        ['Snapshot (whole account)', 'Created', 'Size', 'Status'],
        (r.snapshots || []).map((s) => h('tr', null, h('td', null, s.description || s.id), h('td', null, dateTime(s.date_created)), h('td', null, fmtBytes(s.compressed_size || s.size)), h('td', null, badge(s.status, statusKind(s.status))))),
        'No snapshots on the account.'
      )
    )
  );

  // Billing
  if (r.pendingCharges && r.pendingCharges.length) {
    out.push(
      section(
        'Pending charges (whole account)',
        table(
          ['Item', 'Period', 'Units', 'Total'],
          r.pendingCharges.map((c) => h('tr', null, h('td', null, c.description), h('td', { class: 'muted' }, `${date(c.start_date)} – ${date(c.end_date)}`), h('td', null, `${c.units} ${c.unit_type || ''}`), h('td', null, money(c.total)))),
          ''
        ),
        h('div', { class: 'sub muted' }, `Total ${money(pendingTotal)}`)
      )
    );
  }

  // Everything else the API returned
  const raw = Object.entries(i).filter(([k, v]) => v != null && v !== '' && typeof v !== 'object' && k !== 'kvm');
  out.push(
    h(
      'details',
      { class: 'section raw-details' },
      h('summary', null, 'All instance fields from the Vultr API'),
      h('div', { class: 'card' }, kv(raw.map(([k, v]) => [k, String(v)])))
    )
  );
  return out;
}

export function render(root, ctx) {
  const pick = readPick();
  const head = pageHead('Instance', button('Refresh', ctx.refresh));
  root.append(head);
  root.append(usageSection(ctx));
  const vultrBox = h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Vultr')));
  root.append(vultrBox);
  load(vultrBox, async () => {
    const r = await api('vultr:instance', pick ? { id: pick } : {});
    if (!r.hasKey) {
      return h('div', { class: 'card empty-state' }, h('div', { class: 'empty-title' }, 'No Vultr API key'), h('div', { class: 'field muted' }, 'Save a Vultr API key to see the plan, billing, bandwidth, backups and firewall of this instance.'), button('Open Settings', () => ctx.go('settings'), 'primary'));
    }
    if (!r.matched) {
      if (pick) savePick('');
      return h(
        'div',
        { class: 'card' },
        h('div', { class: 'field' }, pick ? 'The chosen instance is no longer on the account.' : 'None of the instances on your Vultr account has this server’s IP address. Pick the one this is:'),
        r.instances.length ? picker(r.instances, '', ctx) : h('div', { class: 'muted' }, 'There are no instances on this Vultr account.')
      );
    }
    const i = r.instance;
    head.append(
      i.kvm && button('Open console', () => api('open:external', i.kvm).catch(() => {})),
      button('Open in Vultr', () => api('open:external', `https://my.vultr.com/subs/?id=${encodeURIComponent(i.id)}`).catch(() => {}))
    );
    return [r.instances.length > 1 && h('div', { class: 'field instance-pick' }, picker(r.instances, pick, ctx)), ...vultrSections(r, ctx)];
  });
}
