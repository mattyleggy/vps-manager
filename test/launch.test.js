'use strict';
// deploy:launch end to end against a fake server: the plan shown for review must be exactly
// what the approved run executes, in order, and a failed deploy must leave nginx alone.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Ssh, ops, newOp } = require('../src/main/ssh');
const defineActions = require('../src/main/actions');
const { launchInput } = defineActions;

const CONFIG = { secret: 's3cret', port: 9321, public_host: 'deploy.example.com', projects: [{ name: 'app', repo: 'me/app', branch: 'master', path: '/opt/apps/app', command: '', auto: true }] };

function setup({ deployExit = 0, certEmail = 'me@example.com', token = true } = {}) {
  const ssh = new Ssh();
  const ran = []; // [{ line, stdin }] for every command that reached the "server"
  ssh.info = { host: '203.0.113.5', username: 'root', isRoot: true };
  ssh.client = {
    exec(line, cb) {
      const entry = { line, stdin: '' };
      ran.push(entry);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = (stdin) =>
        setImmediate(() => {
          entry.stdin = String(stdin || '');
          let [code, out] = [0, ''];
          if (line.includes('python3 -')) out = JSON.stringify({ installed: true, https: true, config: CONFIG }); // deploy status
          else if (line.includes('config.json') && !line.includes('.tmp')) out = JSON.stringify(CONFIG);
          else if (line.includes('.pub') && !line.includes('ssh-keygen')) code = 1; // no key yet
          else if (line.includes('ssh-keygen')) out = 'ssh-ed25519 AAAANEW deploy-site\n';
          else if (line.includes('test -e')) code = 1; // no such nginx site yet
          else if (line.includes('deploy-agent.py run')) code = deployExit;
          if (out) stream.emit('data', Buffer.from(out));
          stream.emit('close', code);
        });
      cb(null, stream);
    },
  };
  const gh = { posts: [], hooks: [] };
  const github = {
    hasToken: () => token,
    keyBody: (k) => String(k).trim().split(/\s+/).slice(0, 2).join(' '),
    defaultBranch: async () => 'main',
    listDeployKeys: async () => [],
    addDeployKey: async (repo, title, key) => gh.posts.push({ repo, key }),
    listHooks: async () => [],
    createHook: async (repo, hook) => gh.hooks.push({ repo, ...hook }),
  };
  const nginx = require('../src/main/remote/nginx')(ssh);
  const deploy = require('../src/main/remote/deploy')(ssh, nginx, github);
  const job = async (_title, fn) => ({ code: await fn(() => {}) });
  const actions = defineActions({ ssh, store: { get: () => ({ certEmail }) }, system: { info: async () => ({ ips: [] }) }, nginx, docker: {}, deploy, github, shellJob: null, job });
  const launch = actions.find((a) => a.id === 'deploy:launch');
  const isRead = (l) => l.includes('python3 -') || (l.includes('config.json') && !l.includes('.tmp')) || (l.includes('.pub') && !l.includes('ssh-keygen')) || l.includes('test -e');
  const changes = () => ran.filter((r) => !isRead(r.line));
  return { launch, ran, changes, gh };
}

async function planThenApply(launch, input) {
  const op = newOp();
  await ops.run(op, () => launch.run(input));
  const planned = op.steps.map((s) => s.what);
  op.mode = 'apply';
  const result = await ops.run(op, () => launch.run(input));
  return { op, planned, result };
}

test('launch plans every step and the approved run executes exactly those, in order', async () => {
  const { launch, changes, gh } = setup();
  const input = { repo: 'https://github.com/me/site.git', domains: 'site.io www.site.io', upstreamPort: 4000 };
  const op = newOp();
  await ops.run(op, () => launch.run(input));
  assert.strictEqual(changes().length, 0, 'planning must not change the server');
  assert.strictEqual(gh.posts.length + gh.hooks.length, 0, 'planning must not change GitHub');
  assert.deepStrictEqual(
    op.steps.map((s) => s.what.split(/[ ,]/).slice(0, 2).join(' ')),
    ['Generate an', 'Add the', 'Create a', 'Add the', 'Clone me/site', 'Back up', 'Link site.io', 'Get a']
  );
  assert.deepStrictEqual([op.steps[1].via, op.steps[2].via], ['GitHub API', 'GitHub API']);
  assert.match(op.steps[2].cmd, /^POST https:\/\/api\.github\.com\/repos\/me\/site\/hooks\n/);
  assert.ok(!op.steps[2].cmd.includes('s3cret'), 'the review never shows the webhook secret');

  op.mode = 'apply';
  const result = await ops.run(op, () => launch.run(input));
  assert.strictEqual(result.code, 0);
  const lines = changes().map((r) => r.line);
  assert.strictEqual(lines.length, 6); // the two GitHub steps are not SSH commands
  assert.match(lines[0], /ssh-keygen/);
  assert.match(lines[1], /config\.json\.tmp/);
  assert.match(lines[2], /deploy-agent\.py run '\\''site'\\'' --trigger manual/);
  assert.match(lines[3], /cat > "\$f"/);
  assert.match(lines[4], /ln -sfn/);
  assert.match(lines[5], /certbot --nginx .* -d '\\''site\.io'\\'' -d '\\''www\.site\.io'\\''/);
  assert.deepStrictEqual(gh.posts, [{ repo: 'me/site', key: 'ssh-ed25519 AAAANEW deploy-site' }]);
  assert.deepStrictEqual(gh.hooks, [{ repo: 'me/site', active: true, events: ['push'], config: { url: 'https://deploy.example.com/hooks/github', content_type: 'json', secret: 's3cret', insecure_ssl: '0' } }]);

  const cfg = JSON.parse(changes()[1].stdin);
  assert.deepStrictEqual(cfg.projects[1], { name: 'site', repo: 'me/site', branch: 'main', path: '/opt/apps/site', command: '', auto: true, app_port: 4000, ssh_key: '/root/.ssh/deploy_site_ed25519', webhook_url: 'https://deploy.example.com/hooks/github' });
  assert.strictEqual(cfg.projects[0].name, 'app', 'existing projects are kept');
  assert.match(changes()[3].stdin, /server_name site\.io www\.site\.io;[^]*proxy_pass http:\/\/127\.0\.0\.1:4000;/);
});

test('a failed deploy stops the launch before nginx is touched', async () => {
  const { launch, changes } = setup({ deployExit: 1, token: false, certEmail: '' });
  const input = { repo: 'me/site', domains: 'site.io', upstreamPort: 4000, branch: 'main' };
  const op = newOp();
  await ops.run(op, () => launch.run(input));
  op.mode = 'apply';
  await assert.rejects(ops.run(op, () => launch.run(input)), /deploy failed[^]*domain was not set up/);
  const lines = changes().map((r) => r.line);
  assert.strictEqual(lines.length, 2);
  assert.ok(!lines.some((l) => /nginx|certbot/.test(l)), lines.join('\n'));
});

test('a static launch serves the checkout, pulls only, and never exposes .git', async () => {
  const { launch, changes } = setup({ token: false, certEmail: '' });
  const { planned, result } = await planThenApply(launch, { repo: 'me/site', domains: 'site.io', type: 'static', subdir: '/dist/' });
  assert.strictEqual(result.code, 0);
  assert.strictEqual(planned.length, 4); // config, deploy, nginx save, nginx enable: no key, no certificate
  assert.strictEqual(JSON.parse(changes()[0].stdin).projects[1].command, 'git pull --ff-only origin main');
  const site = changes()[2].stdin;
  assert.match(site, /root \/opt\/apps\/site\/dist;/);
  assert.match(site, /location ~ \/\\\.\(\?!well-known\/\) \{\s+deny all;/);
});

test('launch refuses a project name that belongs to another repo, before anything is planned', async () => {
  const { launch } = setup({ token: false, certEmail: '' });
  const op = newOp();
  await assert.rejects(ops.run(op, () => launch.run({ repo: 'other/app', domains: 'a.io', upstreamPort: 1 })), /already exists for me\/app/);
  assert.strictEqual(op.steps.length, 0);
});

test('launch input: defaults, URL forms and the checks that must fail early', () => {
  const on = { hasToken: true, certEmail: 'me@example.com' };
  const off = { hasToken: false, certEmail: '' };
  for (const repo of ['me/My.App', 'https://github.com/me/My.App', 'https://github.com/me/My.App.git/', 'git@github.com:me/My.App.git']) {
    const L = launchInput({ repo, domains: 'A.io, www.a.io', upstreamPort: 3000 }, on);
    assert.deepStrictEqual([L.repo, L.name, L.path, L.site, L.domains], ['me/My.App', 'My-App', '/opt/apps/My-App', 'a.io', ['a.io', 'www.a.io']], repo);
    assert.deepStrictEqual([L.deployKey, L.webhook, L.https, L.auto, L.type], [true, true, true, true, 'proxy']);
  }
  const plain = launchInput({ repo: 'me/app', domains: 'a.io', upstreamPort: 3000 }, off);
  assert.deepStrictEqual([plain.deployKey, plain.webhook, plain.https], [false, false, false]);
  assert.strictEqual(launchInput({ repo: 'me/app', domains: 'a.io', upstreamPort: 3000, auto: false }, on).webhook, false, 'no automatic deploys, no webhook');
  const bad = (input, defaults, re) => assert.throws(() => launchInput({ repo: 'me/app', domains: 'a.io', upstreamPort: 3000, ...input }, defaults), re);
  bad({ repo: 'https://example.com/me/app' }, on, /owner\/name/);
  bad({ repo: 'me/app; rm -rf /' }, on, /owner\/name/);
  bad({ domains: 'not a domain!' }, on, /valid domain/);
  bad({ domains: '  ' }, on, /at least one domain/);
  bad({ upstreamPort: undefined }, on, /local port/);
  bad({ upstreamPort: 0 }, on, /Invalid port/);
  bad({ branch: 'main; reboot' }, on, /branch/);
  bad({ type: 'static', subdir: 'a b' }, on, /Path must be absolute/);
  bad({ type: 'static', subdir: '../etc' }, on, /Path must be absolute/);
  bad({ deployKey: true }, off, /GitHub token/);
  bad({ webhook: true }, off, /GitHub token/);
  bad({ webhook: true, auto: false }, on, /automatic deploys/);
  bad({ https: true }, off, /Let's Encrypt email/);
  bad({ domains: '*.a.io' }, on, /wildcard/i);
});

test('an approved launch reports each step as it starts and how it ended; a failed deploy leaves the rest unstarted', async () => {
  const watch = async (opts) => {
    const { launch } = setup(opts);
    const input = { repo: 'me/site', domains: 'site.io', upstreamPort: 4000, branch: 'main', deployKey: false, webhook: false, https: false };
    const op = newOp();
    await ops.run(op, () => launch.run(input));
    const events = [];
    op.onStep = (index, state) => events.push(`${index}:${state}`);
    op.mode = 'apply';
    const result = await ops.run(op, () => launch.run(input)).catch((e) => ({ error: e.message }));
    return { events, steps: op.steps.length, result };
  };
  const good = await watch({});
  assert.strictEqual(good.steps, 4);
  assert.deepStrictEqual(good.events, ['0:run', '0:ok', '1:run', '1:ok', '2:run', '2:ok', '3:run', '3:ok']);
  const bad = await watch({ deployExit: 1 });
  assert.deepStrictEqual(bad.events, ['0:run', '0:ok', '1:run', '1:fail']);
});
