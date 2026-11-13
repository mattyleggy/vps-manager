import { h, api, act, button, badge, pageHead, table, load, timeAgo } from '../ui.js';

// Server patches: the apt updates waiting to be installed (security ones first), whether a
// reboot is pending, and whether unattended-upgrades applies security fixes by itself.

const STALE_SEC = 24 * 3600;

function stat(label, value, sub, kind, action) {
  return h(
    'div',
    { class: 'card stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${kind ? `text-${kind}` : ''}` }, value),
    sub && h('div', { class: 'sub' }, sub),
    action && h('div', { class: 'stat-action' }, action)
  );
}

const cveLink = (src) =>
  h('button', { type: 'button', class: 'link', title: 'Ubuntu security notices for this package', onclick: () => api('open:external', `https://ubuntu.com/security/cves?package=${encodeURIComponent(src)}`).catch(() => {}) }, src);

function updateRow(u, kept) {
  return h(
    'tr',
    null,
    h('td', null, h('div', { class: 'mono' }, u.name), kept && h('div', { class: 'muted' }, 'kept back by a plain upgrade')),
    h('td', { class: 'mono muted' }, u.installed),
    h('td', { class: 'mono' }, u.available),
    h('td', null, u.security ? badge(u.esm ? 'Security (ESM)' : 'Security', 'bad') : badge('Update')),
    h('td', { class: 'mono muted' }, u.suites.join(', ')),
    h('td', null, cveLink(u.source))
  );
}

export function render(root, ctx) {
  root.append(pageHead('Server patches', button('Refresh package lists', async (b) => (await act(b, () => api('system:aptRefresh'))) && ctx.refresh()), button('Refresh', ctx.refresh)));
  load(root, async () => {
    const d = await api('system:updates');
    const sec = d.updates.filter((u) => u.security);
    const other = d.updates.filter((u) => !u.security);
    const kept = new Set(d.keptBack);
    const age = d.listsUpdated ? Date.now() / 1000 - d.listsUpdated : null;
    const kernelPending = d.newestKernel && d.newestKernel !== d.runningKernel;

    const install = (label, packages, cls) =>
      button(
        label,
        async (b) => {
          const r = await act(b, () => api('system:upgrade', packages ? { packages } : {}));
          if (r) ctx.refresh();
        },
        `small ${cls || ''}`
      );
    const reboot = button(
      'Reboot server',
      async (b) => {
        await act(b, () => api('system:reboot'));
      },
      'small danger'
    );

    const auto = d.unattended;
    const autoText = !auto.installed
      ? 'unattended-upgrades is not installed: security fixes are only installed when you do it here.'
      : !auto.enabled
        ? 'unattended-upgrades is installed but switched off (APT::Periodic::Unattended-Upgrade is not "1").'
        : `unattended-upgrades installs security fixes daily${auto.lastRun ? `; it last ran ${timeAgo(auto.lastRun)}` : ''}${auto.lastResult ? ` (${auto.lastResult.text})` : ''}.`;

    return [
      age != null && age > STALE_SEC && h('div', { class: 'warn-box' }, `The package lists were last refreshed ${timeAgo(d.listsUpdated)}, so newer updates may be missing. Use "Refresh package lists" first.`),
      age == null && h('div', { class: 'warn-box' }, 'The package lists have never been refreshed on this server. Use "Refresh package lists" first.'),
      (d.rebootRequired || kernelPending) &&
        h(
          'div',
          { class: 'warn-box row' },
          h(
            'span',
            null,
            d.rebootRequired ? `A reboot is required to finish installing updates${d.rebootPackages.length ? ` (${d.rebootPackages.join(', ')})` : ''}.` : '',
            kernelPending ? ` Running kernel ${d.runningKernel}; ${d.newestKernel} is installed and is used after a reboot.` : ''
          ),
          h('span', { class: 'spacer' }),
          reboot
        ),
      h(
        'div',
        { class: 'grid' },
        stat('Security updates', String(sec.length), sec.length ? 'from the -security pocket' : 'nothing pending', sec.length ? 'bad' : 'ok', sec.length > 0 && install(`Install ${sec.length} security update${sec.length === 1 ? '' : 's'}`, sec.map((u) => u.name), 'primary')),
        stat('Other updates', String(other.length), 'bug fixes and point releases', other.length ? 'warn' : '', d.updates.length > 0 && install('Install all updates', null)),
        stat('Reboot', d.rebootRequired ? 'Required' : 'Not needed', `kernel ${d.runningKernel}`, d.rebootRequired ? 'warn' : 'ok'),
        stat('Package lists', d.listsUpdated ? timeAgo(d.listsUpdated) : 'never', d.os)
      ),
      h('div', { class: `${auto.enabled ? 'info-box' : 'warn-box'} section` }, autoText),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'Security updates'), badge(String(sec.length), sec.length ? 'bad' : 'ok')),
        table(['Package', 'Installed', 'Available', 'Type', 'From', 'Notices'], sec.map((u) => updateRow(u, kept.has(u.name))), 'No security updates are waiting.')
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'Other updates'), badge(String(other.length))),
        table(['Package', 'Installed', 'Available', 'Type', 'From', 'Notices'], other.map((u) => updateRow(u, kept.has(u.name))), 'No other updates are waiting.')
      ),
      d.held.length > 0 && h('div', { class: 'info-box section' }, `Held (never upgraded until unheld with apt-mark unhold): ${d.held.join(', ')}`),
      d.keptBack.length > 0 &&
        h('div', { class: 'info-box section' }, `"Install all updates" keeps back ${d.keptBack.join(', ')} (they need new packages or are being phased in). Installing them by name, as "Install security updates" does, includes them.`),
    ];
  });
}
