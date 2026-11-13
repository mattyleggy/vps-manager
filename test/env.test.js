'use strict';
// App ports and .env set-up: every new deploy project gets a port of its own, a project that is
// already cloned gets its .env in one reviewed step, and "New site" is offered a waiting project's port.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Ssh, ops, newOp } = require('../src/main/ssh');
const defineActions = require('../src/main/actions');

const SITE = (port) => ({ name: 'shop.io', path: '/etc/nginx/sites-available/shop.io', kind: 'site', enabled: true, certExpiry: {}, content: `server { listen 80; server_name shop.io; location / { proxy_pass http://127.0.0.1:${port}; } }` });

/**
 * projects: the agent config's projects. live: per project name, what the status read finds on
 * disk ({ cloned, env }). sites: nginx sites. agentVersion: omit for "same as this app".
 */
function setup({ projects, live = {}, sites = [], agentVersion, listening = '22\n80\n3000\n', github = {}, origin = '' }) {
  const ssh = new Ssh();
  const ran = [];
  ssh.info = { host: '203.0.113.5', username: 'root', isRoot: true };
  const nginx = require('../src/main/remote/nginx')(ssh);
  const deploy = require('../src/main/remote/deploy')(ssh, nginx, github);
  const config = { secret: 's3cret', port: 9321, projects };
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
          let out = '';
          if (line.includes('python3 -') && entry.stdin.includes('history.jsonl')) {
            out = JSON.stringify({ installed: true, version: agentVersion || deploy.localVersion(), active: 'active', history: [], repoKeys: {}, config: { ...config, projects: projects.map((p) => ({ ...p, cloned: false, env: null, ...(live[p.name] || {}) })) } });
          } else if (line.includes('python3 -')) out = JSON.stringify({ installed: true, sites });
          else if (line.includes('ss -ltnH')) out = listening;
          else if (line.includes('config.json') && !line.includes('.tmp')) out = JSON.stringify(config);
          else if (line.includes('deploy-agent.py env')) out = 'set APP_PORT in .env\n';
          else if (line.includes('remote.origin.url')) out = origin;
          else if (line.includes('ssh-keygen')) out = 'ssh-ed25519 AAAAnew deploy-shop\n';
          if (out) stream.emit('data', Buffer.from(out));
          stream.emit('close', 0);
        });
      cb(null, stream);
    },
  };
  const actions = defineActions({ ssh, store: { get: () => ({}) }, system: {}, nginx, docker: {}, deploy, github, vultr: {}, shellJob: null, job: null });
  const isRead = (l) => l.includes('python3 -') || l.includes('ss -ltnH') || l.includes('remote.origin.url') || /cat \S*\.pub/.test(l) || (l.includes('config.json') && !l.includes('.tmp'));
  const run = async (id, input) => {
    const action = actions.find((a) => a.id === id);
    const op = newOp();
    await ops.run(op, () => action.run(input));
    const changedWhilePlanning = ran.filter((r) => !isRead(r.line)).length;
    op.mode = 'apply';
    const result = await ops.run(op, () => action.run(input));
    const changes = ran.filter((r) => !isRead(r.line));
    const written = changes.filter((r) => r.line.includes('config.json.tmp')).map((r) => JSON.parse(r.stdin));
    return { steps: op.steps, result, changes, written, changedWhilePlanning };
  };
  return { run, actions };
}

const project = (name, extra = {}) => ({ name, repo: `me/${name}`, branch: 'master', path: `/srv/${name}`, command: '', auto: true, ...extra });

test('a new project gets the next free port, skipping listening ports and other projects', async () => {
  const { run } = setup({ projects: [project('app', { app_port: 3001 })] });
  const { written } = await run('deploy:saveProject', { project: { name: 'shop', repo: 'me/shop', path: '/srv/shop' } });
  assert.strictEqual(written[0].projects[1].app_port, 3002); // 3000 is listening, 3001 belongs to "app"
});

test('a port given for a project is used, and an edit that leaves it out keeps the saved one', async () => {
  const a = setup({ projects: [] });
  assert.strictEqual((await a.run('deploy:saveProject', { project: { name: 'shop', repo: 'me/shop', path: '/srv/shop', app_port: 4500 } })).written[0].projects[0].app_port, 4500);
  const b = setup({ projects: [project('app', { app_port: 3001 })] });
  const edited = await b.run('deploy:saveProject', { originalName: 'app', project: { name: 'app', repo: 'me/app', path: '/srv/app', branch: 'main' } });
  assert.deepStrictEqual([edited.written[0].projects[0].app_port, edited.written[0].projects[0].branch], [3001, 'main']);
});

test('deploy:env on a project with a saved port only runs the agent, after review', async () => {
  const { run } = setup({ projects: [project('app', { app_port: 3001 })], live: { app: { cloned: true, env: { exists: false, example: true, port: null } } } });
  const { steps, result, changes, changedWhilePlanning } = await run('deploy:env', { name: 'app' });
  assert.strictEqual(changedWhilePlanning, 0);
  assert.strictEqual(result.port, 3001);
  assert.strictEqual(changes.length, 1);
  assert.match(changes[0].line, /deploy-agent\.py env \S*app/);
  assert.match(steps[0].what, /create \.env from \.env\.example and set APP_PORT=3001/);
});

test('deploy:env keeps the port a working app already uses, and saves it on the project', async () => {
  const { run } = setup({ projects: [project('app')], live: { app: { cloned: true, env: { exists: true, example: true, port: 8000 } } }, sites: [SITE(8000)] });
  const { steps, result, changes, written } = await run('deploy:env', { name: 'app' });
  assert.strictEqual(result.port, 8000);
  assert.strictEqual(written[0].projects[0].app_port, 8000);
  assert.deepStrictEqual(changes.map((c) => (c.line.includes('config.json.tmp') ? 'config' : 'env')), ['config', 'env']);
  assert.match(steps[1].what, /keep the existing \.env and set APP_PORT=8000/);
});

test('deploy:env picks a free port when .env has a port no site forwards to, or when one is given', async () => {
  const stale = setup({ projects: [project('app'), project('other', { app_port: 3001 })], live: { app: { cloned: true, env: { exists: true, example: true, port: 8000 } } }, sites: [SITE(3000)] });
  assert.strictEqual((await stale.run('deploy:env', { name: 'app' })).result.port, 3002);
  const given = setup({ projects: [project('app', { app_port: 3001 })], live: { app: { cloned: true, env: { exists: true, example: false, port: 3001 } } } });
  const r = await given.run('deploy:env', { name: 'app', port: 3999 });
  assert.deepStrictEqual([r.result.port, r.written[0].projects[0].app_port], [3999, 3999]);
});

test('deploy:env refuses an outdated agent and a project that is not cloned, before anything is planned', async () => {
  const old = setup({ projects: [project('app')], live: { app: { cloned: true, env: null } }, agentVersion: '1.2.0' });
  await assert.rejects(old.run('deploy:env', { name: 'app' }), /older than this app[^]*Update it/);
  const fresh = setup({ projects: [project('app')] });
  await assert.rejects(fresh.run('deploy:env', { name: 'app' }), /not cloned yet/);
  await assert.rejects(fresh.run('deploy:env', { name: 'nope' }), /not found/);
});

test('the port finder skips project ports and offers the port of a project that has no site yet', async () => {
  const { actions } = setup({ projects: [project('app', { app_port: 3001 }), project('shop', { app_port: 3002 })], sites: [SITE(3001)] });
  const r = await actions.find((a) => a.id === 'nginx:nextPort').run({ from: 3000 });
  assert.strictEqual(r.port, 3003);
  assert.deepStrictEqual(r.waiting, [{ name: 'shop', port: 3002 }]);
});

// ---- saving a project sets up its push webhook in the same reviewed step

function fakeGithub({ token = true, hooks = [], denied = false, keys = [], keysDenied = false } = {}) {
  const created = [];
  const addedKeys = [];
  return {
    created,
    addedKeys,
    hasToken: () => token,
    listDeployKeys: async () => {
      if (keysDenied) throw new Error('The GitHub token cannot manage deploy keys on me/shop.');
      return keys;
    },
    addDeployKey: async (repo, title, key) => addedKeys.push({ repo, title, key }),
    keyBody: (k) => String(k).split(' ').slice(0, 2).join(' '),
    listHooks: async () => {
      if (denied) throw new Error('The GitHub token cannot manage webhooks on me/shop.');
      return hooks;
    },
    createHook: async (repo, hook) => created.push({ repo, ...hook }),
    updateHook: async (repo, id, hook) => created.push({ repo, id, ...hook }),
  };
}
const NEW = { project: { name: 'shop', repo: 'me/shop', path: '/srv/shop' } };

test('adding a project with a token saved also creates its webhook, and nothing is sent while planning', async () => {
  const github = fakeGithub();
  const { run } = setup({ projects: [], github });
  const { steps, result, written, changedWhilePlanning } = await run('deploy:saveProject', NEW);
  assert.strictEqual(changedWhilePlanning, 0);
  assert.strictEqual(result.webhook.status, 'created');
  // Key pair on the server, its public half on GitHub, the webhook, then the config.
  assert.deepStrictEqual(steps.map((s) => s.via || 'ssh'), ['ssh', 'GitHub API', 'GitHub API', 'ssh']);
  assert.ok(!steps[0].cmd.includes('s3cret'), 'the secret is not shown in the review');
  assert.deepStrictEqual(github.created, [{ repo: 'me/shop', active: true, events: ['push'], config: { url: 'http://203.0.113.5:9321/hooks/github', content_type: 'json', secret: 's3cret', insecure_ssl: '0' } }]);
  assert.strictEqual(written[0].projects[0].webhook_url, 'http://203.0.113.5:9321/hooks/github');
});

test('no webhook when deploys are manual, when it is turned off, or when the project already has it', async () => {
  for (const input of [{ project: { ...NEW.project, auto: false } }, { ...NEW, webhook: false }]) {
    const github = fakeGithub();
    const { result } = await setup({ projects: [], github }).run('deploy:saveProject', input);
    assert.deepStrictEqual([result.webhook.status, github.created.length], ['off', 0]);
  }
  const github = fakeGithub();
  const has = setup({ projects: [project('shop', { webhook_url: 'http://203.0.113.5:9321/hooks/github' })], github });
  const { result } = await has.run('deploy:saveProject', { originalName: 'shop', project: { ...NEW.project, branch: 'main' } });
  assert.deepStrictEqual([result.webhook.status, github.created.length], ['kept', 0]);
});

test('without a token, or with one that cannot manage webhooks, the project is still saved and says why', async () => {
  const none = await setup({ projects: [], github: fakeGithub({ token: false }) }).run('deploy:saveProject', NEW);
  assert.deepStrictEqual([none.result.webhook.status, none.written[0].projects[0].name], ['no-token', 'shop']);
  const denied = await setup({ projects: [], github: fakeGithub({ denied: true }) }).run('deploy:saveProject', NEW);
  assert.strictEqual(denied.result.webhook.status, 'skipped');
  assert.match(denied.result.webhook.reason, /cannot manage webhooks/);
  assert.strictEqual(denied.written[0].projects[0].webhook_url, undefined);
  // Asked for explicitly, the same problem is an error and nothing is saved.
  await assert.rejects(setup({ projects: [], github: fakeGithub({ denied: true }) }).run('deploy:saveProject', { ...NEW, webhook: true }), /cannot manage webhooks/);
});

// ---- saving a new project also gives it a read-only deploy key

test('a new project gets its own deploy key with a token saved; the config points at it', async () => {
  const github = fakeGithub();
  const { result, written, changedWhilePlanning } = await setup({ projects: [], github }).run('deploy:saveProject', NEW);
  assert.strictEqual(changedWhilePlanning, 0);
  assert.strictEqual(result.deployKey.status, 'added');
  assert.deepStrictEqual(github.addedKeys.map((k) => [k.repo, k.key.trim()]), [['me/shop', 'ssh-ed25519 AAAAnew deploy-shop']]);
  assert.strictEqual(written[0].projects[0].ssh_key, '/root/.ssh/deploy_shop_ed25519');
  assert.strictEqual(result.remote, null, 'no checkout, nothing to switch');
});

test('no deploy key when turned off, without a token, when editing, or with a token that cannot add keys', async () => {
  const off = fakeGithub();
  assert.strictEqual((await setup({ projects: [], github: off }).run('deploy:saveProject', { ...NEW, deployKey: false })).result.deployKey.status, 'off');
  assert.strictEqual(off.addedKeys.length, 0);
  assert.strictEqual((await setup({ projects: [], github: fakeGithub({ token: false }) }).run('deploy:saveProject', NEW)).result.deployKey.status, 'no-token');
  const edit = fakeGithub();
  const edited = await setup({ projects: [project('shop')], github: edit }).run('deploy:saveProject', { originalName: 'shop', project: NEW.project });
  assert.deepStrictEqual([edited.result.deployKey.status, edit.addedKeys.length], ['off', 0]);
  const denied = await setup({ projects: [], github: fakeGithub({ keysDenied: true }) }).run('deploy:saveProject', NEW);
  assert.strictEqual(denied.result.deployKey.status, 'skipped');
  assert.match(denied.result.deployKey.reason, /cannot manage deploy keys/);
  assert.strictEqual(denied.written[0].projects[0].ssh_key, undefined);
  await assert.rejects(setup({ projects: [], github: fakeGithub({ token: false }) }).run('deploy:saveProject', { ...NEW, deployKey: true }), /needs a GitHub token/);
});

test('an existing checkout pulling over HTTPS is switched to SSH, as a reviewed step, so the key is used', async () => {
  const { steps, result, changes } = await setup({ projects: [], github: fakeGithub(), origin: 'https://github.com/me/shop.git\n' }).run('deploy:saveProject', NEW);
  assert.strictEqual(result.remote, 'https://github.com/me/shop.git');
  const sw = changes.find((c) => c.line.includes('remote set-url'));
  assert.ok(sw && sw.line.includes('git@github.com:me/shop.git'), `remote set-url runs: ${sw && sw.line}`);
  assert.match(steps[steps.length - 1].what, /pull over SSH/);
  // A checkout of another repository, or one already on SSH, is left alone.
  for (const origin of ['https://github.com/someone/else.git', 'git@github.com:me/shop.git']) {
    const r = await setup({ projects: [], github: fakeGithub(), origin }).run('deploy:saveProject', NEW);
    assert.strictEqual(r.result.remote, null, origin);
    assert.ok(!r.changes.some((c) => c.line.includes('remote set-url')), origin);
  }
});
