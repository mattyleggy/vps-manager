'use strict';
const test = require('node:test');
const assert = require('node:assert');
const defineActions = require('../src/main/actions');
const { validate } = require('../src/main/schema');

// The registry only needs its dependencies when an action runs, so stubs are enough here.
const stub = new Proxy({}, { get: () => () => ({}) });
const actions = defineActions({ ssh: { info: { host: 'h' } }, store: { get: () => ({ certEmail: 'a@b.co' }) }, system: stub, nginx: stub, docker: stub, deploy: stub, github: stub, vultr: stub, activity: stub, detect: stub, shellJob: () => ({ code: 0 }), job: () => ({ code: 0 }) });
const byId = new Map(actions.map((a) => [a.id, a]));

test('every action is well-formed', () => {
  const ids = new Set();
  const tools = new Set();
  for (const a of actions) {
    assert.match(a.id, /^[a-z]+:[A-Za-z]+$/, a.id);
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    const tool = defineActions.toolName(a.id);
    assert.match(tool, /^[a-zA-Z0-9_-]{1,64}$/, `tool name ${tool}`);
    assert.ok(!tools.has(tool), `duplicate tool ${tool}`);
    tools.add(tool);
    assert.ok(a.description.length > 30, `${a.id} needs a real description`);
    assert.strictEqual(a.input.type, 'object', `${a.id} input must be an object schema`);
    assert.strictEqual(a.input.additionalProperties, false, `${a.id} must reject unknown fields`);
    for (const key of a.input.required) assert.ok(a.input.properties[key], `${a.id}: required "${key}" is not a property`);
    assert.strictEqual(typeof a.run, 'function');
    if (a.change) assert.strictEqual(typeof a.review, 'function', `${a.id} changes the server so it needs review text`);
  }
});

test('every change action produces review text for a valid input', async () => {
  const samples = {
    'nginx:create': { name: 'a.com', type: 'proxy', domains: 'a.com', upstreamPort: 3000 },
    'nginx:save': { name: 'a.com', content: 'server {}' },
    'nginx:enable': { name: 'a.com' },
    'nginx:disable': { name: 'a.com' },
    'nginx:delete': { name: 'a.com' },
    'nginx:certbot': { domains: ['a.com'] },
    'docker:container': { name: 'web', action: 'stop' },
    'docker:compose': { project: 'app', action: 'rebuild' },
    'deploy:install': { hostname: '', port: 9321 },
    'deploy:saveProject': { project: { name: 'app', repo: 'me/app', path: '/srv/app' } },
    'deploy:deleteProject': { name: 'app' },
    'deploy:run': { name: 'app' },
    'deploy:repoKey': { name: 'app' },
    'deploy:env': { name: 'app' },
    'deploy:webhook': { name: 'app' },
    'deploy:launch': { repo: 'me/app', domains: 'a.com', upstreamPort: 3000 },
    'dns:addZone': { zone: 'a.com' },
    'dns:point': { domains: ['a.com'] },
    'dns:saveRecord': { zone: 'a.com', type: 'A', name: 'www', data: '203.0.113.10' },
    'dns:deleteRecord': { zone: 'a.com', id: 'abc' },
  };
  for (const a of actions.filter((x) => x.change)) {
    const input = samples[a.id] || {};
    assert.strictEqual(validate(a.input, input), null, `${a.id} sample input should validate`);
    const meta = await a.review(input);
    assert.ok(meta.title && typeof meta.title === 'string', `${a.id} review needs a title`);
  }
});

test('input validation rejects what the handlers must never see', () => {
  const bad = (id, input, re) => assert.match(validate(byId.get(id).input, input) || '', re, `${id} ${JSON.stringify(input)}`);
  bad('nginx:enable', {}, /name is required/);
  bad('nginx:enable', { name: 5 }, /must be string/);
  bad('nginx:enable', { name: 'a', extra: 1 }, /not a known field/);
  bad('nginx:enable', 'a.com', /must be object/);
  bad('docker:container', { name: 'web', action: 'rm' }, /must be one of/);
  bad('nginx:certbot', { domains: 'a.com' }, /must be array/);
  bad('nginx:certbot', { domains: ['a.com', 7] }, /domains\[1\] must be string/);
  bad('nginx:create', { name: 'a', type: 'proxy', domains: 'a.com', upstreamPort: '3000' }, /must be integer/);
  bad('deploy:saveProject', { project: { name: 'x', repo: 'a/b' } }, /project\.path is required/);
  assert.strictEqual(validate(byId.get('nginx:list').input, {}), null);
});

test('results shown to the model hide the webhook secret and bulky file contents', () => {
  const status = byId.get('deploy:status').forModel({ installed: true, config: { secret: 'TOPSECRET', projects: [] } });
  assert.ok(!JSON.stringify(status).includes('TOPSECRET'));
  assert.ok(!String(byId.get('deploy:rotateSecret').forModel('NEWSECRET')).includes('NEWSECRET'));
  const list = byId.get('nginx:list').forModel({ installed: true, sites: [{ name: 'a', kind: 'site', enabled: true, content: 'BIG FILE', certExpiry: {}, summary: { domains: ['a.com'], targets: [], ssl: false } }] });
  assert.ok(!JSON.stringify(list).includes('BIG FILE'));
  assert.deepStrictEqual(list.sites[0].domains, ['a.com']);
});
