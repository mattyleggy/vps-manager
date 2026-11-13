import { h, api, act, button, badge, modal, field, input, select, toast, timeAgo } from '../ui.js';
import { onNextStart } from './progress.js';

/** "https://github.com/owner/name.git" -> "name": the default project name for a repo. */
const repoName = (repo) =>
  (repo.trim().replace(/\/+$/, '').replace(/\.git$/i, '').split(/[/:]/).pop() || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+/, '');

/**
 * "Launch from GitHub": one form, one review, for the whole path from a repository to a live
 * domain (deploy project -> deploy key -> webhook -> clone and deploy -> nginx site -> certificate).
 */
export async function launchModal(ctx) {
  const s = await api('settings:get');
  const hasToken = s.github.hasToken;
  const hasEmail = !!s.certEmail;

  const repo = input({ placeholder: 'your-github-user/myapp' });
  const domains = input({ placeholder: 'example.com www.example.com' });
  const branch = input({ placeholder: "the repo's default branch" });
  const type = select([['proxy', 'An app on a local port (Docker compose / Node / etc.)'], ['static', 'Static files from the repo']], 'proxy');
  const port = input({ placeholder: '3000' });
  const subdir = input({ placeholder: 'public' });
  const name = input({ placeholder: 'myapp' });
  const dir = input({ placeholder: '/opt/apps/myapp' });
  const cmd = h('textarea', { rows: '3', spellcheck: 'false' });
  const key = h('input', { type: 'checkbox', id: 'launch-key', checked: hasToken, disabled: !hasToken });
  // HTTPS is on by default. The certificate needs an email; if none is saved yet it is asked for here.
  const https = h('input', { type: 'checkbox', id: 'launch-https', checked: true });
  const certEmail = input({ value: s.certEmail || '', placeholder: 'you@example.com' });
  const certEmailField = field("Email for Let's Encrypt", certEmail, hasEmail ? 'Used for certificate expiry notices.' : 'Used for certificate expiry notices. Saved in Settings, so you only enter it once.');
  const syncHttps = () => certEmailField.classList.toggle('hidden', !https.checked || hasEmail);
  https.addEventListener('change', syncHttps);
  syncHttps();
  const auto = h('input', { type: 'checkbox', id: 'launch-auto', checked: true });
  const hook = h('input', { type: 'checkbox', id: 'launch-hook', checked: hasToken, disabled: !hasToken });
  // No automatic deploys, no webhook.
  auto.addEventListener('change', () => {
    hook.disabled = !hasToken || !auto.checked;
    if (!auto.checked) hook.checked = false;
  });

  const PORT_HINT = 'The port the app listens on once it is running, e.g. the one your compose file publishes. On the first clone it is written to .env as APP_PORT (.env is created from .env.example).';
  const portHint = h('div', { class: 'hint' }, PORT_HINT);
  const portField = h('div', { class: 'field' }, h('label', null, 'Local port'), port, portHint);
  // Suggest the next free port on the server, unless the user has typed one.
  let portTouched = false;
  let portAsked = false;
  port.addEventListener('input', () => (portTouched = true));
  async function suggestPort() {
    if (portAsked || portTouched) return;
    portAsked = true;
    portHint.textContent = 'Finding the next free port on the server…';
    try {
      const r = await api('nginx:nextPort', { from: 3000 });
      if (portTouched) return (portHint.textContent = PORT_HINT);
      port.value = String(r.port);
      portHint.textContent = `Suggested: ${r.port} is the next free port${r.inUse.length ? ` (${r.inUse.join(', ')} ${r.inUse.length === 1 ? 'is' : 'are'} taken)` : ''}. On the first clone, .env is created from the repo's .env.example with APP_PORT=${r.port}, so a compose file can publish "127.0.0.1:\${APP_PORT}:3000". Change the port if your app already uses another.`;
    } catch (e) {
      portAsked = false;
      portHint.textContent = `Could not check which ports are free (${e.message}). ${PORT_HINT}`;
    }
  }
  const subdirField = field('Folder to serve', subdir, 'Folder inside the repo, e.g. “public” or “dist”. Leave blank to serve the repo root.');
  subdirField.classList.add('hidden');

  const defaultCmd = () => {
    const pull = `git pull --ff-only origin ${branch.value.trim() || '<branch>'}`;
    return type.value === 'static' ? pull : `${pull} && docker compose up -d --build --remove-orphans`;
  };
  const sync = () => {
    portField.classList.toggle('hidden', type.value !== 'proxy');
    subdirField.classList.toggle('hidden', type.value !== 'static');
    cmd.placeholder = defaultCmd();
    if (type.value === 'proxy') suggestPort();
  };
  type.addEventListener('change', sync);
  branch.addEventListener('input', sync);
  sync();

  // Name and folder follow the repo until the user edits them.
  let nameTouched = false;
  let dirTouched = false;
  name.addEventListener('input', () => (nameTouched = true));
  dir.addEventListener('input', () => (dirTouched = true));
  const follow = () => {
    if (!nameTouched) name.value = repoName(repo.value);
    if (!dirTouched) dir.value = name.value.trim() ? `/opt/apps/${name.value.trim()}` : '';
  };
  repo.addEventListener('input', follow);
  name.addEventListener('input', follow);

  // Repository picker: the connected user's repos, narrowed by whatever is typed in the box.
  // Typing a name or pasting a URL by hand keeps working whether or not the list loads.
  const repoStatus = h('div', { class: 'hint' }, 'Loading your repositories from GitHub…');
  let closeForm = () => {};
  const repoList = h('div', { class: 'repo-list hidden' });
  let repos = [];
  const pick = (r) => {
    repo.value = r.full_name;
    repo.dispatchEvent(new Event('input', { bubbles: true })); // project name and folder follow
    if (r.default_branch) branch.placeholder = `${r.default_branch} (the repo's default)`;
    domains.focus();
  };
  const drawRepos = () => {
    const typed = repo.value.trim().toLowerCase();
    const chosen = repos.some((r) => r.full_name.toLowerCase() === typed);
    const shown = chosen ? [] : repos.filter((r) => !typed || r.full_name.toLowerCase().includes(typed));
    repoList.replaceChildren(
      ...shown.map((r) =>
        h(
          'button',
          { type: 'button', class: 'repo-item', onclick: () => pick(r) },
          h('span', { class: 'mono' }, r.full_name),
          r.private && badge('private'),
          r.archived && badge('archived', 'warn'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'muted nowrap' }, r.pushed_at ? `pushed ${timeAgo(Date.parse(r.pushed_at) / 1000)}` : '')
        )
      )
    );
    repoList.classList.toggle('hidden', !shown.length);
  };
  repo.addEventListener('input', drawRepos);
  api('github:repos')
    .then((r) => {
      repos = r.repos;
      const n = `${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}`;
      if (r.source === 'token') {
        repoStatus.textContent = `${n} from your GitHub token${r.truncated ? ' (the most recently pushed)' : ''}. Type to filter, click to choose. A repo missing here is one the token was not given access to.`;
      } else {
        // Not the full list: say so where it cannot be missed, with the way to fix it.
        repoStatus.className = 'warn-box';
        repoStatus.replaceChildren(
          h('div', null, h('b', null, 'Private repositories are not shown. '), `These are the ${n} public ones of ${r.user}, found through your SSH key. GitHub does not let an SSH key list private repositories; that needs a GitHub token. You can still type a private repo’s name above.`),
          h('div', { class: 'row section' }, button('Add a GitHub token', () => (closeForm(), ctx.go('settings')), 'small primary'))
        );
      }
      drawRepos();
    })
    .catch((e) => {
      repoStatus.textContent = `Could not list your repositories: ${e.message} You can still type owner/name.`;
    });

  const check = (box, label, hint) => h('div', { class: 'field' }, h('div', { class: 'check' }, box, h('label', { for: box.id }, label)), hint && h('div', { class: 'hint' }, hint));

  closeForm = modal({
    title: 'Launch from GitHub',
    wide: true,
    body: [
      h('div', { class: 'field muted' }, 'Clones a repository onto the server, runs it, and puts it on a domain. You review every command before anything runs.'),
      h(
        'div',
        { class: 'field-row' },
        field('GitHub repository', repo, 'owner/name, or paste the repo URL.'),
        field('Branch', branch, 'Leave blank for the default branch.')
      ),
      h('div', { class: 'field' }, repoList, repoStatus),
      field('Domains', domains, 'Space-separated. Point their DNS A records at this server first; the first one names the nginx site.'),
      h('div', { class: 'field-row' }, field('What to serve', type), portField, subdirField),
      h('div', { class: 'field-row' }, field('Project name', name), field('Folder on server', dir, 'The repo is cloned here.')),
      field('Deploy command', cmd, 'Runs as root inside the folder after cloning, and again on every deploy. Leave blank for the default shown.'),
      check(
        key,
        'Add a read-only deploy key to the repo',
        hasToken
          ? 'Needed for a private repo: a key is created on the server and its public half is added to the repo through the GitHub API.'
          : 'Needs a GitHub token (Settings → GitHub). Without one the clone uses the server’s shared GitHub key, which must already be on your account.'
      ),
      check(
        https,
        'Get an HTTPS certificate and redirect HTTP to HTTPS',
        `Free Let's Encrypt certificate through certbot${hasEmail ? `, registered to ${s.certEmail}` : ''}; visitors on http:// are sent to https://. The domains must already point at this server. If they do not yet, the site still goes up over HTTP and you can use “Get certificate” later.`
      ),
      certEmailField,
      check(auto, 'Deploy automatically on later pushes', 'GitHub tells the server about each push through a webhook.'),
      check(
        hook,
        'Create the webhook on the repo',
        hasToken
          ? 'Added through the GitHub API with the agent’s URL and secret (the token needs “Webhooks: Read and write”).'
          : 'Needs a GitHub token (Settings → GitHub). Without one, add the webhook afterwards from the Auto-deploy screen.'
      ),
    ],
    actions: (close) => [
      button('Cancel', close),
      button(
        'Review & launch',
        async (b) => {
          const proxy = type.value === 'proxy';
          // Once the review is approved the progress window takes over: this form gets out of the way.
          const form = b.closest('.overlay');
          const cancelHide = onNextStart(() => form.classList.add('hidden'));
          const r = await act(b, async () => {
            if (https.checked) {
              const email = certEmail.value.trim();
              if (!/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/.test(email)) throw new Error("Enter your email for the Let's Encrypt certificate, or untick the HTTPS option.");
              if (email !== s.certEmail) {
                await api('settings:save', { certEmail: email });
                s.certEmail = email;
              }
            }
            return api('deploy:launch', {
              repo: repo.value.trim(),
              domains: domains.value.trim(),
              type: type.value,
              upstreamPort: proxy ? Math.trunc(Number(port.value)) || 0 : undefined,
              subdir: proxy ? undefined : subdir.value.trim(),
              branch: branch.value.trim() || undefined,
              name: name.value.trim() || undefined,
              path: dir.value.trim() || undefined,
              command: cmd.value.trim() || undefined,
              deployKey: key.checked,
              https: https.checked,
              auto: auto.checked,
              webhook: hook.checked,
            });
          });
          cancelHide();
          if (!r) return form.classList.remove('hidden'); // rejected input, or the review was cancelled: keep the form open
          if (r.code === 0) {
            close();
            toast('Launched: the site is live', 'ok');
          } else {
            // Keep what was typed, so the launch can be tried again once the problem is fixed.
            form.classList.remove('hidden');
            toast('Launch did not finish. The progress window shows the step that failed.', 'error');
          }
          ctx.refresh();
        },
        'primary'
      ),
    ],
  });
}
