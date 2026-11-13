'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { summarize } = require('../src/main/remote/nginx-parse');
const { check } = require('../src/main/validate');
const { q, stripAnsi } = require('../src/main/ssh');

const CERTBOT_STYLE = `
# example site
server {
    server_name example.com www.example.com; # managed
    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Thing "a;b{c}";
    }
    location ~ ^/api/(v1|v2)/ { proxy_pass http://127.0.0.1:4000; }

    listen 443 ssl; # managed by Certbot
    listen [::]:443 ssl ipv6only=on;
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
}
server {
    if ($host = example.com) {
        return 301 https://$host$request_uri;
    }
    listen 80;
    server_name example.com www.example.com;
    return 404;
}
`;

test('parses a certbot-managed reverse proxy site', () => {
  const s = summarize(CERTBOT_STYLE);
  assert.deepStrictEqual(s.domains, ['example.com', 'www.example.com']);
  assert.deepStrictEqual(s.targets, ['http://127.0.0.1:3000', 'http://127.0.0.1:4000']);
  assert.deepStrictEqual(s.certs, ['/etc/letsencrypt/live/example.com/fullchain.pem']);
  assert.strictEqual(s.ssl, true);
  assert.strictEqual(s.servers.length, 2);
});

test('static site, default server and nested http block', () => {
  const s = summarize('http { server { listen 80 default_server; server_name _; root /var/www/html; } }');
  assert.deepStrictEqual(s.domains, []);
  assert.deepStrictEqual(s.targets, ['/var/www/html']);
  assert.strictEqual(s.ssl, false);
});

test('does not throw on broken config', () => {
  assert.doesNotThrow(() => summarize('server { listen 80; server_name a.com'));
  assert.deepStrictEqual(summarize('server { server_name a.com').domains, ['a.com']);
  assert.deepStrictEqual(summarize('').servers, []);
});

test('variables with braces stay one token', () => {
  const s = summarize('server { server_name x.io; location / { proxy_pass http://${upstream}:80; } }');
  assert.deepStrictEqual(s.targets, ['http://${upstream}:80']);
});

test('validation rejects shell metacharacters and traversal', () => {
  assert.throws(() => check('siteName', 'a; rm -rf /'));
  assert.throws(() => check('siteName', '../nginx.conf'));
  assert.throws(() => check('domain', 'exa$(id).com'));
  assert.throws(() => check('absPath', '/srv/../etc'));
  assert.throws(() => check('repo', 'owner/name; id'));
  assert.strictEqual(check('domain', ' Example.com '), 'Example.com');
  assert.strictEqual(check('siteName', 'example.com'), 'example.com');
});

test('shell quoting and ansi stripping', () => {
  assert.strictEqual(q("it's"), `'it'\\''s'`);
  assert.strictEqual(stripAnsi('\x1b[32mok\x1b[0m\r\n'), 'ok\r\n');
});
