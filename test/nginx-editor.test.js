'use strict';
// The config editor's nginx helpers (lint, formatter, nginx -t error mapping) and the AI
// config writer's streaming: fences stripped, text streamed in order, nothing sent to the server.
const test = require('node:test');
const assert = require('node:assert');
const createNginxAi = require('../src/main/nginx-ai');

const lang = () => import('../src/renderer/nginx-lang.js');

test('lint: a clean config has no problems', async () => {
  const { lintNginx } = await lang();
  const conf = `server {
    listen 80;
    server_name example.com; # a comment with { and ;
    location / {
        proxy_set_header Connection "upgrade";
        proxy_pass http://127.0.0.1:3000;
    }
    log_format main '$remote_addr "$request"'
        '$status';
}
`;
  assert.deepStrictEqual(lintNginx(conf), []);
});

test('lint: missing semicolons and unbalanced braces', async () => {
  const { lintNginx } = await lang();
  const p = lintNginx(`server {
    listen 80
    server_name example.com;
    location / {
        return 200 }
}
}
server {
`);
  const msgs = p.map((x) => `${x.line}:${x.severity}:${x.message}`);
  assert.ok(msgs.some((m) => m.startsWith('2:warning:Missing') && m.includes('listen')), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith('5:error:Missing') && m.includes('return')), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("7:error:Unexpected '}'")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith('8:error:') && m.includes('never closed')), msgs.join('\n'));
});

test('format: re-indents by depth, keeps continuation lines and comments', async () => {
  const { formatNginx } = await lang();
  const out = formatNginx(`server {
listen 80;


      location / {   # root
  proxy_pass http://127.0.0.1:3000;
  add_header X-Test "a{b}";
log_format x 'a'
'b';
}
    }`);
  assert.strictEqual(
    out,
    `server {
    listen 80;

    location / {   # root
        proxy_pass http://127.0.0.1:3000;
        add_header X-Test "a{b}";
        log_format x 'a'
            'b';
    }
}
`
  );
});

test('nginx -t errors map to lines of this file only', async () => {
  const { nginxErrors } = await lang();
  const out = `nginx: [emerg] unknown directive "proxy_pas" in /etc/nginx/sites-enabled/example.com:7
nginx: [warn] conflicting server name "a.com" on 0.0.0.0:80, ignored in /etc/nginx/sites-enabled/other.com:3
nginx: configuration file /etc/nginx/nginx.conf test failed`;
  assert.deepStrictEqual(nginxErrors(out, ['/etc/nginx/sites-available/example.com', '/etc/nginx/sites-enabled/example.com']), [
    { line: 7, message: 'unknown directive "proxy_pas"', severity: 'error' },
  ]);
});

test('blocksAt: the enclosing blocks of a position', async () => {
  const { blocksAt } = await lang();
  const text = 'upstream app { server 1.2.3.4; }\nserver {\n  location /x {\n    ';
  assert.deepStrictEqual(blocksAt(text, text.length), ['server', 'location']);
});

function fakeClient(chunks, final = {}) {
  const requests = [];
  return {
    requests,
    client: () => ({
      beta: {
        messages: {
          stream(params, opts) {
            requests.push({ params, opts });
            const handlers = {};
            return {
              on: (ev, fn) => ((handlers[ev] = handlers[ev] || []).push(fn)),
              async finalMessage() {
                for (const c of chunks) (handlers.text || []).forEach((fn) => fn(c));
                return { stop_reason: 'end_turn', content: [], ...final };
              },
            };
          },
        },
      },
    }),
  };
}

function run(chunks, input, final) {
  const fake = fakeClient(chunks, final);
  const events = [];
  return new Promise((resolve) => {
    const ai = createNginxAi({
      client: fake.client,
      describeError: (e) => e.message,
      apiKey: () => 'k',
      listSites: async () => [{ name: 'other.io', enabled: true, summary: { domains: ['other.io'], targets: ['http://127.0.0.1:4000'] } }],
      emit: (ev) => {
        events.push(ev);
        if (['done', 'error', 'stopped'].includes(ev.type)) resolve({ events, requests: fake.requests });
      },
    });
    ai.generate({ name: 'example.com', path: '/etc/nginx/sites-available/example.com', current: 'server {}', instruction: 'add gzip', ...input });
  });
}

test('AI writer: streams the config with code fences removed', async () => {
  const { events, requests } = await run(['```ng', 'inx\nserver {\n', '    gzip on;\n', '}\n`', '``']);
  const streamed = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.strictEqual(streamed, 'server {\n    gzip on;\n}\n');
  assert.deepStrictEqual(events.at(-1), { id: 1, type: 'done', text: 'server {\n    gzip on;\n}\n' });
  const msg = requests[0].params.messages[0].content;
  assert.ok(msg.includes('<file path="/etc/nginx/sites-available/example.com">\nserver {}\n</file>'), msg);
  assert.ok(msg.includes('other.io: domains other.io; serves http://127.0.0.1:4000'), msg);
  assert.ok(msg.includes('<request>\nadd gzip\n</request>'), msg);
  assert.strictEqual(requests[0].params.model, 'claude-opus-5-5');
});

test('AI writer: refusals and cut-off output are errors, not configs', async () => {
  const refused = await run(['server {'], {}, { stop_reason: 'refusal' });
  assert.strictEqual(refused.events.at(-1).type, 'error');
  const cut = await run(['server {'], {}, { stop_reason: 'max_tokens' });
  assert.match(cut.events.at(-1).message, /cut off/);
});

test('AI writer: an empty request is rejected', () => {
  const ai = createNginxAi({ client: () => null, describeError: (e) => e.message, apiKey: () => '', listSites: async () => [], emit: () => {} });
  assert.throws(() => ai.generate({ instruction: '  ' }), /Describe/);
});
