import { h, api, act, button, badge, pageHead, table, modal, logActions, showOutput, fmtDuration, timeAgo, commitLink, select } from '../ui.js';

// Deployments: what is being deployed or built on the server right now (polled while the
// screen is open), and the full deploy history, for all repositories or one.

const POLL_MS = 3000;
const LOG_POLL_MS = 2000;

const KIND_BADGE = { agent: 'info', build: 'warn', compose: 'warn', pull: '', git: '', certbot: '', apt: '', upload: '' };

/** Follow a deploy log while it is being written. Stops when the dialog closes. */
function watchLog(title, file) {
  const pre = h('pre', { class: 'output live-log' }, 'Loading…');
  let open = true;
  let last = '';
  modal({ title, wide: true, body: pre, actions: logActions(pre), onClose: () => (open = false) });
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

// ---- history: every past deploy, all repositories or one ----

const PAGE = 100;
// The repository picked, kept while the app runs so coming back shows the same one.
let pickedRepo = null;

const repoLabel = (g) => g.repo || `${g.projects[0]}${g.removed ? ' (removed project)' : ''}`;
const when = (t) => (t ? new Date(t * 1000).toLocaleString() : '—');

function logButton(e) {
  if (!e.log) return null;
  if (!e.logKept) return h('span', { class: 'muted', title: 'The deploy agent keeps the newest 30 logs per project; this one has been removed.' }, 'Log removed');
  return button('Log', (b) => act(b, async () => showOutput(`${e.project} — ${when(e.started)}`, await api('deploy:log', { file: e.log }))), 'small');
}

function historyRow(e, showRepo) {
  return h(
    'tr',
    null,
    h('td', { class: 'muted', title: when(e.started) }, timeAgo(e.finished || e.started), h('div', { class: 'muted' }, when(e.started))),
    h(
      'td',
      null,
      h('div', { class: 'deploy-source' }, e.project, showRepo && e.repo && [h('span', { class: 'muted', 'aria-label': 'deployed from' }, '←'), h('span', { class: 'muted mono' }, e.repo)]),
      e.message && h('div', { class: 'muted' }, e.message)
    ),
    h('td', null, badge(e.code === 0 ? 'Succeeded' : 'Failed', e.code === 0 ? 'ok' : 'bad')),
    h('td', { class: 'muted' }, e.trigger || '', e.commit && ' ', e.commit && commitLink(e.repo, e.commit, 8)),
    h('td', { class: 'muted' }, e.finished && e.started ? fmtDuration(e.finished - e.started) : '—'),
    h('td', { class: 'actions' }, logButton(e))
  );
}

function reposTable(repos, onPick) {
  return table(
    ['Repository', 'Projects', 'Deploys', 'Succeeded', 'Failed', 'Last deploy', 'Avg time'],
    repos.map((g) =>
      h(
        'tr',
        { class: `clickable ${g.key === pickedRepo ? 'selected' : ''}`, tabindex: '0', title: `Show only ${repoLabel(g)}`, onclick: () => onPick(g.key), onkeydown: (ev) => ev.key === 'Enter' && onPick(g.key) },
        h('td', { class: g.repo ? 'mono' : '' }, repoLabel(g)),
        h('td', { class: 'muted' }, g.projects.join(', ')),
        h('td', null, String(g.deploys)),
        h('td', null, g.succeeded ? badge(String(g.succeeded), 'ok') : h('span', { class: 'muted' }, '0')),
        h('td', null, g.failed ? badge(String(g.failed), 'bad') : h('span', { class: 'muted' }, '0')),
        h('td', { class: 'muted' }, g.lastStarted ? [timeAgo(g.lastStarted), ' ', badge(g.lastCode === 0 ? 'ok' : 'failed', g.lastCode === 0 ? 'ok' : 'bad')] : 'never'),
        h('td', { class: 'muted' }, g.avgTime != null ? fmtDuration(g.avgTime) : '—')
      )
    ),
    'No deploy projects yet.'
  );
}

/** The "History" part of the screen. `reload()` fetches again (after a deploy finishes). */
function historySection() {
  const el = h('div', null, h('div', { class: 'loading' }, 'Loading history…'));
  let data = null;
  let gen = 0;

  async function load(append = false) {
    const my = ++gen;
    const offset = append && data ? data.entries.length : 0;
    try {
      const r = await api('activity:history', pickedRepo ? { repo: pickedRepo, offset, limit: PAGE } : { offset, limit: PAGE });
      if (my !== gen) return;
      // A repository that no longer appears (its project removed and never deployed): show all.
      if (pickedRepo && !r.repos.some((g) => g.key === pickedRepo)) {
        pickedRepo = null;
        return load();
      }
      data = append && data ? { ...r, entries: [...data.entries, ...r.entries] } : r;
      draw();
    } catch (e) {
      if (my === gen) el.replaceChildren(h('div', { class: 'error-box' }, e.message));
    }
  }

  function pick(key) {
    pickedRepo = key === pickedRepo ? null : key;
    el.querySelectorAll('.history-list').forEach((n) => n.classList.add('dim'));
    load();
  }

  function draw() {
    const d = data;
    const picked = d.repos.find((g) => g.key === pickedRepo);
    const picker = select([['', `All repositories (${d.repos.reduce((n, g) => n + g.deploys, 0)})`], ...d.repos.map((g) => [g.key, `${repoLabel(g)} (${g.deploys})`])], pickedRepo || '');
    picker.addEventListener('change', () => pick(picker.value || null));
    const more = d.entries.length < d.matching && button(`Show more (${d.matching - d.entries.length} older)`, (b) => act(b, () => load(true)));
    el.replaceChildren(
      h(
        'div',
        { class: 'section' },
        h(
          'div',
          { class: 'section-head' },
          h('h2', null, 'History'),
          h('span', { class: 'muted' }, picked ? `${d.matching} deploy${d.matching === 1 ? '' : 's'} of ${repoLabel(picked)}` : `${d.matching} deploy${d.matching === 1 ? '' : 's'}`),
          h('span', { class: 'spacer' }),
          picker
        ),
        d.truncated && h('div', { class: 'info-box' }, 'Only the newest 5,000 deploys on record are shown.'),
        h(
          'div',
          { class: 'history-list' },
          table(['When', 'Project', 'Result', 'Trigger', 'Took', ''], d.entries.map((e) => historyRow(e, !picked)), picked ? 'No deploys of this repository yet.' : 'No deploys from the deploy agent yet.')
        ),
        more && h('div', { class: 'stat-action' }, more)
      ),
      h(
        'div',
        { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', null, 'By repository'), h('span', { class: 'muted' }, 'click a row to show only its deploys in the history above')),
        reposTable(d.repos, pick)
      )
    );
  }

  load();
  return { el, reload: () => load() };
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
  return out;
}

// What identifies the newest finished deploy: when it changes, the history is fetched again.
const lastFinished = (d) => (d.recent && d.recent[0] ? `${d.recent[0].project}@${d.recent[0].started}` : '');

export function render(root) {
  const status = h('span', { class: 'muted live' }, h('span', { class: 'dot ok' }), 'Live');
  const body = h('div', null, h('div', { class: 'loading' }, 'Loading…'));
  const history = historySection();
  let timer = null;
  let busy = false;
  let seen = null;

  async function tick() {
    clearTimeout(timer);
    if (!root.isConnected || busy) return; // left this screen, or an update is already on its way
    busy = true;
    try {
      const d = await api('activity:list');
      window.dispatchEvent(new CustomEvent('activity-count', { detail: d.active.length }));
      if (!root.isConnected) return;
      body.replaceChildren(...content(d));
      const last = lastFinished(d);
      if (seen !== null && last !== seen) history.reload();
      seen = last;
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
    pageHead('Deployments', status, button('Refresh', () => (tick(), history.reload()))),
    h('div', { class: 'field muted' }, 'What is deploying now — deploys from the deploy agent, plus Docker builds, compose, image pulls, git, certbot and apt runs started any other way (including by hand over SSH) — and every past deploy, for all repositories or one. Refreshes every few seconds while this screen is open.'),
    body,
    history.el
  );
  tick();
}
