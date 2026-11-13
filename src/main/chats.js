'use strict';
// Saved assistant conversations, one JSON file per chat in <userData>/chats. Each file holds
// both views of the conversation: `messages` (what the model sees, so a reopened chat keeps
// its context) and `items` (the transcript the panel shows, with review cards and logs).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CHATS = 200; // oldest are removed beyond this

function createChats(dir) {
  const file = (id) => {
    if (!/^[a-f0-9]{16}$/.test(String(id))) throw new Error('Unknown chat');
    return path.join(dir(), `${id}.json`);
  };
  const readFile = (f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return null;
    }
  };

  function list() {
    let names = [];
    try {
      names = fs.readdirSync(dir()).filter((n) => /^[a-f0-9]{16}\.json$/.test(n));
    } catch {
      return [];
    }
    return names
      .map((n) => readFile(path.join(dir(), n)))
      .filter((c) => c && c.id)
      .map(({ id, title, server, updatedAt, createdAt }) => ({ id, title, server, updatedAt, createdAt }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function read(id) {
    const c = readFile(file(id));
    if (!c) throw new Error('That chat no longer exists');
    return c;
  }

  /** Saves a chat (creating its id on first save) and returns it. */
  function write(chat) {
    const now = Date.now();
    const c = { ...chat, id: chat.id || crypto.randomBytes(8).toString('hex'), createdAt: chat.createdAt || now, updatedAt: now };
    fs.mkdirSync(dir(), { recursive: true });
    const f = file(c.id);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(c));
    fs.renameSync(`${f}.tmp`, f);
    const all = list();
    for (const old of all.slice(MAX_CHATS)) remove(old.id);
    return c;
  }

  function remove(id) {
    try {
      fs.unlinkSync(file(id));
    } catch {
      /* already gone */
    }
  }

  return { list, read, write, remove };
}

module.exports = createChats;
