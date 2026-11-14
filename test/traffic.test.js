'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createTraffic = require('../src/main/remote/traffic');
const { parseLine, parseTime, stats, addSiteLog } = createTraffic;
const { summarize } = require('../src/main/remote/nginx-parse');
const createNginx = require('../src/main/remote/nginx');

const LINE = '203.0.113.9 - - [13/Nov/2026:10:12:01 +0100] "GET /api/items?page=2 HTTP/1.1" 200 5120 "https://example.com/" "Mozilla/5.0 (X11; Linux) \\"quoted\\""';

test('parses a combined-format line', () => {
  const e = parseLine(LINE);
  assert.strictEqual(e.ip, '203.0.113.9');
  assert.strictEqual(e.method, 'GET');
  assert.strictEqual(e.path, '/api/items?page=2');
  assert.strictEqual(e.protocol, 'HTTP/1.1');
  assert.strictEqual(e.status, 200);
  assert.strictEqual(e.bytes, 5120);
  assert.strictEqual(e.referer, 'https://example.com/');
  assert.strictEqual(e.agent, 'Mozilla/5.0 (X11; Linux) "quoted"');
  assert.strictEqual(e.time, Date.UTC(2026, 10, 13, 9, 12, 1));
});

test('parses common format, junk requests and empty fields', () => {
  const common = parseLine('::1 - bob [01/Jan/2026:00:00:00 +0000] "HEAD / HTTP/2.0" 304 -');
  assert.strictEqual(common.user, 'bob');
  assert.strictEqual(common.bytes, 0);
  assert.strictEqual(common.agent, '');
  const junk = parseLine('198.51.100.1 - - [01/Jan/2026:00:00:00 -0230] "\\x16\\x03\\x01" 400 157 "-" "-"');
  assert.strictEqual(junk.status, 400);
  assert.strictEqual(junk.method, '');
  assert.strictEqual(junk.referer, '');
  assert.strictEqual(parseTime('01/Jan/2026:00:00:00 -0230'), Date.UTC(2026, 0, 1, 2, 30, 0));
  assert.strictEqual(parseLine('not a log line'), null);
});

test('stats count status classes, top paths and the per-minute series', () => {
  const now = Date.UTC(2026, 10, 13, 10, 0, 30);
  const at = (minAgo, status, path = '/', ip = '1.1.1.1') => ({ ip, path, status, bytes: 100, time: now - minAgo * 60000 });
  const s = stats([at(90, 200), at(3, 200, '/a?x=1'), at(2, 404, '/a?y=2', '2.2.2.2'), at(0, 502, '/b')], now);
  assert.strictEqual(s.total, 4);
  assert.deepStrictEqual(s.classes, { 2: 2, 3: 0, 4: 1, 5: 1, other: 0 });
  assert.strictEqual(s.uniqueIps, 2);
  assert.deepStrictEqual(s.topPaths[0], { key: '/a', count: 2 });
  assert.strictEqual(s.perMinute.values.length, 60);
  assert.deepStrictEqual(s.perMinute.values[59], { total: 1, errors: 1 });
  assert.deepStrictEqual(s.perMinute.values[57], { total: 1, errors: 1 });
  assert.strictEqual(s.perMinute.values.reduce((n, v) => n + v.total, 0), 3); // the 90-minute-old one is outside the hour
  assert.strictEqual(s.perMinuteNow, 3 / 5);
});

test('addSiteLog adds one access_log per server block and keeps the config parseable', () => {
  const conf = `server {
    listen 80;
    server_name a.com;
    location = /favicon.ico { access_log off; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    server_name a.com;
    access_log /var/log/nginx/custom.log;
}
`;
  const out = addSiteLog(conf, 'a.com');
  assert.strictEqual(out.match(/access_log \/var\/log\/nginx\/sites\/a\.com\.access\.log;/g).length, 1, 'only the block without its own log');
  assert.ok(out.startsWith('server {\n    access_log /var/log/nginx/sites/a.com.access.log;\n    listen 80;'));
  assert.deepStrictEqual(summarize(out).domains, ['a.com']);
  assert.throws(() => addSiteLog(out, 'a.com'), /already has its own access_log/);
  assert.throws(() => addSiteLog('upstream x { server 127.0.0.1:1; }', 'a.com'), /No "server \{" block/);
  assert.throws(() => addSiteLog(conf, '../etc'), /Site name/);
});

test('every template can be given its own log', () => {
  for (const type of ['proxy', 'nextjs', 'laravel', 'static', 'app-websocket']) {
    const conf = createNginx.template({ type, domains: ['a.com'], upstreamPort: 3000, wsPort: 3001, root: '/srv/a' });
    assert.match(addSiteLog(conf, 'a.com'), /\n    access_log \/var\/log\/nginx\/sites\/a\.com\.access\.log;\n/, type);
  }
});

test('read() finds the site, tails its log and returns newest first', async () => {
  let script = '';
  const ssh = {
    async python(s) {
      script = s;
      return { path: '/var/log/nginx/a.com.access.log', format: 'combined', shared: false, others: [], exists: true, size: 10, now: Date.UTC(2026, 10, 13, 9, 13, 0) / 1000, lines: [LINE, LINE.replace('10:12:01', '10:12:30').replace(' 200 ', ' 500 '), 'garbage'] };
    },
  };
  const nginx = { list: async () => ({ sites: [{ name: 'a.com', kind: 'site', path: '/etc/nginx/sites-available/a.com', content: '', summary: { domains: ['a.com'] } }] }) };
  const r = await createTraffic(ssh, nginx).read({ name: 'a.com', lines: 99999 });
  assert.ok(script.includes('"lines\\":5000') || script.includes('\\"lines\\": 5000') || /lines\\":5000/.test(script), 'line count is capped');
  assert.ok(script.includes('/etc/nginx/sites-available/a.com'));
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].status, 500, 'newest first');
  assert.strictEqual(r.unparsed, 1);
  assert.strictEqual(r.stats.classes[5], 1);
  await assert.rejects(createTraffic(ssh, nginx).read({ name: 'missing.com' }), /No site config named "missing.com"/);
});

test('on a shared log, read() greps for the site domains unless asked for the whole log', async () => {
  const sent = [];
  const ssh = {
    async python(s) {
      sent.push(JSON.parse(JSON.parse(/IN = json\.loads\((".*")\)/.exec(s)[1])));
      return { path: '/var/log/nginx/access.log', format: 'combined', shared: true, grep: true, scanned: 1, others: [], exists: true, size: 10, now: 0, lines: [], limit: null };
    },
  };
  const nginx = { list: async () => ({ sites: [{ name: 'a.com', kind: 'site', path: '/etc/nginx/sites-available/a.com', content: '', summary: { domains: ['a.com', 'www.a.com', '*.a.com'] } }] }) };
  const t = createTraffic(ssh, nginx);
  const r = await t.read({ name: 'a.com' });
  await t.read({ name: 'a.com', match: 'all' });
  assert.deepStrictEqual(sent[0].domains, ['a.com', 'www.a.com'], 'wildcards are not grepped for');
  assert.strictEqual(sent[0].match, 'site');
  assert.strictEqual(sent[1].match, 'all');
  assert.strictEqual(r.grep, true);
  assert.strictEqual(r.canLimit, false);
});

test('rotateConfig caps the log by size and reopens nginx logs afterwards', () => {
  const c = createTraffic.rotateConfig('/var/log/nginx/sites/a.com.access.log', { maxSizeMb: 20, keep: 0 });
  assert.match(c, /^\/var\/log\/nginx\/sites\/a\.com\.access\.log \{$/m);
  assert.match(c, /^\s+size 20M$/m);
  assert.match(c, /^\s+rotate 0$/m);
  assert.match(c, /kill -USR1/);
});

test('addSiteLog plans the folder, logrotate, hourly cron and config change, and validates the cap', async () => {
  const { ops, newOp } = require('../src/main/ssh');
  const steps = [];
  const ssh = {
    run: async (cmd, o) => steps.push(o.what),
    writeFile: async (path, content, o) => steps.push(`${path}\n${content}\n${o.what}`),
  };
  const saved = [];
  const site = { name: 'a.com', kind: 'site', path: '/etc/nginx/sites-available/a.com', content: 'server {\n    server_name a.com;\n}\n', summary: { domains: ['a.com'] } };
  const nginx = { list: async () => ({ sites: [site] }), save: async (x) => saved.push(x) };
  const t = createTraffic(ssh, nginx);
  const r = await ops.run(newOp(), () => t.addSiteLog({ name: 'a.com', maxSizeMb: 20, keep: 2 }));
  assert.deepStrictEqual(r, { name: 'a.com', path: '/var/log/nginx/sites/a.com.access.log', maxSizeMb: 20, keep: 2, added: true });
  assert.ok(steps.some((s) => s.startsWith('/etc/logrotate.d/vps-manager-site-a.com\n') && s.includes('size 20M') && s.includes('rotate 2')));
  assert.ok(steps.some((s) => s.startsWith('/etc/cron.d/vps-manager-log-a_com\n') && s.includes('logrotate -s')), 'cron.d file names may not contain dots');
  assert.match(saved[0].content, /access_log \/var\/log\/nginx\/sites\/a\.com\.access\.log;/);

  // Already logging there: only the cap changes, the nginx config is left alone.
  site.content = saved[0].content;
  const again = await t.addSiteLog({ name: 'a.com', maxSizeMb: 5 });
  assert.strictEqual(again.added, false);
  assert.strictEqual(again.keep, 1);
  assert.strictEqual(saved.length, 1);
  await assert.rejects(t.addSiteLog({ name: 'a.com', maxSizeMb: 0 }), /Max size \(MB\) must be a whole number from 1 to 10240/);
  await assert.rejects(t.addSiteLog({ name: 'a.com', keep: 99 }), /Old copies to keep/);
});

test('isPageLoad keeps page views and drops assets, API calls and non-GETs', () => {
  const { isPageLoad } = createTraffic;
  const page = (path, method = 'GET') => isPageLoad({ method, path });
  for (const p of ['/', '/pricing', '/product/significance-and-x?ref=1', '/about.html', '/index.php', '/blog/', '/statistics', '/building-blocks'])
    assert.ok(page(p), `${p} is a page`);
  for (const p of ['/_next/static/chunks/a.js', '/_next/image?url=x', '/robots.txt', '/favicon.ico', '/styles.css?v=2', '/img/logo.png', '/fonts/a.woff2', '/api/users', '/static/x', '/sitemap.xml'])
    assert.ok(!page(p), `${p} is not a page`);
  assert.ok(!page('/contact', 'POST'));
  assert.ok(page('/contact', 'HEAD'));
  assert.ok(!page('\x16\x03\x01', ''), 'junk request lines are not pages');
});

test('read() with pages keeps only page loads and reads further back', async () => {
  let input;
  const asset = LINE.replace(/"GET \S+/, '"GET /_next/static/a.js');
  const ssh = {
    async python(s) {
      input = JSON.parse(JSON.parse(/IN = json\.loads\((".*")\)/.exec(s)[1]));
      return { path: '/x.log', format: 'combined', shared: false, others: [], exists: true, size: 1, now: 0, lines: [LINE.replace('/api/items', '/pricing'), LINE, asset] };
    },
  };
  const nginx = { list: async () => ({ sites: [{ name: 'a.com', kind: 'site', path: '/p', content: '', summary: { domains: ['a.com'] } }] }) };
  const r = await createTraffic(ssh, nginx).read({ name: 'a.com', pages: true });
  assert.strictEqual(input.lines, 5000);
  assert.strictEqual(r.pages, true);
  assert.strictEqual(r.read, 3);
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.stats.total, 1);
});

test('botName names crawlers, tools and scanners, and leaves browsers alone', () => {
  const { botName } = createTraffic;
  const browsers = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  ];
  for (const ua of browsers) assert.strictEqual(botName(ua), '', ua);
  assert.strictEqual(botName('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'Google');
  assert.strictEqual(botName('Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai)'), 'ExaSearchBot');
  assert.strictEqual(botName('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0)'), 'Anthropic');
  assert.strictEqual(botName('curl/8.4.0'), 'curl');
  assert.strictEqual(botName('python-requests/2.31'), 'Python');
  assert.strictEqual(botName(''), 'No user agent');
  assert.strictEqual(botName('-'), 'No user agent');
  assert.strictEqual(botName('Mozilla/5.0 zgrab/0.x'), 'Scanner');
  assert.strictEqual(botName('WhatsApp/2.23'), 'WhatsApp', 'non-browser agents are tools');
  assert.strictEqual(botName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36 (compatible; meta-webindexer/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler))'), 'Meta');
  assert.strictEqual(botName('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 (compatible; NewThingy/2.0)'), 'NewThingy', 'browser string with a compatible tag');
  assert.strictEqual(botName('Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)'), '', 'old Internet Explorer is a browser');
});

test('read() tags bots and can keep only humans or only bots', async () => {
  const bot = LINE.replace(/"Mozilla[^"]*\\"quoted\\""$/, '"curl/8.0"');
  const human = LINE.replace(/"Mozilla[^"]*\\"quoted\\""$/, '"Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"');
  const ssh = { python: async () => ({ path: '/x.log', format: 'combined', shared: false, others: [], exists: true, size: 1, now: 0, lines: [bot, human, human] }) };
  const nginx = { list: async () => ({ sites: [{ name: 'a.com', kind: 'site', path: '/p', content: '', summary: { domains: ['a.com'] } }] }) };
  const t = createTraffic(ssh, nginx);
  const all = await t.read({ name: 'a.com' });
  assert.deepStrictEqual(all.entries.map((e) => e.bot).sort(), ['', '', 'curl']);
  assert.strictEqual((await t.read({ name: 'a.com', who: 'humans' })).entries.length, 2);
  const bots = await t.read({ name: 'a.com', who: 'bots' });
  assert.strictEqual(bots.entries.length, 1);
  assert.strictEqual(bots.who, 'bots');
  assert.strictEqual(bots.read, 3);
});
