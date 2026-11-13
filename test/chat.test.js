'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createChat = require('../src/main/chat');
const Anthropic = require('@anthropic-ai/sdk');

// A scripted stand-in for the Anthropic client: each stream() call returns the next
// prepared message and records the request it was given.
function scripted(replies) {
  const requests = [];
  createChat.setClientFactory(() => ({
    beta: {
      messages: {
        stream(params, opts) {
          requests.push(JSON.parse(JSON.stringify(params)));
          const reply = replies.shift();
          const handlers = [];
          return {
            on: (ev, fn) => ev === 'text' && handlers.push(fn),
            async finalMessage() {
              if (opts.signal.aborted) throw new Error('aborted');
              if (reply instanceof Error) throw reply;
              for (const b of reply.content) if (b.type === 'text') handlers.forEach((fn) => fn(b.text));
              return reply;
            },
          };
        },
      },
    },
  }));
  return requests;
}

const say = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const call = (name, input, id = 'tu_1') => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id, name, input }] });

const ACTIONS = [
  { id: 'nginx:list', description: 'list sites', input: { type: 'object', properties: {}, required: [], additionalProperties: false }, run: () => {}, forModel: (r) => ({ count: r.sites.length }) },
  { id: 'nginx:enable', change: true, description: 'enable', input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }, review: () => ({}), run: () => {} },
];

function setup(runAction) {
  const events = [];
  const ran = [];
  const chat = createChat({
    actions: ACTIONS,
    runAction: async (id, input) => {
      ran.push([id, input]);
      return runAction(id, input);
    },
    emit: (e) => events.push(e),
    apiKey: () => 'test-key',
    serverLabel: () => 'matt@host',
  });
  return { chat, events, ran };
}

test('tools mirror the actions, with change actions flagged for the model', () => {
  const { chat } = setup();
  assert.deepStrictEqual(chat.tools.map((t) => t.name), ['nginx_list', 'nginx_enable']);
  assert.match(chat.tools[0].description, /^Read-only\./);
  assert.match(chat.tools[1].description, /^CHANGES THE SERVER/);
  assert.ok(chat.tools.every((t) => t.eager_input_streaming === true));
});

test('a tool call runs the action and its (model-facing) result goes back to the model', async () => {
  const requests = scripted([call('nginx_list', {}), say('You have 2 sites.')]);
  const { chat, events, ran } = setup(async () => ({ ok: true, data: { sites: [{}, {}] } }));
  await chat.send('how many sites?');

  assert.deepStrictEqual(ran, [['nginx:list', {}]]);
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].model, 'claude-opus-5-5');
  assert.match(requests[0].system, /matt@host/);
  const result = requests[1].messages[2].content[0];
  assert.deepStrictEqual([result.type, result.tool_use_id, result.content, result.is_error], ['tool_result', 'tu_1', '{"count":2}', undefined]);
  assert.deepStrictEqual(events.filter((e) => e.type === 'tool').map((e) => e.status), ['running', 'done']);
  assert.strictEqual(events.filter((e) => e.type === 'text').map((e) => e.delta).join('|'), 'On it.|You have 2 sites.');
  assert.strictEqual(events.at(-1).type, 'done');
  assert.strictEqual(chat.history.length, 4);
  assert.strictEqual(chat.busy, false);
});

test('a change the user declines is reported to the model as not run', async () => {
  const requests = scripted([call('nginx_enable', { name: 'a.com' }), say('OK, left it alone.')]);
  const { chat, events } = setup(async () => ({ ok: false, cancelled: true }));
  await chat.send('enable a.com');
  const result = requests[1].messages[2].content[0];
  assert.strictEqual(result.is_error, true);
  assert.match(result.content, /chose not to run it/);
  assert.deepStrictEqual(events.filter((e) => e.type === 'tool').map((e) => e.status), ['running', 'declined']);
});

test('invalid or unknown tool input never reaches an action', async () => {
  const requests = scripted([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'a', name: 'nginx_enable', input: { nam: 'a.com' } }, { type: 'tool_use', id: 'b', name: 'rm_rf', input: {} }] },
    say('Sorry.'),
  ]);
  const { chat, ran } = setup(async () => ({ ok: true }));
  await chat.send('enable a.com');
  assert.deepStrictEqual(ran, []);
  const [r1, r2] = requests[1].messages[2].content;
  assert.ok(r1.is_error && /INVALID_JSON/.test(r1.content) && r1.tool_use_id === 'a');
  assert.ok(r2.is_error && /Unknown tool/.test(r2.content) && r2.tool_use_id === 'b');
});

test('a failed action and a non-zero command are both returned as errors, not thrown', async () => {
  const requests = scripted([call('nginx_enable', { name: 'a.com' }), call('nginx_list', {}, 'tu_2'), say('done')]);
  let n = 0;
  const { chat } = setup(async () => {
    if (n++ === 0) throw new Error('nginx: [emerg] bad config');
    return { ok: true, data: { code: 2, output: 'boom', sites: [] } };
  });
  await chat.send('go');
  assert.match(requests[1].messages[2].content[0].content, /bad config/);
  assert.strictEqual(requests[1].messages[2].content[0].is_error, true);
  assert.strictEqual(requests[2].messages[4].content[0].is_error, true);
});

test('a truncated or refused turn never runs its tools, and history is rolled back', async () => {
  for (const stop_reason of ['max_tokens', 'refusal']) {
    scripted([{ stop_reason, content: [{ type: 'tool_use', id: 'x', name: 'nginx_enable', input: { name: 'a.com' } }] }]);
    const { chat, ran, events } = setup(async () => ({ ok: true }));
    await chat.send('enable a.com');
    assert.deepStrictEqual(ran, [], stop_reason);
    assert.strictEqual(chat.history.length, 0, stop_reason);
    assert.ok(events.some((e) => e.type === 'error' || e.type === 'notice'), stop_reason);
  }
});

test('an API failure is reported and leaves the conversation usable', async () => {
  const requests = scripted([new Anthropic.APIConnectionError({ message: 'network down' }), say('hello')]);
  const { chat, events } = setup(async () => ({ ok: true }));
  await chat.send('first');
  assert.ok(events.some((e) => e.type === 'error' && /Could not reach the Anthropic API/.test(e.text)));
  assert.strictEqual(chat.history.length, 0);
  await chat.send('second');
  assert.deepStrictEqual(requests[1].messages, [{ role: 'user', content: 'second' }]);
});

test('reset clears history; sending while not connected is refused', async () => {
  scripted([say('hi')]);
  const { chat } = setup(async () => ({ ok: true }));
  await chat.send('hi');
  assert.strictEqual(chat.history.length, 2);
  chat.reset();
  assert.strictEqual(chat.history.length, 0);
  const offline = createChat({ actions: ACTIONS, runAction: async () => ({ ok: true }), emit: () => {}, apiKey: () => '', serverLabel: () => null });
  await assert.rejects(offline.send('hi'), /Connect to the server first/);
});

test('an unparseable tool input (non-API error) re-issues the turn instead of failing', async () => {
  const requests = scripted([new Error('Unable to parse tool parameter JSON'), say('recovered')]);
  const { chat, events } = setup(async () => ({ ok: true }));
  await chat.send('hi');
  assert.strictEqual(requests.length, 2);
  assert.ok(events.some((e) => e.type === 'discard'));
  assert.ok(!events.some((e) => e.type === 'error'));
  assert.strictEqual(chat.history.length, 2);
});
