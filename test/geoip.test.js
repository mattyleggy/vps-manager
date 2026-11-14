'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createGeo = require('../src/main/geoip');

const answer = (ip, cc = 'AU') => ({ status: 'success', query: ip, countryCode: cc, country: 'Australia', city: 'Sydney', isp: 'Telstra', org: '', as: 'AS1221 Telstra', hosting: false, proxy: false });
const okRes = (list, headers = {}) => ({ ok: true, status: 200, headers: { get: (k) => headers[k] }, json: async () => list });

test('private and invalid addresses are never sent', async () => {
  const calls = [];
  const g = createGeo({ fetchImpl: async (u, o) => (calls.push(JSON.parse(o.body)), okRes([])) });
  const r = await g.lookup(['10.0.0.1', '172.20.0.8', '192.168.1.1', '127.0.0.1', '::1', 'fd00::1', 'nope']);
  assert.strictEqual(calls.length, 0);
  assert.deepStrictEqual(Object.keys(r).sort(), ['10.0.0.1', '127.0.0.1', '172.20.0.8', '192.168.1.1', '::1', 'fd00::1']);
  assert.ok(Object.values(r).every((v) => v.private));
});

test('public IPs are looked up in batches of 100, then served from the cache file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-'));
  const file = path.join(dir, 'geo.json');
  const calls = [];
  const fetchImpl = async (u, o) => {
    const ips = JSON.parse(o.body);
    calls.push(ips.length);
    return okRes(ips.map((ip) => answer(ip)));
  };
  const ips = Array.from({ length: 150 }, (_, i) => `8.8.${Math.floor(i / 250)}.${(i % 250) + 1}`);
  const g = createGeo({ file, fetchImpl });
  const r = await g.lookup([...ips, ips[0]]);
  assert.deepStrictEqual(calls, [100, 50]);
  assert.strictEqual(r['8.8.0.1'].cc, 'au');
  assert.strictEqual(r['8.8.0.1'].city, 'Sydney');
  await g.lookup(ips);
  assert.deepStrictEqual(calls, [100, 50], 'second lookup is cached');
  await new Promise((res) => setTimeout(res, 2100));
  const again = createGeo({ file, fetchImpl: async () => assert.fail('should read the cache file') });
  assert.strictEqual((await again.lookup(['8.8.0.1']))['8.8.0.1'].country, 'Australia');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline or rate limited: IPs are left out so they can be asked again', async () => {
  let t = 0;
  let mode = 'offline';
  const g = createGeo({
    now: () => t,
    fetchImpl: async (u, o) => {
      if (mode === 'offline') throw new Error('ENOTFOUND');
      if (mode === 'limited') return { ok: false, status: 429, headers: { get: (k) => ({ 'x-ttl': '30' })[k] }, json: async () => [] };
      return okRes(JSON.parse(o.body).map((ip) => answer(ip)));
    },
  });
  assert.deepStrictEqual(await g.lookup(['1.1.1.1']), {});
  mode = 'limited';
  assert.deepStrictEqual(await g.lookup(['1.1.1.1']), {});
  mode = 'ok';
  assert.deepStrictEqual(await g.lookup(['1.1.1.1']), {}, 'waits out the rate limit');
  t = 31000;
  assert.strictEqual((await g.lookup(['1.1.1.1']))['1.1.1.1'].cc, 'au');
});

test('a failed answer is kept as unknown instead of retried forever', () => {
  assert.deepStrictEqual(createGeo.shape({ status: 'fail', message: 'reserved range', query: '0.0.0.0' }), { cc: '', country: '', failed: true });
});
