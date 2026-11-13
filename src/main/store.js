'use strict';
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const { check } = require('./validate');

const DEFAULTS = {
  connection: { host: '', port: 22, username: 'root', authType: 'key', keyPath: '', secretEnc: '' },
  hostKeys: {},
  // Sites pinned to the menu, per server (host:port) -> [{ name, kind }].
  pins: {},
  certEmail: '',
  ai: { keyEnc: '' },
  github: { tokenEnc: '' },
  vultr: { keyEnc: '' },
  // How the app itself behaves on this PC (see main.js).
  app: { startWithWindows: true, startHidden: true, closeToTray: true },
};
const APP_FLAGS = Object.keys(DEFAULTS.app);

let cache = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    cache = { ...DEFAULTS, ...raw, connection: { ...DEFAULTS.connection, ...(raw.connection || {}) }, ai: { ...DEFAULTS.ai, ...(raw.ai || {}) }, github: { ...DEFAULTS.github, ...(raw.github || {}) }, vultr: { ...DEFAULTS.vultr, ...(raw.vultr || {}) }, app: { ...DEFAULTS.app, ...(raw.app || {}) }, pins: { ...(raw.pins || {}) } };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
}

/** Secrets (key passphrase / password) are encrypted with the OS keychain (DPAPI on Windows). */
function encrypt(text) {
  if (!text) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secret storage is unavailable; cannot save the secret');
  return safeStorage.encryptString(text).toString('base64');
}

function decrypt(enc) {
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

module.exports = {
  get: () => load(),
  /** Settings as the renderer may see them: never includes the secret itself. */
  getPublic() {
    const s = load();
    const { secretEnc, ...conn } = s.connection;
    return { connection: { ...conn, hasSecret: !!secretEnc }, certEmail: s.certEmail, hostKeys: s.hostKeys, ai: { hasKey: !!s.ai.keyEnc }, github: { hasToken: !!s.github.tokenEnc }, vultr: { hasKey: !!s.vultr.keyEnc, fromEnv: !s.vultr.keyEnc && !!process.env.VULTR_API_KEY }, app: { ...s.app } };
  },
  /** patch.connection.secret: undefined = keep, '' = clear, string = replace. */
  update(patch) {
    const s = load();
    if (patch.connection) {
      const { secret, hasSecret, ...rest } = patch.connection;
      Object.assign(s.connection, rest);
      s.connection.port = Number(s.connection.port) || 22;
      if (secret !== undefined) s.connection.secretEnc = encrypt(secret);
    }
    if (patch.certEmail !== undefined) s.certEmail = String(patch.certEmail).trim();
    // patch.ai.key: '' = remove the saved Anthropic API key, string = replace it.
    if (patch.ai && patch.ai.key !== undefined) s.ai.keyEnc = encrypt(String(patch.ai.key).trim());
    if (patch.github && patch.github.token !== undefined) s.github.tokenEnc = encrypt(String(patch.github.token).trim());
    if (patch.vultr && patch.vultr.key !== undefined) s.vultr.keyEnc = encrypt(String(patch.vultr.key).trim());
    if (patch.app) for (const k of APP_FLAGS) if (typeof patch.app[k] === 'boolean') s.app[k] = patch.app[k];
    save();
  },
  secret: () => decrypt(load().connection.secretEnc),
  /** The saved Anthropic API key, or '' (the SDK then falls back to the environment). */
  aiKey: () => decrypt(load().ai.keyEnc),
  /** The saved GitHub token, else the GITHUB_TOKEN / GH_TOKEN environment variable, else ''. */
  githubToken: () => decrypt(load().github.tokenEnc) || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  /** The saved Vultr API key, else the VULTR_API_KEY environment variable, else ''. */
  vultrKey: () => decrypt(load().vultr.keyEnc) || process.env.VULTR_API_KEY || '',
  pins: (id) => (load().pins[id] || []).map((p) => ({ ...p })),
  /** Pin a site to the menu, or unpin it if it already is. Returns the new list. */
  togglePin(id, { name, kind = 'site' }) {
    check('siteName', name);
    if (!['site', 'conf.d'].includes(kind)) throw new Error(`Unknown config kind "${kind}"`);
    const s = load();
    const list = s.pins[id] || [];
    const i = list.findIndex((p) => p.name === name && p.kind === kind);
    if (i >= 0) list.splice(i, 1);
    else list.push({ name, kind });
    if (list.length) s.pins[id] = list;
    else delete s.pins[id];
    save();
    return list.map((p) => ({ ...p }));
  },
  hostKeyId: (c) => `${c.host}:${Number(c.port) || 22}`,
  setHostKey(id, fp) {
    load().hostKeys[id] = fp;
    save();
  },
  forgetHostKey(id) {
    delete load().hostKeys[id];
    save();
  },
};
