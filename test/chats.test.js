'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const createChats = require('../src/main/chats');

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-'));
  return createChats(() => dir);
};

test('a chat is saved, listed newest first, reopened and updated in place', async () => {
  const chats = tmp();
  assert.deepStrictEqual(chats.list(), []);
  const a = chats.write({ title: 'first', messages: [{ role: 'user', content: 'hi' }], items: [{ kind: 'user', text: 'hi' }] });
  assert.match(a.id, /^[a-f0-9]{16}$/);
  await new Promise((r) => setTimeout(r, 5));
  const b = chats.write({ title: 'second', messages: [], items: [] });
  assert.deepStrictEqual(chats.list().map((c) => c.title), ['second', 'first']);
  assert.strictEqual(chats.list()[0].messages, undefined, 'the list does not carry whole conversations');
  assert.deepStrictEqual(chats.read(a.id).messages, [{ role: 'user', content: 'hi' }]);
  await new Promise((r) => setTimeout(r, 5));
  const a2 = chats.write({ ...chats.read(a.id), title: 'first' });
  assert.strictEqual(a2.id, a.id);
  assert.strictEqual(a2.createdAt, a.createdAt);
  assert.deepStrictEqual(chats.list().map((c) => c.title), ['first', 'second']);
  chats.remove(b.id);
  assert.deepStrictEqual(chats.list().map((c) => c.id), [a.id]);
});

test('ids that are not chat ids are refused', () => {
  const chats = tmp();
  assert.throws(() => chats.read('../settings'), /Unknown chat/);
  assert.throws(() => chats.read('0123456789abcdef'), /no longer exists/);
});
