import { h, api, act, button, badge, modal, field, input, pageHead, table, load, toast, showOutput, copyLine, timeAgo, fmtDuration } from '../ui.js';
import { launchModal } from './launch.js';

const DEFAULT_CMD = (branch) => `git pull --ff-only origin ${branch || 'master'} && docker compose up -d --build --remove-orphans`;

function installForm(status, ctx) {
  const cfg = status.config || {};
  const host = input({ placeholder: 'deploy.example.com', value: cfg.public_host || '' });
  const port = input({ placeholder: '9321', value: String(cfg.port || 9321) });
  const outdated = status.installed && status.version !== status.localVersion;
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'field-row' },
      field('Webhook hostname (recommended)', host, 'A (sub)domain pointing at this server. nginx will forward /hooks/ on it to the agent, and you can add HTTPS to it from the Domains page. Leave blank to expose the port directly over plain HTTP instead.'),
      field('Agent port', port, 'Local port the agent listens on. With no hostname this port is opened in ufw — also allow it in the Vultr firewall if you use one.')
    ),
    h(
      'div',
      { class: 'row' },
      button(
        status.installed ? (outdated ? `Update agent to ${status.localVersion}` : 'Re-install / apply') : 'Install deploy agent',
        async (b) => {
          const r = await act(b, () => api('deploy:install', { hostname: host.value.trim(), port: Number(port.value.trim()) || 9321 }));
          if (r && r.code === 0) toast('Deploy agent is running', 'ok');
          ctx.refresh();
        },
        status.installed && !outdated ? '' : 'primary'
      ),
      h('span', { class: 'muted' }, 'Installs a small Python service (systemd unit “deploy-agent”) that runs as root on the server.')
    )
  );
}

function webhookCard(status, ctx) {
  const cfg = status.config;
  const insecure = status.webhookUrl.startsWith('http://');
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'kv' },
      h('div', { class: 'k' }, 'Payload URL'),
      copyLine(status.webhookUrl),
      h('div', { class: 'k' }, 'Content type'),
      h('div', { class: 'mono' }, 'application/json'),
      h('div', { class: 'k' }, 'Secret'),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'spacer' }, copyLine(cfg.secret, { display: '•'.repeat(32) })),
        button(
          'Rotate',
          async (b) => {
            await act(b, () => api('deploy:rotateSecret'), 'New secret generated');
            ctx.refresh();
          },
          'small'
        )
      ),
      h('div', { class: 'k' }, 'Events'),
      h('div', null, 'Just the push event')
    ),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, h('b', null, 'Automatic: '), 'press “Add webhook” on a project row below and the app creates it on GitHub for you. The steps here are only for adding one by hand.'),
      h('li', null, 'On GitHub open the repo → ', h('b', null, 'Settings → Webhooks → Add webhook'), '.'),
      h('li', null, 'Paste the Payload URL and Secret above, set the content type to ', h('b', null, 'application/json'), ', keep “Just the push event”.'),
      h('li', null, 'GitHub sends a ping straight away — a green tick there means the server is reachable and the secret matches.')
    ),
    insecure &&
      h(
        'div',
        { class: 'warn-box' },
        cfg.public_host
          ? `This URL is plain HTTP. Requests are still authenticated by the secret, but go to Domains → “deploy-agent” → Get certificate to switch it to HTTPS, then use the https:// URL.`
          : 'This URL is plain HTTP on a raw port. Requests are still authenticated by the secret, but setting a webhook hostname above (and adding a certificate) is the better setup.'
      )
  );
}

/**
 * Add or edit a deploy project. opts.prefill opens a new project with fields already filled in
 * (e.g. worked out from an existing site), with opts.notes ([{ kind, text }]) shown above them.
 */
export function projectModal(project, ctx, opts = {}) {
  const isNew = !project;
  const p = project || opts.prefill || { name: '', repo: '', branch: 'master', path: '', command: '', auto: true };
  const name = input({ value: p.name, placeholder: 'myapp' });
  const repo = input({ value: p.repo, placeholder: 'your-github-user/myapp' });
  const branch = input({ value: p.branch, placeholder: 'master' });
  const dir = input({ value: p.path, placeholder: '/opt/apps/myapp' });
  const cmd = h('textarea', { rows: '4', spellcheck: 'false', placeholder: DEFAULT_CMD('master') });
  cmd.value = p.command || '';
  const auto = h('input', { type: 'checkbox', id: 'auto', checked: p.auto !== false });
  const keyBox = h('input', { type: 'checkbox', id: 'deploy-key', checked: true });
  const appPort = input({ value: p.app_port != null ? String(p.app_port) : '', placeholder: 'chosen for you' });
  const appPortHint = h('div', { class: 'hint' }, 'Written to .env as APP_PORT when the repo is first cloned (.env is created from .env.example).');
  if (isNew && p.app_port == null) {
    // Fill in the next free port so nothing has to be typed.
    let touched = false;
    appPort.addEventListener('input', () => (touched = true));
    api('nginx:nextPort', { from: 3000 })
      .then((r) => {
        if (touched) return;
        appPort.value = String(r.port);
        appPortHint.textContent = `${r.port} is the next free port. It is written to .env as APP_PORT when the repo is first cloned (.env is created from .env.example).`;
      })
      .catch(() => {});
  }
  let dirTouched = !isNew || !!p.path;
  dir.addEventListener('input', () => (dirTouched = true));
  name.addEventListener('input', () => {
    if (!dirTouched) dir.value = name.value ? `/opt/apps/${name.value.trim()}` : '';
  });
  branch.addEventListener('input', () => (cmd.placeholder = DEFAULT_CMD(branch.value.trim())));
  modal({
    title: opts.title || (isNew ? 'Add project' : `Edit ${p.name}`),
    body: [
      (opts.notes || []).map((n) => h('div', { class: n.kind === 'warn' ? 'warn-box' : 'info-box' }, n.text)),
      h('div', { class: 'field-row' }, field('Name', name), field('GitHub repository', repo, 'owner/name')),
      h('div', { class: 'field-row' }, field('Branch', branch), field('Folder on server', dir, 'Cloned here on first deploy if it does not exist.')),
      h('div', { class: 'field' }, h('label', null, 'App port'), appPort, appPortHint),
      field('Deploy command', cmd, 'Runs as root inside the folder. Leave blank for the default shown above. Any shell works, e.g. “git pull && npm ci && pm2 reload app”.'),
      h('div', { class: 'check' }, auto, h('label', { for: 'auto' }, 'Deploy automatically when this branch is pushed')),
      h('div', { class: 'hint muted' }, 'With this on, the push webhook is added to the GitHub repository for you when you save (needs a GitHub token in Settings).'),
      isNew && h('div', { class: 'check' }, keyBox, h('label', { for: 'deploy-key' }, 'Add a read-only deploy key for this repository (needed for private repos; needs a GitHub token in Settings)')),
    ],
    actions: (close) => [
      button('Cancel', close),
      button(
        'Save',
        async (b) => {
          const ok = await act(b, async () => {
            const saved = await api('deploy:saveProject', {
              originalName: isNew ? undefined : p.name,
              deployKey: isNew && !keyBox.checked ? false : undefined,
              project: { name: name.value, repo: repo.value, branch: branch.value || 'master', path: dir.value, command: cmd.value, auto: auto.checked, app_port: appPort.value.trim() ? Math.trunc(Number(appPort.value)) || 0 : undefined },
            });
            const hook = (saved && saved.webhook) || {};
            const key = (saved && saved.deployKey) || {};
            const r = repo.value.trim();
            const parts = [];
            let kind = 'ok';
            const hookText = {
              created: `A webhook was added to ${r}: pushes now deploy it.`,
              updated: `The existing webhook on ${r} was updated: pushes now deploy it.`,
              skipped: `The webhook could not be added: ${hook.reason} Use “Add webhook” on the project once that is fixed.`,
              'no-token': 'To have the webhook and deploy key added for you, save a GitHub token in Settings, then use “Add webhook” and “Add deploy key” on the project.',
            }[hook.status];
            const keyText = {
              added: `A read-only deploy key was added to ${r}.`,
              kept: `${r} already had this project's deploy key.`,
              skipped: `The deploy key could not be added: ${key.reason} Use “Add deploy key” on the project once that is fixed.`,
              'no-token': hook.status === 'no-token' ? null : 'No deploy key was added (no GitHub token saved).',
            }[key.status];
            for (const t of [hookText, keyText]) if (t) parts.push(t);
            if (saved && saved.remote) parts.push(`The checkout now pulls over SSH instead of ${saved.remote}.`);
            if (hook.status === 'skipped' || key.status === 'skipped') kind = 'error';
            else if (hook.status === 'no-token' || key.status === 'no-token') kind = '';
            toast(`Saved. ${parts.join(' ')}`.trim(), kind);
            return true;
          });
          if (ok) {
            close();
            ctx.refresh();
          }
        },
        'primary'
      ),
    ],
  });
}

function serverKeyCard(status, ctx) {
  if (!status.serverKey) {
    return h(
      'div',
      { class: 'card row' },
      h('span', { class: 'muted spacer' }, 'No GitHub key on the server yet.'),
      button('Generate key', (b) => act(b, () => api('deploy:key'), 'Key created').then(ctx.refresh), 'primary')
    );
  }
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'field muted' },
      'A shared fallback key: root’s SSH config uses it for github.com, so projects without their own deploy key (and anything you run by hand as root) pull with it. The private half stays on the server.'
    ),
    h('pre', { class: 'output' }, status.serverKey),
    h(
      'ol',
      { class: 'steps' },
      h('li', null, h('b', null, 'Usually you do not need this: '), '“Add deploy key” on a project row creates a separate read-only key for that repo and adds it to GitHub for you. A project with its own key ignores this one.'),
      h('li', null, h('b', null, 'One key for all your repos instead: '), 'add this one to your GitHub account. This works for every repo, but an account key can also push — GitHub has no read-only account keys.')
    ),
    h(
      'div',
      { class: 'row section' },
      button('Copy public key', () => api('clipboard:write', status.serverKey).then(() => toast('Copied', 'ok')), 'primary'),
      button('Add to GitHub account ↗', () => api('open:external', 'https://github.com/settings/ssh/new')),
      button('Test access', (b) => act(b, async () => showOutput('ssh -T git@github.com (from the server)', await api('deploy:testKey'))))
    )
  );
}

/** .env exists and carries the project's port: nothing left to set up. */
const envReady = (p) => !!(p.env && p.env.exists && p.app_port != null && p.env.port === p.app_port);

function envBadge(p) {
  if (!p.cloned || !p.env) return p.app_port != null ? badge(`Port ${p.app_port}`) : null;
  if (!p.env.exists) return badge('No .env', 'warn');
  if (envReady(p)) return badge(`.env · port ${p.app_port}`, 'ok');
  if (p.app_port != null) return badge(`.env has ${p.env.port ? `port ${p.env.port}` : 'no APP_PORT'}, project ${p.app_port}`, 'warn');
  return badge(p.env.port ? `.env · port ${p.env.port}` : '.env · no APP_PORT');
}

function projectsTable(status, ctx) {
  const rows = status.config.projects.map((p) =>
    h(
      'tr',
      null,
      h('td', null, h('div', null, p.name), h('div', { class: 'muted mono' }, p.path)),
      h('td', null, h('div', { class: 'mono' }, p.repo), h('div', { class: 'muted' }, `branch ${p.branch}`)),
      h(
        'td',
        null,
        h('div', { class: 'row' }, p.auto !== false ? badge('Auto on push', 'info') : badge('Manual only'), !p.cloned && badge('Not cloned yet', 'warn'), envBadge(p), status.repoKeys[p.name] && badge('Deploy key', 'ok'), p.webhook_url && (p.webhook_url === status.webhookUrl ? badge('Webhook', 'ok') : badge('Webhook URL changed', 'warn')))
      ),
      h(
        'td',
        { class: 'actions' },
        button(
          'Deploy now',
          async (b) => {
            await act(b, () => api('deploy:run', { name: p.name }));
            ctx.refresh();
          },
          'small primary'
        ),
        button(
          status.repoKeys[p.name] ? 'Check deploy key' : 'Add deploy key',
          async (b) => {
            const r = await act(b, () => api('deploy:repoKey', { name: p.name }));
            if (r) toast(`${r.alreadyOnGitHub ? `${p.repo} already has this project's deploy key.` : `Deploy key added to ${p.repo}.`}${r.remote ? ` The checkout now pulls over SSH instead of ${r.remote}.` : ''}`, 'ok');
            ctx.refresh();
          },
          'small'
        ),
        button(
          p.webhook_url ? 'Webhook' : 'Add webhook',
          async (b) => {
            const r = await act(b, () => api('deploy:webhook', { name: p.name }));
            if (r) toast(r.updated ? `Webhook on ${p.repo} updated with the current URL and secret` : `Webhook created on ${p.repo}`, 'ok');
            ctx.refresh();
          },
          'small'
        ),
        p.cloned &&
          !envReady(p) &&
          button(
            'Set up .env',
            async (b) => {
              const r = await act(b, () => api('deploy:env', { name: p.name }));
              if (r) toast(`.env is ready for ${p.name} with APP_PORT=${r.port}. Deploy it to apply a changed port.`, 'ok');
              ctx.refresh();
            },
            'small'
          ),
        button('Edit', () => projectModal(p, ctx), 'small'),
        button(
          'Remove',
          async (b) => {
            await act(b, () => api('deploy:deleteProject', { name: p.name }));
            ctx.refresh();
          },
          'small danger'
        )
      )
    )
  );
  return table(['Project', 'Repository', 'Mode', ''], rows, 'No projects yet. Add one for each repo you want to deploy.');
}

function historyTable(status) {
  const rows = status.history.map((e) =>
    h(
      'tr',
      null,
      h('td', { class: 'nowrap' }, timeAgo(e.started)),
      h('td', null, e.project),
      h('td', null, badge(e.trigger, e.trigger === 'push' ? 'info' : '')),
      h('td', null, e.commit ? h('span', { class: 'mono' }, `${e.commit.slice(0, 7)} `) : null, h('span', { class: 'muted' }, e.message || '')),
      h('td', null, e.code === 0 ? badge('Success', 'ok') : badge(`Failed (${e.code})`, 'bad')),
      h('td', { class: 'muted nowrap' }, fmtDuration(e.finished - e.started)),
      h('td', { class: 'actions' }, button('Log', (b) => act(b, async () => showOutput(`${e.project} — ${new Date(e.started * 1000).toLocaleString()}`, await api('deploy:log', { file: e.log }))), 'small'))
    )
  );
  return table(['When', 'Project', 'Trigger', 'Commit', 'Result', 'Took', ''], rows, 'No deploys yet.');
}

export function render(root, ctx) {
  root.append(pageHead('Auto-deploy', button('Refresh', ctx.refresh)));
  load(root, async () => {
    const s = await api('deploy:status');
    const section = (title, extra, ...content) => h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title), extra), content);

    if (!s.installed || !s.config) {
      return [
        h(
          'div',
          { class: 'info-box' },
          'Auto-deploy works with a small agent on the server. GitHub calls it whenever you push; it checks the signature, then pulls and rebuilds the matching project. It runs on the server, so deploys happen whether or not this app is open.'
        ),
        installForm(s, ctx),
      ];
    }
    const running = s.active === 'active';
    return [
      section(
        'Deploy agent',
        [badge(running ? `Running · v${s.version}` : `Service ${s.active || 'stopped'}`, running ? 'ok' : 'bad'), s.version !== s.localVersion && badge(`Update available: v${s.localVersion}`, 'warn')],
        installForm(s, ctx)
      ),
      section('Server SSH key for GitHub', null, serverKeyCard(s, ctx)),
      section('GitHub webhook', null, webhookCard(s, ctx)),
      section(
        'Projects',
        [h('span', { class: 'spacer' }), button('Launch from GitHub', (b) => act(b, () => launchModal(ctx)), 'small primary'), button('Add project', () => projectModal(null, ctx), 'small')],
        projectsTable(s, ctx)
      ),
      section('Recent deploys', null, historyTable(s)),
    ];
  });
}
