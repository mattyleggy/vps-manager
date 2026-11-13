import { h, api, act, button, badge, pageHead, load, fmtBytes, fmtDuration } from '../ui.js';

function stat(label, value, sub, pct, action) {
  const card = h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub && h('div', { class: 'sub' }, sub));
  if (pct != null) {
    const fill = h('div');
    fill.style.width = `${Math.min(100, Math.max(0, pct)).toFixed(0)}%`;
    card.append(h('div', { class: `bar ${pct > 90 ? 'bad' : pct > 75 ? 'warn' : ''}` }, fill));
  }
  if (action) card.append(h('div', { class: 'stat-action' }, action));
  return card;
}

export function render(root, ctx) {
  root.append(pageHead('Overview', button('Refresh', ctx.refresh)));
  if (ctx.conn.sudoOk === false) {
    root.append(
      h('div', { class: 'warn-box' }, `User "${ctx.conn.username}" does not have passwordless sudo. Managing nginx, Docker and deploys needs root: connect as root, or allow sudo without a password for this user.`)
    );
  }
  load(root, async () => {
    const s = await api('system:info');
    const memUsed = s.mem.total - s.mem.available;
    const svc = (name, label) => {
      const st = s.services[name];
      return h('div', { class: 'row' }, badge(st, st === 'active' ? 'ok' : st === 'not installed' || st === 'inactive' ? '' : 'bad'), h('span', null, label));
    };
    const pruneBuild =
      s.versions.docker &&
      button(
        'Prune Docker build cache',
        async (b) => {
          const r = await act(b, () => api('docker:pruneBuild'));
          if (r) ctx.refresh();
        },
        'small'
      );
    return [
      s.rebootRequired && h('div', { class: 'warn-box' }, 'Ubuntu reports that a reboot is required to finish installing updates.'),
      h(
        'div',
        { class: 'grid' },
        stat('Server', s.hostname, s.os),
        stat('Uptime', fmtDuration(s.uptime), `kernel ${s.kernel}`),
        stat('Load', s.load[0].toFixed(2), `${s.cpus} vCPU · 5m ${s.load[1].toFixed(2)} · 15m ${s.load[2].toFixed(2)}`, (s.load[0] / s.cpus) * 100),
        stat('Memory', fmtBytes(memUsed), `of ${fmtBytes(s.mem.total)}`, (memUsed / s.mem.total) * 100),
        stat('Disk /', fmtBytes(s.disk.used), `of ${fmtBytes(s.disk.total)} · ${fmtBytes(s.disk.free)} free`, (s.disk.used / s.disk.total) * 100, pruneBuild),
        stat('Addresses', s.ips[0] || '—', s.ips.slice(1).join(', '))
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'Services')),
        h(
          'div',
          { class: 'grid' },
          h('div', { class: 'card' }, svc('nginx', 'nginx'), h('div', { class: 'sub muted' }, s.versions.nginx || 'not installed')),
          h('div', { class: 'card' }, svc('docker', 'Docker'), h('div', { class: 'sub muted' }, s.versions.docker || 'not installed')),
          h('div', { class: 'card' }, svc('deploy-agent', 'Deploy agent'), h('div', { class: 'sub muted' }, 'GitHub webhook receiver')),
          h('div', { class: 'card' }, svc('ufw', 'Firewall (ufw)'), h('div', { class: 'sub muted' }, s.versions.certbot || 'certbot not installed'))
        )
      ),
    ];
  });
}
