'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { suggest, githubSlug, siteTargets } = require('../src/main/remote/detect');

test('githubSlug reads every GitHub remote form', () => {
  assert.strictEqual(githubSlug('git@github.com:me/shop.git'), 'me/shop');
  assert.strictEqual(githubSlug('https://github.com/me/shop'), 'me/shop');
  assert.strictEqual(githubSlug('https://x-access-token:abc@github.com/me/shop.git'), 'me/shop');
  assert.strictEqual(githubSlug('ssh://git@github.com/me/my.site.git'), 'me/my.site');
  assert.strictEqual(githubSlug('git@gitlab.com:me/shop.git'), null);
  assert.strictEqual(githubSlug(''), null);
});

test('siteTargets keeps local ports and plain folders only', () => {
  assert.deepStrictEqual(siteTargets(['http://127.0.0.1:3000', 'http://localhost:3000/', 'http://10.0.0.5:80', 'http://backend', '/var/www/site/public/', '/a/../etc']), {
    ports: [3000],
    roots: ['/var/www/site/public'],
  });
});

const dockerHit = (extra = {}) => ({
  via: 'docker',
  container: 'shop-web-1',
  port: 3001,
  path: '/srv/shop',
  composeProject: 'shop',
  composeFiles: ['/srv/shop/docker-compose.yml'],
  exists: true,
  gitRoot: '/srv/shop',
  remote: 'git@github.com:me/shop.git',
  branch: 'main',
  dirty: false,
  compose: ['docker-compose.yml'],
  ...extra,
});

test('a compose app in its own checkout gets the default command', () => {
  const r = suggest([dockerHit()], { site: 'shop.com', ports: [3001], existing: [] });
  assert.deepStrictEqual(r.project, { name: 'shop', repo: 'me/shop', branch: 'main', path: '/srv/shop', command: '', auto: true, app_port: 3001 });
  assert.match(r.notes[0].text, /shop-web-1/);
  assert.ok(!r.notes.some((n) => n.kind === 'warn'));
});

test('a compose project under another name, in a subfolder, with extra files keeps all of that', () => {
  const r = suggest(
    [dockerHit({ path: '/srv/shop/docker', composeProject: 'prod', composeFiles: ['/srv/shop/docker/compose.yaml', '/srv/shop/docker/compose.prod.yaml'] })],
    { site: 'shop.com', ports: [3001], existing: ['prod'] }
  );
  assert.strictEqual(r.project.command, 'git pull --ff-only origin main && cd docker && docker compose -p prod -f compose.yaml -f compose.prod.yaml up -d --build --remove-orphans');
  assert.strictEqual(r.project.path, '/srv/shop');
  assert.strictEqual(r.project.name, 'prod-2', 'a taken name gets a suffix');
});

test('a renamed compose project in its folder gets -p so deploys replace the running containers', () => {
  const r = suggest([dockerHit({ composeProject: 'shopprod' })], { site: 'shop.com', ports: [3001] });
  assert.strictEqual(r.project.command, 'git pull --ff-only origin main && docker compose -p shopprod up -d --build --remove-orphans');
});

test('a node process outside docker: build command and a reminder to add the restart', () => {
  const r = suggest(
    [{ via: 'process', pid: 42, exe: 'node', port: 3000, path: '/home/me/app', exists: true, gitRoot: '/home/me/app', remote: 'https://github.com/me/app.git', branch: 'master', packageJson: true, compose: [] }],
    { site: 'app.com', ports: [3000] }
  );
  assert.strictEqual(r.project.command, 'git pull --ff-only origin master && npm ci && npm run build --if-present');
  assert.ok(r.notes.some((n) => n.kind === 'warn' && /restart/.test(n.text)));
  assert.ok(r.notes.some((n) => /HTTPS/.test(n.text)));
});

test('a static root inside a checkout deploys the checkout with a plain pull', () => {
  const r = suggest([{ via: 'root', path: '/var/www/site/public', exists: true, gitRoot: '/var/www/site', remote: 'git@github.com:me/site.git', branch: 'main', compose: [] }], { site: 'site.com' });
  assert.strictEqual(r.project.path, '/var/www/site');
  assert.strictEqual(r.project.command, 'git pull --ff-only origin main');
  assert.strictEqual(r.project.app_port, null);
});

test('laravel on php-fpm gets composer and artisan steps', () => {
  const r = suggest([{ via: 'root', path: '/srv/api/public', exists: true, gitRoot: '/srv/api', remote: 'git@github.com:me/api.git', branch: 'main', artisan: true, compose: [] }], { site: 'api.com' });
  assert.match(r.project.command, /composer install .* && php artisan migrate --force/);
});

test('problems are spelled out: no checkout, other host, dirty tree, nothing found', () => {
  const plain = suggest([{ via: 'root', path: '/var/www/html', exists: true, gitRoot: null }], { site: 'x.com' });
  assert.ok(plain.notes.some((n) => n.kind === 'warn' && /not a git checkout/.test(n.text)));
  const gitlab = suggest([dockerHit({ remote: 'git@gitlab.com:me/shop.git' })], { site: 'x.com', ports: [3001] });
  assert.strictEqual(gitlab.project.repo, '');
  assert.ok(gitlab.notes.some((n) => /not on GitHub/.test(n.text)));
  const dirty = suggest([dockerHit({ dirty: true })], { site: 'x.com', ports: [3001] });
  assert.ok(dirty.notes.some((n) => /uncommitted/.test(n.text)));
  const none = suggest([], { site: 'shop.example.com', ports: [3005] });
  assert.strictEqual(none.source, null);
  assert.strictEqual(none.project.app_port, 3005);
  assert.ok(none.notes[0].text.includes('3005'));
});

test('a checkout is preferred over a folder that is not one, and the other is mentioned', () => {
  const r = suggest(
    [{ via: 'root', path: '/var/www/old', exists: true, gitRoot: null }, dockerHit()],
    { site: 'shop.com', ports: [3001] }
  );
  assert.strictEqual(r.project.path, '/srv/shop');
  assert.deepStrictEqual(r.others, ['/var/www/old']);
});
