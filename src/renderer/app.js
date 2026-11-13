import { h, api, button, copyButton, reviewModal, icon } from './ui.js';
import * as overview from './views/overview.js';
import * as activity from './views/activity.js';
import * as instance from './views/instance.js';
import * as domains from './views/domains.js';
import * as dns from './views/dns.js';
import * as docker from './views/docker.js';
import * as deploys from './views/deploys.js';
import * as chat from './views/chat.js';
import * as settings from './views/settings.js';
import * as progress from './views/progress.js';
import * as site from './views/site.js';
import * as repos from './views/repos.js';
import * as patches from './views/patches.js';
import * as terminal from './views/terminal.js';
import * as traffic from './views/traffic.js';

const VIEWS = [
  ['overview', 'Overview', overview, 'Monitor'],
  ['instance', 'Instance', instance, 'Monitor'],
  ['activity', 'Deployments', activity, 'Monitor'],
  ['domains', 'Sites', domains, 'Network'],
  ['dns', 'DNS', dns, 'Network'],
  ['docker', 'Docker', docker, 'Apps'],
  ['deploys', 'Auto-deploy', deploys, 'Apps'],
  ['repos', 'Repositories', repos, 'Security'],
  ['patches', 'Server patches', patches, 'Security'],
  ['settings', 'Settings', settings, 'System'],
];
// Pages below a menu screen (reached from it, shown with breadcrumbs): id -> [label, module, parent view].
const SUBPAGES = {
  site: ['Edit config', site, 'domains'],
  traffic: ['Traffic', traffic, 'domains'],
};

const state = { conn: { connected: false }, view: 'overview', params: {}, pins: [] };

// ---- sites pinned to the menu (saved per server), each opening that site's traffic ----
const isPinned = (name, kind = 'site') => state.pins.some((p) => p.name === name && p.kind === kind);
async function togglePin(name, kind = 'site') {
  state.pins = await api('pins:toggle', { name, kind });
  renderNav();
  return state.pins;
}
async function loadPins() {
  state.pins = await api('pins:get').catch(() => []);
  renderNav();
}
/** The pinned site whose traffic is on screen, if any (it is highlighted instead of Sites). */
const openPin = () => (state.view === 'traffic' ? state.pins.find((p) => p.name === state.params.name && p.kind === (state.params.kind || 'site')) : null);
const viewEl = document.getElementById('view');
const navEl = document.getElementById('nav');

// ---- "Deployments" count in the menu ----
// The main process polls the server and sends the count (it also drives the taskbar button);
// the "Deployments" screen refreshes faster and reports its own count back.
let activeCount = 0;
const countBadge = h('span', { class: 'nav-count hidden', title: 'Deploys and builds running now' });
function setActiveCount(n) {
  activeCount = n;
  countBadge.textContent = String(n);
  countBadge.classList.toggle('hidden', !n);
}
window.addEventListener('activity-count', (e) => {
  setActiveCount(e.detail);
  api('activity:count', e.detail).catch(() => {});
});
window.api.on('activity', ({ count }) => {
  setActiveCount(count);
  if (count) api('taskbar:overlay', { count, png: overlayPng(count) }).catch(() => {});
});

/** A small amber badge with the count, for the corner of the taskbar button. */
function overlayPng(n) {
  const size = 32;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#e0a23a';
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1a1205';
  const text = n > 9 ? '9+' : String(n);
  g.font = `bold ${text.length > 1 ? 17 : 21}px "Segoe UI", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, size / 2, size / 2 + 1);
  return c.toDataURL('image/png');
}

function renderNav() {
  let group = null;
  const items = [];
  const pin = openPin();
  for (const [id, label, , g] of VIEWS) {
    if (g !== group) {
      group = g;
      items.push(h('div', { class: 'nav-group' }, g));
    }
    const active = id === state.view || (!pin && SUBPAGES[state.view] && SUBPAGES[state.view][2] === id);
    items.push(
      h('button', { class: active ? 'active' : '', onclick: () => go(id, true) }, icon(id), h('span', { class: 'nav-label' }, label), id === 'activity' && countBadge)
    );
    // Pinned sites sit right under Sites, in the Network group.
    if (id === 'domains' && state.conn.connected) {
      for (const p of state.pins) {
        items.push(
          h(
            'button',
            { class: `nav-pin ${p === pin ? 'active' : ''}`, title: `${p.name}: recent traffic`, onclick: () => go('traffic', true, { name: p.name, kind: p.kind }) },
            icon('traffic', 16),
            h('span', { class: 'nav-label' }, p.name)
          )
        );
      }
    }
  }
  navEl.replaceChildren(...items);
  const c = state.conn;
  const pill = document.getElementById('conn-pill');
  pill.classList.toggle('online', !!c.connected);
  pill.replaceChildren(icon('server', 14), h('span', { class: `dot ${c.connected ? 'ok' : ''}` }), h('span', { class: 'conn-text' }, c.connected ? `${c.username}@${c.host}` : 'Not connected'));
}

// Clean-up registered by the screen on show (editors to dispose, streams to stop), run when it is left.
let leaving = [];

/** Show a screen. `params` picks what a sub-page shows (e.g. which site); a re-render keeps them. */
function go(id, fromNav = false, params) {
  for (const fn of leaving.splice(0)) {
    try {
      fn();
    } catch (e) {
      console.warn(e);
    }
  }
  if (params !== undefined || id !== state.view) state.params = params || {};
  state.view = id;
  renderNav();
  // Each render gets a fresh root, so a slow render of a view the user has left can't paint over the new one.
  const root = h('div');
  viewEl.replaceChildren(root);
  viewEl.scrollTop = 0;
  const [label, mod] = SUBPAGES[id] || VIEWS.find((v) => v[0] === id).slice(1, 3);
  const ctx = { conn: state.conn, go, fromNav, params: state.params, isPinned, togglePin, refresh: () => go(state.view), onLeave: (fn) => leaving.push(fn) };
  if (!state.conn.connected && id !== 'settings') {
    root.append(
      h('div', { class: 'page-head' }, h('h1', null, label)),
      h(
        'div',
        { class: 'card empty-state' },
        h('div', { class: 'empty-icon' }, icon('server', 26)),
        h('div', { class: 'empty-title' }, 'No server connected'),
        h('div', { class: 'field muted' }, 'Connect to your server to see this.'),
        button('Open connection settings', () => go('settings'), 'primary')
      )
    );
    return;
  }
  mod.render(root, ctx);
}

chat.init();
terminal.init(() => !!state.conn.connected);
document.getElementById('conn-pill').addEventListener('click', () => go('settings'));

// ---- job drawer: live output of long-running commands ----
const jobs = document.getElementById('jobs');
const jobOut = document.getElementById('job-out');
const jobStatus = document.getElementById('job-status');
const jobToggle = document.getElementById('job-toggle');
let currentJob = null;

window.api.on('progress', (ev) => progress.handle(ev));

window.api.on('job', (ev) => {
  progress.onJob(ev);
  if (ev.type === 'start') {
    currentJob = ev.id;
    jobs.classList.remove('hidden', 'collapsed');
    jobToggle.textContent = 'Hide';
    document.getElementById('job-title').textContent = ev.title;
    jobStatus.className = 'dot run';
    jobOut.textContent = '';
  } else if (ev.id !== currentJob) {
    return;
  } else if (ev.type === 'data') {
    const pinned = jobOut.scrollTop + jobOut.clientHeight >= jobOut.scrollHeight - 30;
    jobOut.append(ev.text);
    if (pinned) jobOut.scrollTop = jobOut.scrollHeight;
  } else if (ev.type === 'end') {
    jobStatus.className = `dot ${ev.code === 0 ? 'ok' : 'bad'}`;
    jobOut.append(ev.code === 0 ? '\n✔ Done\n' : `\n✖ Failed (exit code ${ev.code})\n`);
    jobOut.scrollTop = jobOut.scrollHeight;
  }
});
jobToggle.addEventListener('click', () => {
  jobToggle.textContent = jobs.classList.toggle('collapsed') ? 'Show' : 'Hide';
});
document.getElementById('job-close').addEventListener('click', () => jobs.classList.add('hidden'));
document.getElementById('job-copy').replaceWith(Object.assign(copyButton(() => jobOut.textContent, 'Copy', 'small ghost'), { id: 'job-copy', title: 'Copy the output to the clipboard' }));

// The main process asks for approval before it changes anything on the server.
// A change proposed by the assistant is asked about in its side panel instead of a dialog.
window.api.on('review', (plan) => {
  if (plan.chat && chat.review(plan)) return;
  reviewModal(plan).then((approved) => window.api.reviewReply(plan.id, approved));
});

window.api.on('conn', (conn) => {
  const was = state.conn.connected;
  state.conn = conn;
  if (conn.connected && !was) loadPins();
  if (was !== conn.connected) go(conn.connected && state.view === 'settings' ? 'overview' : state.view);
  else renderNav();
});

(async () => {
  state.conn = await api('conn:status');
  if (state.conn.connected) await loadPins();
  const s = await api('settings:get');
  go(s.connection.host ? 'overview' : 'settings');
  // Auto-connect on launch when a server is already configured.
  if (s.connection.host && !state.conn.connected) {
    try {
      await api('conn:connect', {});
    } catch {
      go('settings');
    }
  }
})();
