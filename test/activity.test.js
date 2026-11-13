'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarize, classify } = require('../src/main/remote/activity');

test('classify recognises deploy-ish commands and ignores the rest', () => {
  const kind = (args) => (classify(args) || {}).kind || null;
  assert.strictEqual(kind('docker build -t app .'), 'build');
  assert.strictEqual(kind('/usr/libexec/docker/cli-plugins/docker-buildx buildx build -t app .'), 'build');
  assert.strictEqual(kind('/usr/libexec/docker/cli-plugins/docker-compose compose up -d --build --remove-orphans'), 'compose');
  assert.strictEqual(kind('docker compose pull'), 'compose');
  assert.strictEqual(kind('docker compose up'), null, 'a foreground "up" runs for good');
  assert.strictEqual(kind('docker compose ls -a --format json'), null);
  assert.strictEqual(kind('docker ps -a'), null);
  assert.strictEqual(kind('docker pull nginx:latest'), 'pull');
  assert.strictEqual(kind('git pull --ff-only origin main'), 'git');
  assert.strictEqual(kind('git status'), null);
  assert.strictEqual(kind('/usr/bin/python3 /usr/bin/certbot renew'), 'certbot');
  assert.strictEqual(kind('apt-get install -y nginx'), 'apt');
  assert.strictEqual(kind('/usr/bin/python3 /usr/bin/unattended-upgrade'), 'apt');
  assert.strictEqual(kind('/usr/bin/python3 /usr/share/unattended-upgrades/unattended-upgrade-shutdown --wait-for-signal'), null, 'idles all day on Ubuntu');
  assert.strictEqual(kind('scp -t /srv/app'), 'upload');
  assert.strictEqual(kind('python3 /opt/deploy-agent/deploy-agent.py serve'), null);
  assert.deepStrictEqual(classify('python3 /opt/deploy-agent/deploy-agent.py run shop --trigger manual'), { kind: 'agent', label: undefined, project: 'shop' });
  assert.strictEqual(kind('python3 manage.py runserver'), null);
});

test('a push deploy groups its commands under the project, with log details', () => {
  const r = summarize({
    now: 1000,
    // 1 = the agent (not shown), 10 = bash -c <deploy command>, 11 = docker compose, 12 = buildx
    parents: { 1: 0, 10: 1, 11: 10, 12: 11, 50: 0 },
    procs: [
      { pid: 1, ppid: 0, elapsed: 9000, args: 'python3 /opt/deploy-agent/deploy-agent.py serve', cwd: '/', project: null },
      { pid: 10, ppid: 1, elapsed: 40, args: 'bash -c git pull --ff-only origin main && docker compose up -d --build', cwd: '/srv/shop', project: 'shop' },
      { pid: 11, ppid: 10, elapsed: 30, args: 'docker compose up -d --build', cwd: '/srv/shop', project: 'shop' },
      { pid: 12, ppid: 11, elapsed: 29, args: 'docker-buildx buildx build .', cwd: '/srv/shop', project: 'shop' },
      { pid: 50, ppid: 0, elapsed: 5, args: 'docker build -t other .', cwd: '/srv/other', project: null },
    ],
    deploys: { shop: { log: '/var/log/deploy-agent/shop/x.log', started: 950, trigger: 'push', commit: 'abcdef1234', branch: 'main' } },
    containers: [
      { name: 'shop-web-1', image: 'shop', state: 'running', status: 'Up 4 seconds (health: starting)', labels: 'com.docker.compose.project=shop,x=y' },
      { name: 'db', image: 'postgres', state: 'running', status: 'Up 3 hours', labels: '' },
      { name: 'loop', image: 'bad', state: 'restarting', status: 'Restarting (1) 2 seconds ago', labels: '' },
    ],
    history: [{ project: 'shop', code: 0 }],
  });
  assert.strictEqual(r.active.length, 2);
  const [deploy, build] = r.active;
  assert.strictEqual(deploy.kind, 'agent');
  assert.strictEqual(deploy.project, 'shop');
  assert.strictEqual(deploy.elapsed, 50, 'elapsed comes from the log start');
  assert.strictEqual(deploy.current, 'docker-buildx buildx build .');
  assert.strictEqual(deploy.currentKind, 'build');
  assert.strictEqual(deploy.trigger, 'push');
  assert.strictEqual(deploy.log, '/var/log/deploy-agent/shop/x.log');
  assert.strictEqual(build.kind, 'build');
  assert.strictEqual(build.current, null);
  assert.deepStrictEqual(r.settling.map((c) => c.name), ['shop-web-1', 'loop']);
  assert.strictEqual(r.settling[0].project, 'shop');
  assert.strictEqual(r.recent.length, 1);
});

test('"Deploy now" shows the deploy command, not the python wrapper', () => {
  const r = summarize({
    now: 100,
    parents: { 20: 5, 21: 20, 22: 21 },
    procs: [
      { pid: 20, ppid: 5, elapsed: 12, args: 'python3 /opt/deploy-agent/deploy-agent.py run shop --trigger manual', cwd: '/', project: null },
      { pid: 21, ppid: 20, elapsed: 11, args: 'bash -c git pull && docker compose up -d --build', cwd: '/srv/shop', project: 'shop' },
      { pid: 22, ppid: 21, elapsed: 10, args: 'git pull', cwd: '/srv/shop', project: 'shop' },
    ],
    deploys: {},
    containers: null,
  });
  assert.strictEqual(r.active.length, 1);
  assert.strictEqual(r.active[0].project, 'shop');
  assert.match(r.active[0].command, /^bash -c git pull/);
  assert.strictEqual(r.active[0].current, 'git pull');
  assert.strictEqual(r.dockerAvailable, false);
});

test('a manual compose run groups its build under it', () => {
  const r = summarize({
    parents: { 30: 2, 31: 30 },
    procs: [
      { pid: 30, ppid: 2, elapsed: 20, args: 'docker compose up -d --build', cwd: '/srv/app', project: null },
      { pid: 31, ppid: 30, elapsed: 18, args: 'docker-buildx buildx build .', cwd: '/srv/app', project: null },
    ],
  });
  assert.strictEqual(r.active.length, 1);
  assert.strictEqual(r.active[0].kind, 'compose');
  assert.strictEqual(r.active[0].current, 'docker-buildx buildx build .');
  assert.strictEqual(r.active[0].cwd, '/srv/app');
});
