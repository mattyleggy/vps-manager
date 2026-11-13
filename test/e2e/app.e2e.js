// End-to-end test of the real app (main process, IPC, UI) with two things faked:
//   - the SSH server: records every command it is asked to run and answers reads with canned data
//   - the Anthropic client: a scripted model that asks for specific tool calls
//   - the GitHub and Vultr APIs: fetch() is replaced and records the requests it receives
// It clicks real buttons and checks that nothing changes the "server" without an approved review.
//
//   npm run test:e2e
const { app, BrowserWindow } = require('electron');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'vpsm-e2e-')));
const src = (p) => path.join(__dirname, '..', '..', 'src', 'main', p);

// ---------------------------------------------------------------- fake server
const AGENT_VERSION = /^VERSION = "([^"]+)"/m.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'agent', 'deploy-agent.py'), 'utf8'))[1];
const READS = {
  system: { hostname: 'test-host', os: 'Ubuntu 24.04 LTS', kernel: '6.8', uptime: 5000, load: [0.1, 0.1, 0.1], cpus: 2, mem: { total: 4e9, available: 2e9 }, disk: { total: 1e11, used: 5e10, free: 5e10 }, rebootRequired: false, services: { nginx: 'active', docker: 'active', 'deploy-agent': 'inactive', ufw: 'active' }, versions: { nginx: 'nginx/1.24', docker: 'Docker 27', certbot: '' }, ips: ['203.0.113.5'] },
  nginx: { installed: true, sites: [{ name: 'example.com', path: '/etc/nginx/sites-available/example.com', kind: 'site', enabled: true, content: 'server { listen 80; server_name example.com; location / { proxy_pass http://127.0.0.1:3000; } }', certExpiry: {} }] },
  deploy: { installed: true, version: AGENT_VERSION, active: 'active', history: [], serverKey: null, repoKeys: {}, https: true, python: 'Python 3.12', config: { secret: 's3cret', port: 9321, listen: '127.0.0.1', public_host: 'deploy.example.com', projects: [{ name: 'app', repo: 'me/app', branch: 'master', path: '/opt/apps/app', command: '', auto: true, cloned: true, env: { exists: false, example: true, port: null } }] } },
};
const AGENT_CONFIG = { secret: 's3cret', port: 9321, listen: '127.0.0.1', public_host: 'deploy.example.com', projects: [{ name: 'app', repo: 'me/app', branch: 'master', path: '/opt/apps/app', command: '', auto: true }] };
const stdins = []; // stdin of each command, same index as ran
// What the "Deploying now" scan finds: nothing, until a test turns the deploy on.
const ACTIVITY = { deploying: false };
const activityScan = () => ({
  now: 1000,
  parents: { 10: 1, 11: 10 },
  procs: ACTIVITY.deploying
    ? [
        { pid: 10, ppid: 1, elapsed: 30, args: 'bash -c git pull --ff-only origin master && docker compose up -d --build', cwd: '/opt/apps/app', project: 'app' },
        { pid: 11, ppid: 10, elapsed: 20, args: 'docker compose up -d --build --remove-orphans', cwd: '/opt/apps/app', project: 'app' },
      ]
    : [],
  deploys: ACTIVITY.deploying ? { app: { log: '/var/log/deploy-agent/app/20260101-000000.log', started: 960, trigger: 'push', commit: 'abcdef12', branch: 'master' } } : {},
  containers: [],
  history: [],
});

// ---------------------------------------------------------------- fake GitHub
process.env.GITHUB_TOKEN = 'test-token';
const ghCalls = [];
const ghHooks = []; // webhooks the fake repo already has
process.env.VULTR_API_KEY = 'vultr-test';
const vultrCalls = [];
const VULTR_RECORDS = [{ id: 'r9', type: 'CNAME', name: 'www', data: 'example.com', priority: -1, ttl: 300 }];
global.fetch = async (url, opts = {}) => {
  if (String(url).startsWith('https://api.vultr.com/')) {
    vultrCalls.push({ url: String(url), method: opts.method || 'GET', auth: opts.headers && opts.headers.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
    if ((opts.method || 'GET') !== 'GET') return new Response(JSON.stringify({ record: { id: 'r10' } }), { status: 201 });
    const meta = { links: { next: '', prev: '' } };
    return new Response(JSON.stringify(String(url).includes('/records') ? { records: VULTR_RECORDS, meta } : { domains: [{ domain: 'example.com', date_created: '2026-01-01T00:00:00+00:00' }], meta }), { status: 200 });
  }
  ghCalls.push({ url: String(url), method: opts.method || 'GET', auth: opts.headers && opts.headers.Authorization, body: opts.body ? JSON.parse(opts.body) : null });
  if (String(url).includes('/user/repos')) {
    return new Response(JSON.stringify([
      { full_name: 'me/shop-frontend', private: true, default_branch: 'main', pushed_at: new Date(Date.now() - 3600e3).toISOString() },
      { full_name: 'me/blog', private: false, default_branch: 'master', pushed_at: new Date(Date.now() - 86400e3 * 3).toISOString() },
    ]), { status: 200 });
  }
  if (opts.method === 'POST') return new Response(JSON.stringify({ id: 77 }), { status: 201 });
  if (opts.method === 'PATCH') return new Response(JSON.stringify({ id: 77 }), { status: 200 });
  return new Response(JSON.stringify(ghHooks.length && String(url).includes('/hooks') ? ghHooks : []), { status: 200 });
};
const ran = []; // every command line the "server" received
function answer(line, stdin) {
  if (/python3 -/.test(line)) {
    // the activity scan also reads history.jsonl, so it is matched before the deploy status
    if (stdin.includes("b'DEPLOY_PROJECT='")) return [0, JSON.stringify(activityScan())];
    if (stdin.includes('/proc/meminfo')) return [0, JSON.stringify(READS.system)];
    // the deploy status script also mentions sites-available, so it is matched first
    if (stdin.includes('history.jsonl')) return [0, JSON.stringify(READS.deploy)];
    if (stdin.includes('sites-available')) return [0, JSON.stringify(READS.nginx)];
  }
  if (line.includes('ss -ltnH')) return [0, '22\n80\n3000\n8000\n']; // ports already taken on the "server"
  if (/docker ps/.test(line)) return [0, '{"ID":"abc123abc123abc","Names":"web","Image":"nginx","State":"running","Status":"Up 2 hours","Ports":"","Labels":""}\n@@VPSM@@\n'];
  if (/docker compose ls/.test(line)) return [0, '[]'];
  if (/test -e/.test(line)) return [1, '']; // "that site does not exist yet"
  if (line.includes('cat /etc/deploy-agent/config.json') || line.includes("config.json'") && !line.includes('.tmp')) return [0, JSON.stringify(AGENT_CONFIG)];
  if (line.includes('ssh-keygen')) return [0, 'ssh-ed25519 AAAATESTKEY deploy-app\n'];
  if (line.includes('.pub') && line.includes('2>/dev/null')) return [1, '']; // "no key for this project yet"
  return [0, ''];
}
const isRead = (l) =>
  /python3 -|docker ps|docker compose ls|test -e|sudo -n true|nginx -t 2>&1'$|ss -ltnH|fpm\.sock/.test(l) ||
  (l.includes('config.json') && !l.includes('.tmp')) || // reading the agent config
  l.includes('config --get remote.origin.url') || // does the checkout pull over HTTPS?
  (l.includes('.pub') && l.includes('2>/dev/null') && !l.includes('ssh-keygen')); // "is there a key yet?"
const changes = () => ran.filter((l) => !isRead(l));

const { Ssh } = require(src('ssh.js'));
Ssh.prototype.connect = async function () {
  this.client = {
    exec(line, cb) {
      ran.push(line);
      stdins.push('');
      const at = stdins.length - 1;
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = (stdin) =>
        setImmediate(() => {
          stdins[at] = String(stdin || '');
          const [code, out] = answer(line, String(stdin || ''));
          if (out) stream.emit('data', Buffer.from(out));
          stream.emit('close', code);
        });
      cb(null, stream);
    },
    end() {},
  };
  this.info = { host: 'test-host', port: 22, username: 'deploy', isRoot: false, fingerprint: 'SHA256:test' };
  return this.info;
};

// ---------------------------------------------------------------- fake model
const modelRequests = [];
const script = [];
require(src('chat.js')).setClientFactory(() => ({
  beta: {
    messages: {
      stream(params) {
        modelRequests.push(JSON.parse(JSON.stringify(params)));
        const reply = script.shift() || { stop_reason: 'end_turn', content: [{ type: 'text', text: '(script exhausted)' }] };
        const onText = [];
        return {
          on: (ev, fn) => ev === 'text' && onText.push(fn),
          async finalMessage() {
            for (const b of reply.content) if (b.type === 'text') onText.forEach((fn) => fn(b.text));
            return reply;
          },
        };
      },
    },
  },
}));
const toolCall = (text, name, input, id) => ({ stop_reason: 'tool_use', content: [{ type: 'text', text }, { type: 'tool_use', id, name, input }] });
const reply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

require(src('main.js'));

// ---------------------------------------------------------------- the test
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const expect = (name, ok, extra = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${String(extra).split('\n').join(' | ').slice(0, 700)}`}`);
};

app.whenReady().then(async () => {
  await wait(1500);
  const wc = BrowserWindow.getAllWindows()[0].webContents;
  const errors = [];
  wc.on('console-message', (e) => {
    if (e.level === 'error' || e.level >= 2) errors.push(e.message);
  });
  const js = (code) => wc.executeJavaScript(code);
  // Page-side helpers: find things the way a user would, by their visible text.
  await js(`
    window.t = {
      btn: (text, scope = document) => [...scope.querySelectorAll('button')].find((b) => b.textContent.trim() === text),
      nav: (text) => t.btn(text, document.getElementById('nav')).click(),
      modal: () => [...document.querySelectorAll('.modal')].pop(),
      modalText: () => (t.modal() ? t.modal().innerText : ''),
      type: (el, value) => { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); },
      view: () => document.getElementById('view').innerText,
      chat: () => document.getElementById('assistant').innerText,
      ask: () => document.querySelector('#assistant .msg.confirm'),
      askText: () => (t.ask() ? t.ask().innerText : ''),
    }; 0`);
  const until = async (code, ms = 4000) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await js(code)) return true;
    return false;
  };

  await js(`window.api.invoke('settings:save', { connection: { host: 'test-host', username: 'deploy', authType: 'agent' } }).then(() => window.api.invoke('conn:connect', {}))`);
  expect('overview loads from the server', await until(`t.view().includes('test-host') && t.view().includes('Ubuntu 24.04 LTS')`), await js(`t.view()`));

  // ---- a real button: Domains -> Disable, cancel then approve
  await js(`t.nav('Domains & nginx')`);
  expect('site list renders', await until(`t.view().includes('example.com') && t.view().includes('http://127.0.0.1:3000')`), await js(`t.view()`));
  await js(`t.btn('Disable').click()`);
  expect('button opens the review dialog', await until(`t.modalText().includes('Disable site example.com')`), await js(`t.modalText()`));
  expect('dialog shows the exact command and target', (await js(`t.modalText()`)).includes(`rm -f '/etc/nginx/sites-enabled/example.com'`) && (await js(`t.modalText()`)).includes('deploy@test-host'));
  await js(`t.btn('Cancel', t.modal()).click()`);
  await wait(400);
  expect('cancel runs nothing', changes().length === 0, JSON.stringify(changes()));
  await js(`t.btn('Disable').click()`);
  await until(`!!t.modal()`);
  await js(`t.btn('Run command', t.modal()).click()`);
  expect('approve runs exactly that command as root', await until(`!t.modal()`) && changes().length === 1 && changes()[0].startsWith('sudo -n bash -c ') && changes()[0].includes('rm -f'), JSON.stringify(changes()));

  // ---- a form: New site -> two reviewed steps
  ran.length = 0;
  await until(`!!t.btn('New site')`);
  await js(`t.btn('New site').click()`);
  await js(`(() => { const m = t.modal(); t.type(m.querySelector('input[placeholder="example.com www.example.com"]'), 'new.io www.new.io'); t.type(m.querySelector('input[placeholder="3000"]'), '4000'); t.btn('Create & enable', m).click(); })()`);
  expect('form opens a 2-step review', await until(`t.modalText().includes('Create and enable site new.io') && t.modal().querySelectorAll('.step').length === 2`), await js(`t.modalText()`));
  expect('generated config is viewable before running', (await js(`t.modal().querySelector('details pre').textContent`)).includes('proxy_pass http://127.0.0.1:4000;'));
  await js(`t.btn('Run 2 commands', t.modal()).click()`);
  expect('both approved commands ran, in order', await until(`!t.modal()`) && changes().length === 2 && /cat > "\$f"/.test(changes()[0]) && /ln -sfn/.test(changes()[1]), JSON.stringify(changes()));

  // ---- app templates: Laravel on the next free port, with a certificate in the same review
  await js(`window.api.invoke('settings:save', { certEmail: 'me@example.com' })`);
  ran.length = 0;
  await until(`!!t.btn('New site')`);
  await js(`t.btn('New site').click()`);
  expect('form suggests the next free port for Next.js', await until(`t.modal().querySelector('input[placeholder="3000"]').value === '3001'`), await js(`t.modalText()`));
  await js(`(() => { const m = t.modal(); t.type(m.querySelector('input[placeholder="example.com www.example.com"]'), 'shop.io'); const sel = m.querySelector('select'); sel.value = 'laravel'; sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  expect('switching to Laravel suggests its next free port', await until(`(t.modal().querySelector('input[placeholder="8000"]') || {}).value === '8001'`), await js(`t.modalText()`));
  await js(`(() => { const m = t.modal(); m.querySelector('#site-https').click(); t.btn('Create & enable', m).click(); })()`);
  expect('review covers site + certificate in 3 steps', await until(`t.modalText().includes('Create and enable site shop.io with HTTPS') && t.modal().querySelectorAll('.step').length === 3`), await js(`t.modalText()`));
  const laravelDialog = await js(`t.modalText() + t.modal().querySelector('details pre').textContent`);
  expect('generated Laravel config uses the suggested port; certbot command is shown', laravelDialog.includes('proxy_pass http://127.0.0.1:8001;') && laravelDialog.includes('client_max_body_size 100m;') && laravelDialog.includes('certbot --nginx') && laravelDialog.includes("-d 'shop.io'") && laravelDialog.includes('me@example.com'), laravelDialog);
  await js(`t.btn('Run 3 commands', t.modal()).click()`);
  await until(`!t.modal()`);
  for (const end = Date.now() + 6000; Date.now() < end && changes().length < 3; ) await wait(100);
  await wait(300);
  expect('site written, enabled, then certbot run', changes().length === 3 && /cat > "\$f"/.test(changes()[0]) && /ln -sfn/.test(changes()[1]) && changes()[2].includes('certbot --nginx'), JSON.stringify(changes()).slice(0, 600));
  await js(`window.api.invoke('settings:save', { certEmail: '' })`); // later sections expect no Let's Encrypt email


  // ---- inputs are validated before anything is planned
  const bad1 = await js(`window.api.invoke('nginx:enable', 'example.com')`);
  const bad2 = await js(`window.api.invoke('nginx:enable', { name: 'x; rm -rf /' })`);
  const bad3 = await js(`window.api.invoke('docker:container', { name: 'web', action: 'rm' })`);
  expect('malformed inputs are rejected with no dialog', [bad1, bad2, bad3].every((r) => r.ok === false && !r.cancelled) && !(await js(`!!t.modal()`)), JSON.stringify([bad1, bad2, bad3]));

  // ---- launch form: the user's repositories are listed, filterable, and one click fills the form
  await js(`t.btn('Launch from GitHub').click()`);
  expect('launch form lists the repositories from GitHub', await until(`t.modalText().includes('me/shop-frontend') && t.modalText().includes('me/blog') && t.modalText().includes('2 repositories from your GitHub token')`), await js(`t.modalText()`));
  expect('private repos are marked', await js(`[...t.modal().querySelectorAll('.repo-item')].find((b) => b.textContent.includes('me/shop-frontend')).textContent.includes('private')`));
  await js(`t.type(t.modal().querySelector('input[placeholder="your-github-user/myapp"]'), 'blo')`);
  expect('typing filters the list', await js(`t.modal().querySelectorAll('.repo-item').length === 1 && t.modal().querySelector('.repo-item').textContent.includes('me/blog')`));
  await js(`t.modal().querySelector('.repo-item').click()`);
  expect(
    'choosing a repo fills the repository, project name, folder and default branch hint',
    await js(`(() => { const m = t.modal(); return m.querySelector('input[placeholder="your-github-user/myapp"]').value === 'me/blog' && m.querySelector('input[placeholder="myapp"]').value === 'blog' && m.querySelector('input[placeholder="/opt/apps/myapp"]').value === '/opt/apps/blog' && !!m.querySelector('input[placeholder^="master"]') && m.querySelector('.repo-list').classList.contains('hidden'); })()`),
    await js(`t.modalText()`)
  );
  await js(`t.btn('Cancel', t.modal()).click()`);

  // ---- launch from GitHub: project + clone/deploy + nginx site in one form and one review
  ran.length = 0;
  stdins.length = 0;
  await js(`t.btn('Launch from GitHub').click()`);
  expect('launch form opens', await until(`t.modalText().includes('Launch from GitHub') && !!t.btn('Review & launch', t.modal())`), await js(`t.modalText()`));
  expect('launch form has HTTPS ticked by default and asks for the email it still needs', await js(`t.modal().querySelector('#launch-https').checked && !t.modal().querySelector('#launch-https').disabled && t.modalText().includes('redirect HTTP to HTTPS') && !!t.modal().querySelector('input[placeholder="you@example.com"]') && !t.modal().querySelector('input[placeholder="you@example.com"]').closest('.field').classList.contains('hidden')`), await js(`t.modalText()`));
  await js(`t.btn('Review & launch', t.modal()).click()`);
  expect('HTTPS without an email is stopped in the form, before any review', (await until(`document.getElementById('toasts').innerText.includes("Enter your email for the Let's Encrypt certificate")`)) && (await js(`t.modalText().includes('Launch from GitHub') && !t.modalText().includes('Nothing has been changed yet')`)), await js(`document.getElementById('toasts').innerText`));
  expect('launch form suggests the next free port', await until(`t.modal().querySelector('input[placeholder="3000"]').value === '3001' && t.modalText().includes('3001 is the next free port')`), await js(`t.modal().querySelector('input[placeholder="3000"]').value + ' / ' + t.modalText()`));
  await js(`(() => { const m = t.modal(); const set = (ph, v) => t.type(m.querySelector('input[placeholder="' + ph + '"]'), v);
    set('your-github-user/myapp', 'https://github.com/me/site.git'); set("the repo's default branch", 'main'); set('example.com www.example.com', 'site.io'); set('3000', '4100'); m.querySelector('#launch-https').checked = false; })()`);
  expect('project name and folder follow the repo', await js(`t.modal().querySelector('input[placeholder="myapp"]').value === 'site' && t.modal().querySelector('input[placeholder="/opt/apps/myapp"]').value === '/opt/apps/site'`));
  await js(`t.btn('Review & launch', t.modal()).click()`);
  expect('launch opens one review with all 4 steps', await until(`t.modalText().includes('Launch me/site on site.io') && t.modal().querySelectorAll('.step').length === 4`), await js(`t.modalText()`));
  const launchDialog = await js(`t.modalText()`);
  expect('review names the clone, the deploy command and the nginx site', launchDialog.includes('Clone me/site (branch main) into /opt/apps/site') && launchDialog.includes('docker compose up -d --build') && launchDialog.includes('/etc/nginx/sites-available/site.io'), launchDialog);
  expect('before approval nothing has changed', changes().length === 0, JSON.stringify(changes()));
  await js(`t.btn('Run 4 commands', t.modal()).click()`);
  expect(
    'after approval a progress window lists the 4 steps and ends with all of them done',
    await until(`t.modalText().includes('All 4 steps completed') && t.modal().querySelectorAll('.progress-step[data-state="ok"]').length === 4`, 8000),
    await js(`t.modalText()`)
  );
  expect('each step shows its own output', await js(`t.modal().querySelectorAll('.progress-step')[1].innerText.includes('Cloning into /opt/apps/site and deploying')`), await js(`t.modalText()`));
  expect('the launch form is gone once the run succeeded', await js(`document.querySelectorAll('.overlay').length === 1`));
  await js(`t.btn('Close', t.modal()).click()`);
  expect(
    'approved launch runs config, deploy, site, enable in order and closes the form',
    (await until(`!t.modal()`)) && changes().length === 4 && changes()[0].includes('config.json.tmp') && changes()[1].includes('deploy-agent.py run') && /cat > "\$f"/.test(changes()[2]) && /ln -sfn/.test(changes()[3]),
    JSON.stringify(changes())
  );
  const launchCfg = JSON.parse(stdins[ran.findIndex((l) => l.includes('config.json.tmp'))] || '{}').projects || [];
  expect('launch added the project and kept the existing one', launchCfg.length === 2 && launchCfg[1].name === 'site' && launchCfg[1].repo === 'me/site' && launchCfg[1].branch === 'main' && launchCfg[1].path === '/opt/apps/site', JSON.stringify(launchCfg));
  expect('launch output is shown in the job drawer', await until(`document.getElementById('job-out').textContent.includes('me/site is live at http://site.io')`), await js(`document.getElementById('job-out').textContent`));

  // ---- launch with a GitHub token: the push webhook joins the same review, secret hidden
  ran.length = 0;
  const ghBefore = ghCalls.length;
  await js(`window.launch2 = window.api.invoke('deploy:launch', { repo: 'me/hooked', domains: 'hooked.io', upstreamPort: 4200, branch: 'main', deployKey: false, webhook: true, https: false }); 0`);
  expect('launch with a webhook reviews 5 steps', await until(`t.modalText().includes('Launch me/hooked on hooked.io') && t.modal().querySelectorAll('.step').length === 5`), await js(`t.modalText()`));
  const launchHookDialog = await js(`t.modalText()`);
  expect('review shows the webhook request without the secret', launchHookDialog.includes('POST https://api.github.com/repos/me/hooked/hooks') && launchHookDialog.includes('https://deploy.example.com/hooks/github') && !launchHookDialog.includes('s3cret'), launchHookDialog);
  await js(`t.btn('Cancel', t.modal()).click()`);
  const launch2 = await js(`window.launch2`);
  expect('cancelled launch creates no webhook and changes nothing', launch2.cancelled === true && changes().length === 0 && ghCalls.slice(ghBefore).every((c) => c.method === 'GET'), JSON.stringify([launch2, changes(), ghCalls.slice(ghBefore)]));

  // ---- per-repo deploy key: server keygen + GitHub API call + config, all in one review
  ran.length = 0;
  stdins.length = 0;
  await js(`t.nav('Auto-deploy')`);
  expect('project list renders', await until(`t.view().includes('me/app') && !!t.btn('Add deploy key')`), await js(`t.view()`));
  await js(`t.btn('Add deploy key').click()`);
  expect('deploy key review lists 3 steps', await until(`t.modalText().includes('Add a GitHub deploy key for app') && t.modal().querySelectorAll('.step').length === 3`), await js(`t.modalText()`));
  const keyDialog = await js(`t.modalText()`);
  expect('review shows the GitHub request and marks it as such', keyDialog.includes('POST https://api.github.com/repos/me/app/keys') && keyDialog.includes('"read_only": true') && keyDialog.includes('GitHub API') && keyDialog.includes('ssh-keygen'), keyDialog);
  expect('before approval: GitHub was only read, server unchanged', ghCalls.length >= 1 && ghCalls.every((c) => c.method === 'GET') && changes().length === 0, JSON.stringify([ghCalls, changes()]));
  await js(`t.btn('Run 3 commands', t.modal()).click()`);
  await until(`!t.modal()`);
  // The three steps run one after another after the dialog closes: wait for the last one.
  for (const end = Date.now() + 6000; Date.now() < end && !ran.some((l) => l.includes('config.json.tmp')); ) await wait(100);
  await wait(300);
  const posts = ghCalls.filter((c) => c.method === 'POST');
  expect(
    'key generated on the server, then its public half posted to GitHub read-only',
    changes().length === 2 && changes()[0].includes('ssh-keygen') && posts.length === 1 && posts[0].url === 'https://api.github.com/repos/me/app/keys' && posts[0].body.key === 'ssh-ed25519 AAAATESTKEY deploy-app' && posts[0].body.read_only === true && posts[0].auth === 'Bearer test-token',
    JSON.stringify([posts, changes()])
  );
  const cfgWrite = stdins[ran.findIndex((l) => l.includes('config.json.tmp'))] || '{}';
  expect('project is pointed at its own key', (JSON.parse(cfgWrite).projects || [{}])[0].ssh_key === '/root/.ssh/deploy_app_ed25519', cfgWrite);

  // ---- webhook: created through the GitHub API after review, secret never displayed
  ran.length = 0;
  stdins.length = 0;
  ghCalls.length = 0;
  await until(`!!t.btn('Add webhook')`);
  await js(`t.btn('Add webhook').click()`);
  expect('webhook review opens with 2 steps', await until(`t.modalText().includes('Set up the GitHub webhook for app') && t.modal().querySelectorAll('.step').length === 2`), await js(`t.modalText()`));
  const hookDialog = await js(`t.modalText()`);
  expect('review shows the request and the URL but not the secret', hookDialog.includes('POST https://api.github.com/repos/me/app/hooks') && hookDialog.includes('https://deploy.example.com/hooks/github') && hookDialog.includes('"push"') && !hookDialog.includes('s3cret'), hookDialog);
  expect('before approval nothing was created', ghCalls.every((c) => c.method === 'GET') && changes().length === 0, JSON.stringify(ghCalls));
  await js(`t.btn('Run 2 commands', t.modal()).click()`);
  await until(`!t.modal()`);
  for (const end = Date.now() + 6000; Date.now() < end && !ran.some((l) => l.includes('config.json.tmp')); ) await wait(100);
  await wait(300);
  const hookPost = ghCalls.find((c) => c.method === 'POST');
  expect(
    'webhook created with the real secret, json payloads, push events only',
    !!hookPost && hookPost.url === 'https://api.github.com/repos/me/app/hooks' && hookPost.body.config.url === 'https://deploy.example.com/hooks/github' && hookPost.body.config.secret === 's3cret' && hookPost.body.config.content_type === 'json' && JSON.stringify(hookPost.body.events) === '["push"]' && hookPost.body.active === true,
    JSON.stringify(hookPost)
  );
  const hookCfg = stdins[ran.findIndex((l) => l.includes('config.json.tmp'))] || '{}';
  expect('project records its webhook URL', (JSON.parse(hookCfg).projects || [{}])[0].webhook_url === 'https://deploy.example.com/hooks/github', hookCfg);

  // an existing webhook for the same URL is updated in place, not duplicated
  ghHooks.push({ id: 77, active: true, events: ['push'], config: { url: 'https://deploy.example.com/hooks/github', content_type: 'json' } });
  ghCalls.length = 0;
  const again = js(`window.api.invoke('deploy:webhook', { name: 'app' })`);
  expect('existing webhook: review proposes an update', await until(`t.modalText().includes('PATCH https://api.github.com/repos/me/app/hooks/77')`), await js(`t.modalText()`));
  await js(`[...t.modal().querySelectorAll('footer button')].find((b) => /^Run/.test(b.textContent)).click()`);
  const againResult = await again;
  expect('existing webhook is patched with the secret, none created', againResult.ok && againResult.data.updated === true && ghCalls.some((c) => c.method === 'PATCH' && c.body.config.secret === 's3cret') && !ghCalls.some((c) => c.method === 'POST'), JSON.stringify([againResult, ghCalls]));
  ghHooks.length = 0;

  // ---- the assistant: a side panel next to the current screen; reads freely, asks before changing
  ran.length = 0;
  expect('assistant is a side panel, not a screen', (await js(`!t.btn('Assistant', document.getElementById('nav')) && !document.getElementById('assistant').classList.contains('hidden')`)) && (await js(`t.view()`)).includes('example.com'));
  await js(`t.btn('Assistant', document.getElementById('titlebar')).click()`);
  expect('top bar button hides the panel', await js(`document.getElementById('assistant').classList.contains('hidden')`));
  script.push(toolCall('Let me look.', 'nginx_list', {}, 'tu_1'), toolCall("I'll enable example.com.", 'nginx_enable', { name: 'example.com' }, 'tu_2'), reply('**Enabled** `example.com`.'));
  await js(`(() => { const box = document.querySelector('.composer textarea'); box.value = 'enable example.com'; t.btn('Send').click(); })()`);
  expect('assistant asks in the panel before changing, with the exact command', await until(`t.askText().includes('Enable site example.com') && t.askText().includes('ln -sfn')`), await js(`t.chat() + t.modalText()`));
  expect('the question re-opens a hidden panel and uses no dialog', await js(`!document.getElementById('assistant').classList.contains('hidden') && !t.modal()`));
  expect('it said what it was about to do first', (await js(`t.chat()`)).includes("I'll enable example.com."));
  expect('assistant read ran without a dialog; change has not run yet', ran.some((l) => /python3 -/.test(l)) && changes().length === 0, JSON.stringify(changes()));
  await js(`t.btn('Run command', t.ask()).click()`);
  expect('approved assistant change runs', await until(`t.chat().includes('Enabled')`) && changes().length === 1 && /ln -sfn/.test(changes()[0]), JSON.stringify(changes()));
  const view1 = await js(`t.chat()`);
  expect('transcript shows the message, both steps and the reply', view1.includes('enable example.com') && view1.includes('nginx › list') && view1.includes('Enable site example.com') && view1.includes('Done') && !(await js(`!!t.ask()`)), view1);
  expect('reply markdown is rendered, not shown raw', (await js(`!!document.querySelector('.msg.assistant strong') && !!document.querySelector('.msg.assistant code')`)) && !view1.includes('**'));
  const listResult = modelRequests[1].messages[2].content[0].content;
  expect('model sees a summary, not raw file contents', listResult.includes('example.com') && !listResult.includes('proxy_pass'), listResult);
  expect('model request uses the registry as tools', modelRequests[0].tools.some((x) => x.name === 'nginx_create') && modelRequests[0].tools.some((x) => x.name === 'deploy_run') && modelRequests[0].model === 'claude-opus-5-5');

  ran.length = 0;
  script.push(toolCall('Disabling it.', 'nginx_disable', { name: 'example.com' }, 'tu_3'), reply('Understood, I left it enabled.'));
  await js(`(() => { const box = document.querySelector('.composer textarea'); box.value = 'now disable it'; t.btn('Send').click(); })()`);
  await until(`t.askText().includes('Disable site example.com')`);
  await js(`t.btn("Don't run", t.ask()).click()`);
  expect('declined assistant change runs nothing and the model is told', (await until(`t.chat().includes('left it enabled')`)) && changes().length === 0 && /chose not to run it/.test(modelRequests.at(-1).messages.at(-1).content[0].content), JSON.stringify(changes()));
  expect('transcript marks the step as not run', (await js(`t.chat()`)).includes('Not run'));

  // ---- Stop while a question is open withdraws it; the follow-up still has the conversation
  script.push(toolCall('Reloading nginx.', 'nginx_reload', {}, 'tu_4'), reply('Still here.'));
  await js(`(() => { const box = document.querySelector('.composer textarea'); box.value = 'reload nginx'; t.btn('Send').click(); })()`);
  await until(`t.askText().includes('Reload nginx')`);
  await js(`t.btn('Stop').click()`);
  expect('Stop withdraws the open question and runs nothing', (await until(`!t.ask() && t.chat().includes('Stopped.') && !t.btn('Send').classList.contains('hidden')`)) && changes().length === 0, await js(`t.chat()`));
  await js(`(() => { const box = document.querySelector('.composer textarea'); box.value = 'what did I ask first?'; t.btn('Send').click(); })()`);
  expect('later messages carry the earlier conversation', (await until(`t.chat().includes('Still here.')`)) && modelRequests.at(-1).messages[0].content === 'enable example.com' && modelRequests.at(-1).messages.length > 5, JSON.stringify(modelRequests.at(-1).messages.map((m) => m.role)));

  // ---- transcript survives leaving the screen; settings has the key card
  await js(`t.nav('Settings')`);
  expect('settings shows the AI key card', await until(`t.view().includes('Anthropic API key')`));
  expect('the panel and its transcript stay put when switching screens', await until(`t.chat().includes('left it enabled') && t.chat().includes('enable example.com')`));

  // ---- .env: a cloned project without one gets it in one reviewed click, on a port chosen for it
  ran.length = 0;
  stdins.length = 0;
  await js(`t.nav('Auto-deploy')`);
  expect('a cloned project without .env says so and offers to set it up', await until(`t.view().includes('No .env') && !!t.btn('Set up .env')`, 8000), await js(`t.view()`));
  await js(`t.btn('Set up .env').click()`);
  expect('.env review: save the chosen port, then create .env with it', await until(`t.modalText().includes('Set up .env for app') && t.modal().querySelectorAll('.step').length === 2 && t.modalText().includes('create .env from .env.example and set APP_PORT=3001')`, 8000), await js(`t.modalText()`));
  expect('before approval nothing has changed', changes().length === 0, JSON.stringify(changes()));
  await js(`t.btn('Run 2 commands', t.modal()).click()`);
  for (const end = Date.now() + 6000; Date.now() < end && !ran.some((l) => l.includes('deploy-agent.py env')); ) await wait(100);
  const envCfg = stdins[ran.findIndex((l) => l.includes('config.json.tmp'))] || '{}';
  expect('approved: the port is saved on the project and the agent sets up .env', changes().length === 2 && (JSON.parse(envCfg).projects || [{}])[0].app_port === 3001 && changes()[1].includes('deploy-agent.py env'), JSON.stringify([changes(), envCfg]));
  await wait(400);

  // ---- DNS: zones and records come from the Vultr API; pointing a site at the server is reviewed first
  ran.length = 0;
  await js(`t.nav('DNS')`);
  expect('DNS screen lists the zones, not their records', (await until(`!!document.querySelector('#view tr.clickable')`, 8000)) && !(await js(`t.view().includes('www.example.com') || !!document.querySelector('#view .crumbs')`)), await js(`t.view()`));
  await js(`document.querySelector('#view tr.clickable').click()`);
  expect('clicking a zone replaces the list with its records under a breadcrumb', await until(`!!document.querySelector('#view .crumbs') && document.querySelector('#view .crumbs').innerText.replace(/\\s+/g, ' ').includes('DNS › example.com') && t.view().includes('www.example.com') && !document.querySelector('#view tr.clickable')`, 8000), await js(`t.view()`));
  await js(`t.btn('Refresh').click()`);
  expect('refresh stays on the zone page', (await until(`t.view().includes('www.example.com')`, 8000)) && (await js(`!!document.querySelector('#view .crumbs')`)));
  await js(`t.btn('DNS', document.querySelector('#view .crumbs')).click()`);
  expect('the DNS breadcrumb goes back to the list', await until(`!!document.querySelector('#view tr.clickable') && !document.querySelector('#view .crumbs')`, 8000), await js(`t.view()`));
  // a site whose deploy project has no webhook says so and offers to add it
  READS.deploy.config.projects[0].app_port = 3000; // the port example.com forwards to
  await js(`t.nav('Domains & nginx')`);
  expect('a site without its webhook is flagged, with a button to add it', await until(`t.view().includes('No webhook') && !!t.btn('Add webhook')`, 8000), await js(`t.view()`));
  await js(`t.btn('Add webhook').click()`);
  expect('the button opens the webhook review for the project behind that site', await until(`t.modalText().includes('Set up the GitHub webhook for app')`, 8000), await js(`t.modalText()`));
  await js(`t.btn('Cancel', t.modal()).click()`);
  await until(`!t.modal()`);
  await until(`!!t.btn('Point DNS here')`);
  vultrCalls.length = 0;
  await js(`t.btn('Point DNS here').click()`);
  expect('pointing DNS opens a review with one step', await until(`t.modalText().includes('Point example.com at this server') && t.modal().querySelectorAll('.step').length === 1`, 8000), await js(`t.modalText()`));
  const dnsDialog = await js(`t.modalText()`);
  expect('review shows the exact Vultr request', dnsDialog.includes('POST https://api.vultr.com/v2/domains/example.com/records') && dnsDialog.includes('"data": "203.0.113.5"') && dnsDialog.includes('Vultr API') && !dnsDialog.includes('vultr-test'), dnsDialog);
  expect('before approval Vultr was only read', vultrCalls.length > 0 && vultrCalls.every((c) => c.method === 'GET'), JSON.stringify(vultrCalls));
  await js(`t.btn('Run command', t.modal()).click()`);
  for (const end = Date.now() + 6000; Date.now() < end && !vultrCalls.some((c) => c.method === 'POST'); ) await wait(100);
  const dnsPost = vultrCalls.find((c) => c.method === 'POST');
  expect(
    'approved: the A record is created with the saved key, and the server is untouched',
    !!dnsPost && dnsPost.url === 'https://api.vultr.com/v2/domains/example.com/records' && JSON.stringify(dnsPost.body) === '{"name":"","type":"A","data":"203.0.113.5","ttl":300}' && dnsPost.auth === 'Bearer vultr-test' && changes().length === 0,
    JSON.stringify([vultrCalls, changes()])
  );

  // ---- a deploy in progress shows on the screen, in the menu and on the taskbar button
  const win = BrowserWindow.getAllWindows()[0];
  const taskbar = { progress: [], overlay: [] };
  const setProgressBar = win.setProgressBar.bind(win);
  const setOverlayIcon = win.setOverlayIcon.bind(win);
  win.setProgressBar = (v, o) => (taskbar.progress.push([v, o && o.mode]), setProgressBar(v, o));
  win.setOverlayIcon = (img, d) => (taskbar.overlay.push(img ? [img.getSize().width, d] : null), setOverlayIcon(img, d));
  ACTIVITY.deploying = true;
  await js(`t.nav('Deploying now')`);
  expect('the deploy is listed with its current step', await until(`t.view().includes('app') && t.view().includes('pushed to GitHub') && t.view().includes('docker compose up -d --build --remove-orphans')`, 8000), await js(`t.view()`));
  expect('the menu shows the count', await until(`document.querySelector('#nav .nav-count:not(.hidden)')?.textContent === '1'`, 4000), await js(`document.getElementById('nav').innerText`));
  const busy = Date.now() + 4000;
  while (Date.now() < busy && !(taskbar.overlay.some(Boolean) && win.getTitle().includes('1 deploying'))) await wait(100);
  expect('the taskbar button gets a moving progress bar, a count badge and a title', JSON.stringify(taskbar.progress[0]) === '[1,"indeterminate"]' && JSON.stringify(taskbar.overlay.find(Boolean)) === '[32,"1 deploying"]' && win.getTitle() === 'VPS Manager — 1 deploying', JSON.stringify([taskbar, win.getTitle()]));
  ACTIVITY.deploying = false;
  const idle = Date.now() + 8000;
  while (Date.now() < idle && win.getTitle() !== 'VPS Manager') await wait(100);
  expect('when it finishes, the taskbar button and the menu go back to normal', JSON.stringify(taskbar.progress[taskbar.progress.length - 1]) === '[-1,"none"]' && taskbar.overlay[taskbar.overlay.length - 1] === null && win.getTitle() === 'VPS Manager' && (await until(`!!document.querySelector('#nav .nav-count.hidden')`, 2000)), JSON.stringify([taskbar, win.getTitle()]));

  expect('no console errors', errors.length === 0, JSON.stringify(errors));
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  app.exit(failures ? 1 : 0);
});
