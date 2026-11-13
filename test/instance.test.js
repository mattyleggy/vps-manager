'use strict';
const test = require('node:test');
const assert = require('node:assert');
const defineActions = require('../src/main/actions');

function setup({ instances, failing = [] }) {
  const ok = (name, v) => async () => {
    if (failing.includes(name)) throw new Error(`${name} denied`);
    return v;
  };
  const vultr = {
    hasKey: () => true,
    listInstances: async () => instances,
    instance: async (id) => ({ ...instances.find((i) => i.id === id), kvm: 'https://my.vultr.com/x' }),
    bandwidth: ok('bandwidth', { '2026-11-02': { incoming_bytes: 5, outgoing_bytes: 7 }, '2026-11-01': { incoming_bytes: 1, outgoing_bytes: 2 } }),
    ipv4: ok('ipv4', []),
    ipv6: ok('ipv6', []),
    neighbors: ok('neighbors', []),
    backupSchedule: ok('backupSchedule', { enabled: false }),
    backups: ok('backups', []),
    snapshots: ok('snapshots', []),
    plans: ok('plans', [{ id: 'vc2-1c-1gb', monthly_cost: 5 }]),
    regions: ok('regions', [{ id: 'lhr', city: 'London' }]),
    account: ok('account', { balance: -10 }),
    pendingCharges: ok('pendingCharges', []),
    firewallGroup: ok('firewall', null),
    firewallRules: ok('firewallRules', []),
  };
  const ssh = { connected: true, info: { host: '203.0.113.5', username: 'root' } };
  const actions = defineActions({ ssh, store: {}, system: { info: async () => ({ ips: ['203.0.113.5', '10.0.0.2'] }) }, vultr });
  return actions.find((a) => a.id === 'vultr:instance');
}

const A = { id: 'aaa', main_ip: '198.51.100.1', plan: 'vc2-1c-1gb', region: 'lhr' };
const B = { id: 'bbb', main_ip: '203.0.113.5', plan: 'vc2-1c-1gb', region: 'lhr' };

test('vultr:instance matches this server by IP and joins plan, region and sorted bandwidth', async () => {
  const r = await setup({ instances: [A, B] }).run({});
  assert.equal(r.matched, true);
  assert.equal(r.instance.id, 'bbb');
  assert.equal(r.plan.monthly_cost, 5);
  assert.equal(r.region.city, 'London');
  assert.deepEqual(r.bandwidth.map((d) => d.date), ['2026-11-01', '2026-11-02']);
  assert.deepEqual(r.bandwidth[1], { date: '2026-11-02', in: 5, out: 7 });
  assert.deepEqual(r.errors, {});
});

test('vultr:instance takes an explicit id, and offers the list when nothing matches', async () => {
  assert.equal((await setup({ instances: [A, B] }).run({ id: 'aaa' })).instance.id, 'aaa');
  const none = await setup({ instances: [A] }).run({});
  assert.equal(none.matched, false);
  assert.deepEqual(none.instances.map((i) => i.id), ['aaa']);
});

test('vultr:instance keeps the other details when one part of the API fails', async () => {
  const r = await setup({ instances: [B], failing: ['account', 'bandwidth'] }).run({});
  assert.equal(r.matched, true);
  assert.equal(r.account, null);
  assert.deepEqual(r.bandwidth, []);
  assert.match(r.errors.account, /denied/);
  assert.match(r.errors.bandwidth, /denied/);
});

test('system:history gives the model a summary, and enabling history is a reviewed change', async () => {
  const points = { t: [100, 220, 340], cpu: [10, 50, 30], iowait: [0, 1, 2], steal: [0, 0, 0], mem: [40, 41, 42], swap: [0, 0, 0], rx: [1, 2, 3], tx: [4, 5, 6], rd: [0, 0, 0], wr: [9, 9, 9], rio: [0, 0, 0], wio: [1, 1, 1], l1: [0.1, 0.5, 0.2] };
  const actions = defineActions({ ssh: {}, store: {}, system: { history: async () => ({ installed: true, enabled: true, collecting: true, interval: 120, cpus: 2, points }), ENABLE_HISTORY: 'x' }, vultr: {}, shellJob: async () => ({ code: 0 }) });
  const hist = actions.find((a) => a.id === 'system:history');
  const r = await hist.run({});
  const m = hist.forModel(r);
  assert.equal(m.samples, 3);
  assert.deepEqual(m.cpuPercent, { avg: 30, max: 50 });
  assert.equal(m.points, undefined); // the raw series stay out of the model's context
  const enable = actions.find((a) => a.id === 'system:enableHistory');
  assert.equal(enable.change, true);
  assert.match(enable.review({}).title, /24 hours/);
});
