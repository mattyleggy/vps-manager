'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createVultr = require('../src/main/vultr');
const defineActions = require('../src/main/actions');
const { Ssh, ops, newOp } = require('../src/main/ssh');

function withFetch(status, body) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(status === 204 ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return calls;
}

test('creates a record with the saved key', async () => {
  const calls = withFetch(201, { record: { id: 'r1' } });
  const v = createVultr({ key: () => 'KEY' });
  await v.createRecord('Example.com', { name: 'WWW', type: 'a', data: '203.0.113.10' });
  assert.strictEqual(calls[0].url, 'https://api.vultr.com/v2/domains/example.com/records');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer KEY');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { name: 'www', type: 'A', data: '203.0.113.10', ttl: 300 });
});

test('update leaves the type out and delete returns cleanly on 204', async () => {
  const calls = withFetch(204);
  const v = createVultr({ key: () => 'KEY' });
  await v.updateRecord('example.com', 'abc-123', { name: '', type: 'A', data: '203.0.113.11', ttl: 600 });
  assert.strictEqual(calls[0].opts.method, 'PATCH');
  assert.strictEqual(calls[0].url, 'https://api.vultr.com/v2/domains/example.com/records/abc-123');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { name: '', data: '203.0.113.11', ttl: 600 });
  assert.strictEqual(await v.deleteRecord('example.com', 'abc-123'), null);
  assert.strictEqual(calls[1].opts.method, 'DELETE');
});

test('follows the cursor when listing', async () => {
  const pages = [
    { domains: [{ domain: 'a.com' }], meta: { links: { next: 'CUR', prev: '' } } },
    { domains: [{ domain: 'b.com' }], meta: { links: { next: '', prev: '' } } },
  ];
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
  };
  const zones = await createVultr({ key: () => 'KEY' }).listZones();
  assert.deepStrictEqual(zones.map((z) => z.domain), ['a.com', 'b.com']);
  assert.match(urls[1], /cursor=CUR/);
});

test('refuses to call Vultr without a key or with a malformed zone, id or record', async () => {
  const calls = withFetch(200, {});
  await assert.rejects(createVultr({ key: () => '' }).listZones(), /No Vultr API key is saved/);
  const v = createVultr({ key: () => 'KEY' });
  await assert.rejects(async () => v.listRecords('example.com/../../account'), /Not a valid domain name/);
  await assert.rejects(async () => v.deleteRecord('example.com', '../x'), /Not a valid record id/);
  await assert.rejects(async () => v.createRecord('example.com', { name: 'www', type: 'A', data: 'not-an-ip' }), /IPv4/);
  await assert.rejects(async () => v.createRecord('example.com', { name: '', type: 'CNAME', data: 'x.com' }), /CNAME cannot be set on the domain itself/);
  await assert.rejects(async () => v.createRecord('example.com', { name: 'a b', type: 'TXT', data: 'x' }), /Not a valid record name/);
  assert.strictEqual(calls.length, 0);
});

test('explains a rejected key, including the IP allow-list', async () => {
  withFetch(401, { error: 'Unauthorized IP address', status: 401 });
  await assert.rejects(createVultr({ key: () => 'KEY' }).listZones(), /rejected the API key[^]*Access Control[^]*Unauthorized IP address/);
  withFetch(500, 'oops');
  await assert.rejects(createVultr({ key: () => 'KEY' }).listZones(), /Vultr API error 500/);
});

test('record shaping: apex names, TXT quoting, MX priority', () => {
  const { recordBody } = createVultr;
  assert.strictEqual(recordBody({ name: '@', type: 'A', data: '1.2.3.4' }).name, '');
  assert.strictEqual(recordBody({ name: '', type: 'TXT', data: 'v=spf1 ~all' }).data, '"v=spf1 ~all"');
  assert.strictEqual(recordBody({ name: '', type: 'TXT', data: '"already"' }).data, '"already"');
  assert.deepStrictEqual(recordBody({ name: '', type: 'MX', data: 'mail.example.com', ttl: 3600 }), { name: '', type: 'MX', data: 'mail.example.com', ttl: 3600, priority: 10 });
  assert.strictEqual(recordBody({ name: '_dmarc', type: 'TXT', data: 'v=DMARC1' }).name, '_dmarc');
  assert.throws(() => recordBody({ name: 'www', type: 'A', data: '1.2.3.4', ttl: 5 }), /TTL/);
});

test('a hostname maps to its longest matching zone', () => {
  const { zoneFor } = createVultr;
  const zones = ['example.com', 'shop.example.com', 'other.com.au'];
  assert.deepStrictEqual(zoneFor('example.com', zones), { zone: 'example.com', name: '' });
  assert.deepStrictEqual(zoneFor('www.example.com', zones), { zone: 'example.com', name: 'www' });
  assert.deepStrictEqual(zoneFor('a.shop.example.com', zones), { zone: 'shop.example.com', name: 'a' });
  assert.deepStrictEqual(zoneFor('*.other.com.au', zones), { zone: 'other.com.au', name: '*' });
  assert.strictEqual(zoneFor('notexample.com', zones), null);
});

// ---- the actions, run through the real review gate (plan, then apply) ----

function setup(records) {
  const ssh = new Ssh();
  ssh.client = {}; // "connected"; these actions never run an SSH command
  ssh.info = { host: '203.0.113.10', username: 'root', isRoot: true };
  const sent = [];
  const vultr = {
    hasKey: () => true,
    listZones: async () => [{ domain: 'example.com' }],
    listRecords: async () => records,
    createZone: async (...a) => sent.push(['createZone', ...a]),
    createRecord: async (...a) => (sent.push(['create', ...a]), { record: { id: 'new' } }),
    updateRecord: async (...a) => sent.push(['update', ...a]),
    deleteRecord: async (...a) => sent.push(['delete', ...a]),
  };
  const stub = new Proxy({}, { get: () => () => ({}) });
  const actions = defineActions({ ssh, store: { get: () => ({}) }, system: stub, nginx: stub, docker: stub, deploy: stub, github: stub, vultr, shellJob: () => ({}), job: () => ({}) });
  const run = async (id, input) => {
    const action = actions.find((a) => a.id === id);
    const op = newOp();
    await ops.run(op, () => action.run(input));
    const plannedCalls = sent.length;
    op.mode = 'apply';
    const result = await ops.run(op, () => action.run(input));
    return { steps: op.steps, plannedCalls, result };
  };
  return { run, sent, actions };
}

test('dns:point creates, updates, replaces a CNAME and skips what is already right; nothing is sent while planning', async () => {
  const { run, sent } = setup([
    { id: 'r1', type: 'A', name: '', data: '203.0.113.10', ttl: 300 },
    { id: 'r2', type: 'A', name: 'old', data: '198.51.100.1', ttl: 3600 },
    { id: 'r3', type: 'CNAME', name: 'www', data: 'example.com', ttl: 300 },
  ]);
  const { steps, plannedCalls, result } = await run('dns:point', { domains: ['example.com', 'old.example.com', 'www.example.com', 'new.example.com'] });
  assert.strictEqual(plannedCalls, 0);
  assert.deepStrictEqual(result.results.map((r) => r.status), ['already', 'updated', 'created', 'created']);
  assert.deepStrictEqual(sent.map((s) => s[0]), ['update', 'delete', 'create', 'create']);
  assert.deepStrictEqual(sent[0].slice(1), ['example.com', 'r2', { name: 'old', data: '203.0.113.10', ttl: 3600, type: 'A' }]);
  assert.deepStrictEqual(sent[1].slice(1), ['example.com', 'r3']);
  assert.deepStrictEqual(sent[3].slice(1), ['example.com', { name: 'new', type: 'A', data: '203.0.113.10', ttl: 300 }]);
  assert.ok(steps.every((s) => s.via === 'Vultr API'));
  assert.match(steps[0].cmd, /^PATCH https:\/\/api\.vultr\.com\/v2\/domains\/example\.com\/records\/r2\n/);
});

test('dns:point refuses a hostname outside every zone, and ambiguous A records', async () => {
  await assert.rejects(setup([]).run('dns:point', { domains: ['nope.org'] }), /not inside any DNS zone/);
  const two = setup([{ id: 'a', type: 'A', name: '', data: '1.1.1.1', ttl: 300 }, { id: 'b', type: 'A', name: '', data: '2.2.2.2', ttl: 300 }]);
  await assert.rejects(two.run('dns:point', { domains: ['example.com'] }), /has 2 A records/);
});

test('dns:saveRecord and dns:deleteRecord act on the record that was reviewed', async () => {
  const records = [{ id: 'r1', type: 'TXT', name: '', data: '"old"', ttl: 300 }];
  const a = setup(records);
  const saved = await a.run('dns:saveRecord', { zone: 'example.com', id: 'r1', type: 'TXT', name: '', data: 'new' });
  assert.strictEqual(saved.result.status, 'updated');
  assert.deepStrictEqual(a.sent[0], ['update', 'example.com', 'r1', { name: '', type: 'TXT', data: '"new"', ttl: 300 }]);
  await assert.rejects(a.run('dns:saveRecord', { zone: 'example.com', id: 'r1', type: 'A', name: '', data: '1.2.3.4' }), /type cannot be changed/);

  const same = await a.run('dns:saveRecord', { zone: 'example.com', type: 'TXT', name: '', data: 'old' });
  assert.strictEqual(same.result.status, 'already');
  assert.strictEqual(same.steps.length, 0);

  const b = setup(records);
  const gone = await b.run('dns:deleteRecord', { zone: 'example.com', id: 'r1' });
  assert.match(gone.steps[0].what, /Delete the TXT record example\.com/);
  assert.deepStrictEqual(b.sent, [['delete', 'example.com', 'r1']]);
  await assert.rejects(b.run('dns:deleteRecord', { zone: 'example.com', id: 'zzz' }), /no record with id zzz/);
});

test('dns:addZone creates a missing zone and leaves an existing one alone', async () => {
  const a = setup([]);
  assert.strictEqual((await a.run('dns:addZone', { zone: 'New.com' })).result.existed, false);
  assert.deepStrictEqual(a.sent, [['createZone', 'new.com']]);
  const again = await a.run('dns:addZone', { zone: 'example.com' });
  assert.strictEqual(again.result.existed, true);
  assert.strictEqual(again.steps.length, 0);
});

test('a change outside a reviewed operation is refused', async () => {
  const { actions, sent } = setup([]);
  await assert.rejects(actions.find((x) => x.id === 'dns:point').run({ domains: ['example.com'] }), /without being reviewed/);
  assert.strictEqual(sent.length, 0);
});
