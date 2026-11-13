import { h, api, act, button, badge, pageHead, table, load, showOutput } from '../ui.js';

const stateBadge = (c) => badge(c.status || c.state, c.state === 'running' ? 'ok' : c.state === 'restarting' ? 'warn' : c.state === 'exited' ? '' : 'bad');

function containerRow(c, ctx) {
  const doIt = (label, action, cls) =>
    button(
      label,
      async (b) => {
        await act(b, () => api('docker:container', { name: c.name, action }), `${c.name}: ${action} done`);
        ctx.refresh();
      },
      `small ${cls || ''}`
    );
  return h(
    'tr',
    null,
    h('td', null, h('div', null, c.service || c.name), c.service && h('div', { class: 'muted mono' }, c.name)),
    h('td', { class: 'mono' }, c.image),
    h('td', null, stateBadge(c)),
    h('td', { class: 'mono muted' }, c.ports || '—'),
    h(
      'td',
      { class: 'actions' },
      button('Logs', (b) => act(b, async () => showOutput(`Logs: ${c.name}`, await api('docker:logs', { name: c.name }))), 'small'),
      c.state === 'running' ? doIt('Restart', 'restart') : doIt('Start', 'start'),
      c.state === 'running' && doIt('Stop', 'stop', 'danger')
    )
  );
}

const HEADERS = ['Container', 'Image', 'State', 'Ports', ''];

export function render(root, ctx) {
  root.append(
    pageHead(
      'Docker',
      button('Prune unused', async (b) => {
        await act(b, () => api('docker:prune'));
        ctx.refresh();
      }),
      button('Refresh', ctx.refresh)
    )
  );
  load(root, async () => {
    const d = await api('docker:list');
    if (!d.installed) return h('div', { class: 'info-box' }, 'Docker is not installed on this server.');

    const out = [];
    if (d.df.length) {
      out.push(h('div', { class: 'row' }, d.df.map((x) => badge(`${x.Type}: ${x.Size}${x.Reclaimable ? ` (${x.Reclaimable} reclaimable)` : ''}`))));
    }

    for (const p of d.projects) {
      const mine = d.containers.filter((c) => c.project === p.name);
      const compose = (label, action, cls) =>
        button(
          label,
          async (b) => {
            await act(b, () => api('docker:compose', { project: p.name, action }));
            if (action !== 'logs') ctx.refresh();
          },
          `small ${cls || ''}`
        );
      out.push(
        h(
          'div',
          { class: 'section' },
          h(
            'div',
            { class: 'section-head' },
            h('h2', null, p.name),
            badge(p.status, /running/.test(p.status) ? 'ok' : ''),
            h('span', { class: 'muted mono' }, p.configFiles.join(', ')),
            h('span', { class: 'spacer' }),
            compose('Rebuild', 'rebuild', 'primary'),
            compose('Pull & recreate', 'pull'),
            compose('Restart', 'restart'),
            compose('Logs', 'logs'),
            /running/.test(p.status) ? compose('Stop', 'stop', 'danger') : compose('Start', 'start')
          ),
          table(HEADERS, mine.map((c) => containerRow(c, ctx)), 'No containers.')
        )
      );
    }

    const known = new Set(d.projects.map((p) => p.name));
    const loose = d.containers.filter((c) => !c.project || !known.has(c.project));
    if (loose.length || !d.projects.length) {
      out.push(
        h(
          'div',
          { class: 'section' },
          h('div', { class: 'section-head' }, h('h2', null, 'Standalone containers')),
          table(HEADERS, loose.map((c) => containerRow(c, ctx)), 'No containers on this server.')
        )
      );
    }
    return out;
  });
}
