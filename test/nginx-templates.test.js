'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createNginx = require('../src/main/remote/nginx');
const { summarize } = require('../src/main/remote/nginx-parse');
const { ops, newOp } = require('../src/main/ssh');

/** A fake server: answers the reads create() makes and records what it would write. */
function fake({ ports = '', fpm = '' } = {}) {
  const writes = [];
  const ssh = {
    info: { isRoot: true },
    async exec(cmd) {
      if (cmd.includes('ss -ltnH')) return { code: 0, stdout: ports, stderr: '' };
      if (cmd.includes('fpm.sock')) return { code: 0, stdout: fpm, stderr: '' };
      if (cmd.startsWith('test -e')) return { code: 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    async run(cmd, opts = {}) {
      if (opts.input != null) writes.push(opts.input);
      return '';
    },
  };
  return { nginx: createNginx(ssh), writes };
}

test('Next.js template proxies to the port with the headers and streaming Next needs', () => {
  const conf = createNginx.template({ type: 'nextjs', domains: ['a.com', 'www.a.com'], upstreamPort: 3001 });
  const s = summarize(conf);
  assert.deepStrictEqual(s.domains, ['a.com', 'www.a.com']);
  assert.deepStrictEqual(s.targets, ['http://127.0.0.1:3001']);
  for (const line of ['proxy_set_header X-Forwarded-Proto $scheme;', 'proxy_set_header X-Forwarded-Host $host;', 'proxy_set_header Upgrade $http_upgrade;', 'proxy_buffering off;']) assert.ok(conf.includes(line), line);
});

test('Laravel-on-a-port template allows large uploads and does not turn buffering off', () => {
  const conf = createNginx.template({ type: 'laravel', domains: ['a.com'], upstreamPort: 8000 });
  assert.deepStrictEqual(summarize(conf).targets, ['http://127.0.0.1:8000']);
  assert.ok(conf.includes('client_max_body_size 100m;'));
  assert.ok(conf.includes('proxy_set_header X-Forwarded-Proto $scheme;'));
  assert.ok(!conf.includes('proxy_buffering off;'));
});

test('Laravel PHP-FPM template routes through index.php and hides dotfiles', () => {
  const conf = createNginx.template({ type: 'laravel-fpm', domains: ['a.com'], root: '/srv/app/public', fpmSocket: '/run/php/php8.3-fpm.sock' });
  for (const line of ['root /srv/app/public;', 'try_files $uri $uri/ /index.php?$query_string;', 'location ~ ^/index\\.php(/|$) {', 'fastcgi_pass unix:/run/php/php8.3-fpm.sock;', 'fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;', 'location ~ /\\.(?!well-known).* {']) {
    assert.ok(conf.includes(line), line);
  }
  assert.deepStrictEqual(summarize(conf).targets, ['unix:/run/php/php8.3-fpm.sock']);
});

test('the next free port skips listening, nginx-assigned and docker-published ports', async () => {
  const { nginx } = fake({ ports: '22\n80\n443\n3000\n3001\n3003\n8000\n' });
  assert.deepStrictEqual(await nginx.nextPort(3000), { port: 3002, inUse: [3000, 3001] });
  assert.deepStrictEqual(await nginx.nextPort(8000), { port: 8001, inUse: [8000] });
  assert.deepStrictEqual(await nginx.nextPort(5000), { port: 5000, inUse: [] });
  await assert.rejects(nginx.nextPort(70000), /Invalid port/);
});

test('create picks the next free port per type when none is given, and reports it', async () => {
  const run = async (input, env) => {
    const { nginx, writes } = fake(env);
    const result = await ops.run(newOp(), () => nginx.create(input)); // plan mode: reads run, writes are recorded
    return { result, conf: writes[0] };
  };
  const taken = { ports: '3000\n8000\n8001\n' };
  let r = await run({ name: 'a.com', type: 'nextjs', domains: 'a.com' }, taken);
  assert.strictEqual(r.result.upstreamPort, 3001);
  r = await run({ name: 'a.com', type: 'laravel', domains: 'a.com' }, taken);
  assert.strictEqual(r.result.upstreamPort, 8002);
  r = await run({ name: 'a.com', type: 'proxy', domains: 'a.com', upstreamPort: 4000 }, taken);
  assert.strictEqual(r.result.upstreamPort, 4000);
  await assert.rejects(run({ name: 'a.com', type: 'nextjs', domains: 'a.com', upstreamPort: 0 }, taken), /Invalid port/);
  await assert.rejects(run({ name: 'a.com', type: 'wordpress', domains: 'a.com' }, taken), /Unknown site type/);
});

test('create for Laravel PHP-FPM serves public/ through the newest PHP-FPM socket, or explains its absence', async () => {
  const input = { name: 'a.com', type: 'laravel-fpm', domains: 'a.com', root: '/srv/app/' };
  const { nginx } = fake({ fpm: '/run/php/php8.3-fpm.sock\n' });
  const result = await ops.run(newOp(), () => nginx.create(input));
  assert.strictEqual(result.root, '/srv/app/public');
  const already = await ops.run(newOp(), () => fake({ fpm: '/run/php/php8.3-fpm.sock\n' }).nginx.create({ ...input, root: '/srv/app/public' }));
  assert.strictEqual(already.root, '/srv/app/public');
  await assert.rejects(ops.run(newOp(), () => fake({ fpm: '' }).nginx.create(input)), /PHP-FPM is not running/);
  await assert.rejects(ops.run(newOp(), () => fake({ fpm: '/run/php/php8.3-fpm.sock' }).nginx.create({ ...input, root: 'relative/path' })), /Path must be absolute/);
});

test('App + WebSocket template sends the socket path to its own port and the rest to the app', () => {
  const conf = createNginx.template({ type: 'app-websocket', domains: ['a.com'], upstreamPort: 3000, wsPort: 3001, wsPath: '/socket.io/' });
  assert.deepStrictEqual(summarize(conf).targets, ['http://127.0.0.1:3001', 'http://127.0.0.1:3000']);
  for (const line of ['location /socket.io/ {', 'location / {', 'proxy_set_header Upgrade $http_upgrade;', 'proxy_set_header Connection "upgrade";', 'proxy_read_timeout 3600s;']) assert.ok(conf.includes(line), line);
});

test('create for App + WebSocket picks two different free ports and validates the path', async () => {
  const run = (input, env = { ports: '3000\n3002\n' }) => ops.run(newOp(), () => fake(env).nginx.create({ name: 'a.com', type: 'app-websocket', domains: 'a.com', ...input }));
  let r = await run({});
  assert.deepStrictEqual([r.upstreamPort, r.wsPort, r.wsPath], [3001, 3003, '/ws']);
  r = await run({ upstreamPort: 4000, wsPort: 4001, wsPath: '/live' });
  assert.deepStrictEqual([r.upstreamPort, r.wsPort, r.wsPath], [4000, 4001, '/live']);
  await assert.rejects(run({ upstreamPort: 4000, wsPort: 4000 }), /different ports/);
  await assert.rejects(run({ wsPath: '/' }), /cannot be "\/"/);
  await assert.rejects(run({ wsPath: 'ws; deny all' }), /Path must start with \//);
});

test('App + WebSocket records the app and WebSocket server folders in the config, and they read back', async () => {
  const conf = createNginx.template({ type: 'app-websocket', domains: ['a.com'], upstreamPort: 3000, wsPort: 3001, appFolder: '/opt/apps/web', wsFolder: '/opt/apps/ws' });
  assert.deepStrictEqual(summarize(conf).folders, { app: '/opt/apps/web', ws: '/opt/apps/ws' });
  assert.deepStrictEqual(summarize(createNginx.template({ type: 'app-websocket', domains: ['a.com'], upstreamPort: 3000, wsPort: 3001 })).folders, {});
  const run = (input) => ops.run(newOp(), () => fake().nginx.create({ name: 'a.com', type: 'app-websocket', domains: 'a.com', ...input }));
  const r = await run({ appFolder: '/opt/apps/web/', wsFolder: '' });
  assert.deepStrictEqual([r.appFolder, r.wsFolder], ['/opt/apps/web', undefined]);
  await assert.rejects(run({ wsFolder: 'relative' }), /Path must be absolute/);
});
