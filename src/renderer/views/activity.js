import { h, api, act, button, badge, pageHead, table, modal, showOutput, fmtDuration, timeAgo } from '../ui.js';

// What is being deployed or built on the server right now. Polls while the screen is open.

const POLL_MS = 3000;
const LOG_POLL_MS = 2000;

const KIND_BADGE = { agent: 'info', build: 'warn', compose: 'warn', pull: '', git: '', certbot: '', apt: '', upload: '' };

/** Follow a deploy log while it is being written. Stops when the dialog closes. */
function watchLog(title, file) {
  const pre = h('pre', { class: 'output live-log' }, 'Loading…');
  let open = true;
  let last = '';
  modal({ title, wide: true, body: pre, onClose: () => (open = false) });
  (async function tick() {
    if (!open) return;
    try {
      const text = await api('deploy:log', { file });
      if (text !== last) {
        const pinned = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
        pre.textContent = text || '(empty so far)';
        if (pinned || !last) pre.scrollTop = pre.scrollHeight;
        last = text;
      }
      // A finished deploy writes its SUCCESS / FAILED line last: nothing more will come.
      if (/\n\[[^\]]+\] (SUCCESS|FAILED) \(exit code/.test(text)) return;
    } catch (e) {
      pre.textContent = e.message;
      return;
    }
    setTimeout(tick, LOG_POLL_MS);
  })();
}

function activityCard(a) {
  const title = a.kind === 'agent' ? a.project : a.label;
  const meta = [];
  if (a.kind === 'agent') {
    if (a.branch) meta.push(a.branch);
    if (a.trigger) meta.push(a.trigger === 'push' ? 'pushed to GitHub' : a.trigger === 'manual' ? 'started from the app' : a.trigger);
    if (a.commit) meta.push(a.commit.slice(0, 8));
  }
  if (a.cwd) meta.push(a.cwd);
  return h(
    'div',
    { class: 'card activity' },
    h(
      'div',
      { class: 'activity-head' },
      h('span', { class: 'dot run' }),
      h('strong', null, title),
      badge(a.kind === 'agent' ? 'Auto-deploy' : a.label, KIND_BADGE[a.kind] || ''),
      a.kind === 'agent' && a.currentKind && a.currentKind !== 'agent' && badge(a.currentKind === 'build' || a.currentKind === 'compose' ? 'building' : a.currentKind, 'warn'),
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted', title: 'Running for' }, fmtDuration(a.elapsed)),
      a.log && button('Watch log', () => watchLog(`${a.project}: deploy in progress`, a.log), 'small')
    ),
    meta.length && h('div', { class: 'muted activity-meta' }, meta.join(' · ')),
    h('div', { class: 'mono activity-cmd', title: a.command }, a.current || a.command)
  );
}

function settlingTable(list) {
  return table(
    ['Container', 'Compose project', 'Image', 'State'],
    list.map((c) =>
      h(
        'tr',
        null,
        h('td', { class: 'mono' }, c.name),
        h('td', null, c.project || '—'),
        h('td', { class: 'mono muted' }, c.image),
        h('td', null, badge(c.status || c.state, c.state === 'restarting' ? 'bad' : 'warn'))
      )
    ),
    ''
  );
}

function recentTable(list) {
  return table(
    ['Project', 'Result', 'Trigger', 'Finished', 'Took', ''],
    list.map((e) =>
      h(
        'tr',
        null,
        h('td', null, e.project, e.message && h('div', { class: 'muted' }, e.message)),
        h('td', null, badge(e.code === 0 ? 'Succeeded' : 'Failed', e.code === 0 ? 'ok' : 'bad')),
        h('td', { class: 'muted' }, `${e.trigger || ''}${e.commit ? ` ${e.commit.slice(0, 8)}` : ''}`),
        h('td', { class: 'muted' }, timeAgo(e.finished)),
        h('td', { class: 'muted' }, fmtDuration(e.finished - e.started)),
        h('td', { class: 'actions' }, e.log && button('Log', (b) => act(b, async () => showOutput(`${e.project} — ${new Date(e.started * 1000).toLocaleString()}`, await api('deploy:log', { file: e.log }))), 'small'))
      )
    ),
    'No deploys from the deploy agent yet.'
  );
}

function content(d) {
  const out = [];
  out.push(
    h(
      'div',
      { class: 'section' },
      h('div', { class: 'section-head' }, h('h2', null, 'In progress'), d.active.length ? badge(String(d.active.length), 'warn') : null),
      d.active.length
        ? h('div', { class: 'activity-list' }, d.active.map(activityCard))
        : h('div', { class: 'info-box' }, 'Nothing is deploying or building right now.')
    )
  );
  if (d.settling.length) {
    out.push(
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'Containers coming up'), h('span', { class: 'muted' }, 'starting, restarting or up for less than a minute')),
        settlingTable(d.settling)
      )
    );
  }
  out.push(h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Recently finished')), recentTable(d.recent)));
  return out;
}

export function render(root) {
  const status = h('span', { class: 'muted live' }, h('span', { class: 'dot ok' }), 'Live');
  const body = h('div', null, h('div', { class: 'loading' }, 'Loading…'));
  let timer = null;
  let busy = false;

  async function tick() {
    clearTimeout(timer);
    if (!root.isConnected || busy) return; // left this screen, or an update is already on its way
    busy = true;
    try {
      const d = await api('activity:list');
      window.dispatchEvent(new CustomEvent('activity-count', { detail: d.active.length }));
      if (!root.isConnected) return;
      body.replaceChildren(...content(d));
      status.replaceChildren(h('span', { class: 'dot ok' }), `Live · updated ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      if (!root.isConnected) return;
      status.replaceChildren(h('span', { class: 'dot bad' }), 'Update failed');
      if (body.querySelector('.loading')) body.replaceChildren(h('div', { class: 'error-box' }, e.message));
    } finally {
      busy = false;
    }
    if (root.isConnected) timer = setTimeout(tick, POLL_MS);
  }

  root.append(
    pageHead('Deploying now', status, button('Refresh', () => tick())),
    h('div', { class: 'field muted' }, 'Deploys from the deploy agent, plus Docker builds, compose, image pulls, git, certbot and apt runs started any other way (including by hand over SSH). Refreshes every few seconds while this screen is open.'),
    body
  );
  tick();
}
