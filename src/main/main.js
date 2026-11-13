'use strict';
const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const store = require('./store');
const { Ssh, ops, newOp, planning } = require('./ssh');
const { validate } = require('./schema');
const defineActions = require('./actions');
const createChat = require('./chat');

// One copy at a time: starting the app again (Start menu, or a second login launch) brings
// the running window forward instead of opening another one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ssh = new Ssh();
const system = require('./remote/system')(ssh);
const nginx = require('./remote/nginx')(ssh);
const docker = require('./remote/docker')(ssh);
const github = require('./github')({
  token: () => store.githubToken(),
  // Without a token, the SSH key this app connects with can at least name the GitHub account.
  sshIdentity: () => {
    const c = store.get().connection;
    if (c.authType === 'password') return null;
    return require('./github-ssh').whoami({ authType: c.authType, keyPath: c.keyPath || defaultKeyPath(), passphrase: store.secret() });
  },
});
const deploy = require('./remote/deploy')(ssh, nginx, github);
const activity = require('./remote/activity')(ssh);
const detect = require('./remote/detect')(ssh, nginx, deploy);
const vultr = require('./vultr')({ key: () => store.vultrKey() });

let win = null;
let tray = null;
const send = (channel, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
};

// ---- streamed jobs: long commands whose output is shown live in the UI ----
const JOB_OUTPUT_LIMIT = 200000;
let jobSeq = 0;
async function job(title, fn) {
  // While a plan is being drawn up nothing really runs, so there is nothing to show.
  if (planning()) return { code: await fn(() => {}), output: '' };
  const id = ++jobSeq;
  let output = '';
  send('job', { id, type: 'start', title });
  const onData = (text) => {
    output = (output + text).slice(-JOB_OUTPUT_LIMIT);
    send('job', { id, type: 'data', text });
  };
  try {
    const code = await fn(onData);
    send('job', { id, type: 'end', code });
    return { code, output };
  } catch (e) {
    onData(`\n${e.message}\n`);
    send('job', { id, type: 'end', code: -1 });
    return { code: -1, output };
  }
}
const shellJob = (title, cmd, { read = false, what } = {}) =>
  job(title, async (onData) => {
    onData(`$ ${title}\n`);
    return (await ssh.exec(cmd, { sudo: true, onData, read, what: what || title })).code;
  });

// ---- actions: everything the app can do on the server (see actions.js) ----
const actions = defineActions({ ssh, store, system, nginx, docker, deploy, github, vultr, activity, detect, shellJob, job });
const actionsById = new Map(actions.map((a) => [a.id, a]));

// ---- review before apply ----
// An action marked `change` is first run in plan mode (see ssh.js), the recorded commands are
// shown to the user, and only an explicit approval runs them. The SSH layer refuses any
// unreviewed change, so an action that forgets the flag fails safe.
let reviewSeq = 0;
let progressSeq = 0;
const reviews = new Map();
// A review requested by the assistant carries the id of the tool call that proposed it
// (`chat`), so the UI asks about it inside the assistant panel rather than in a dialog.
function askReview(plan, chatCall) {
  return new Promise((resolve) => {
    const id = ++reviewSeq;
    reviews.set(id, { resolve, chat: !!chatCall });
    send('review', { id, chat: chatCall || null, ...plan });
  });
}
ipcMain.on('review:reply', (_e, id, approved) => {
  const pending = reviews.get(id);
  reviews.delete(id);
  if (pending) pending.resolve(approved === true);
});
/** Stop / New chat: a question the assistant is still waiting on counts as "don't run". */
function cancelChatReviews() {
  for (const [id, pending] of reviews) {
    if (!pending.chat) continue;
    reviews.delete(id);
    pending.resolve(false);
  }
}

async function reviewed(action, input, origin) {
  const op = newOp();
  await ops.run(op, () => action.run(input)); // plan: reads run, changes are only recorded
  if (!op.steps.length) return { ok: true, data: await action.run(input) }; // turned out to be read-only
  const meta = await action.review(input);
  const approved = await askReview({
    title: meta.title,
    detail: meta.detail || '',
    danger: !!meta.danger,
    target: `${ssh.info.username}@${ssh.info.host}`,
    user: ssh.info.username,
    steps: op.steps,
  }, origin.chat);
  if (!approved) return { ok: false, cancelled: true, error: 'Cancelled' };
  op.mode = 'apply';
  if (!action.progress) return { ok: true, data: await ops.run(op, () => action.run(input)) };

  // Multi-step actions show each approved step as it runs, finishes or fails.
  const id = ++progressSeq;
  send('progress', { id, type: 'start', title: meta.title, steps: op.steps.map((s) => ({ what: s.what || 'Run command', via: s.via || null })) });
  op.onStep = (index, state, code) => send('progress', { id, type: 'step', index, state, code });
  try {
    const data = await ops.run(op, () => action.run(input));
    // A streamed job reports failure through its exit code rather than by throwing.
    send('progress', { id, type: 'end', ok: !(data && typeof data.code === 'number' && data.code !== 0) });
    return { ok: true, data };
  } catch (e) {
    send('progress', { id, type: 'end', ok: false, error: e.message || String(e) });
    throw e;
  }
}

/**
 * The single entry point for running an action, used by both the UI and the AI chat.
 * Resolves { ok: true, data } or { ok: false, cancelled: true } (user declined the review);
 * throws on invalid input or failure.
 */
async function runAction(id, input, origin = {}) {
  const action = actionsById.get(id);
  if (!action) throw new Error(`Unknown action ${id}`);
  const data = input == null ? {} : input;
  const problem = validate(action.input, data);
  if (problem) throw new Error(`Invalid input for ${id}: ${problem}`);
  if (!ssh.connected) throw new Error('Not connected to the server');
  return action.change ? reviewed(action, data, origin) : { ok: true, data: await action.run(data) };
}

const chat = createChat({
  actions,
  runAction,
  emit: (event) => send('chat', event),
  apiKey: () => store.aiKey(),
  serverLabel: () => (ssh.info ? `${ssh.info.username}@${ssh.info.host}` : null),
});

function defaultKeyPath() {
  for (const n of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const p = path.join(os.homedir(), '.ssh', n);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

async function connStatus() {
  if (!ssh.connected) return { connected: false };
  return { connected: true, ...ssh.info, sudoOk: ssh.info.sudoOk };
}

// ---- local handlers: things that concern this PC or the app itself, not the server ----
const handlers = {
  'settings:get': () => {
    const s = store.getPublic();
    if (!s.connection.keyPath) s.connection.keyPath = defaultKeyPath();
    return s;
  },
  'settings:save': (patch) => {
    store.update(patch);
    if (patch && patch.app) syncLoginItem();
  },
  'conn:status': connStatus,
  'conn:pickKey': async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select SSH private key',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? null : r.filePaths[0];
  },
  'conn:connect': async ({ acceptFingerprint } = {}) => {
    const c = store.get().connection;
    if (!c.host) throw new Error('Enter the server address first');
    const cfg = { ...c, keyPath: c.keyPath || defaultKeyPath(), secret: store.secret() };
    const id = store.hostKeyId(c);
    const info = await ssh.connect(cfg, { known: store.get().hostKeys[id], accept: acceptFingerprint });
    store.setHostKey(id, info.fingerprint);
    info.sudoOk = info.isRoot || (await ssh.exec('sudo -n true', { read: true })).code === 0;
    send('conn', await connStatus());
    return connStatus();
  },
  'conn:disconnect': () => ssh.disconnect(),
  'conn:forgetHostKey': () => store.forgetHostKey(store.hostKeyId(store.get().connection)),

  'chat:send': ({ text }) => chat.send(String(text || '')),
  'chat:stop': () => {
    chat.stop();
    cancelChatReviews();
  },
  'chat:reset': () => {
    chat.reset();
    cancelChatReviews();
  },

  'clipboard:write': (text) => clipboard.writeText(String(text)),
  'activity:count': (n) => setActiveCount(Math.max(0, Math.trunc(Number(n)) || 0)),
  /** The count badge on the taskbar button, drawn by the page (it has a canvas; this process has none). */
  'taskbar:overlay': ({ count, png }) => {
    if (!win || win.isDestroyed() || count !== activeCount || !count) return;
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(String(png))) throw new Error('Expected a PNG data URL');
    win.setOverlayIcon(nativeImage.createFromDataURL(png), `${count} deploying`);
  },
  'open:external': (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened');
    return shell.openExternal(url);
  },
};

ipcMain.handle('rpc', async (_event, channel, payload) => {
  try {
    if (actionsById.has(channel)) return await runAction(channel, payload);
    const fn = handlers[channel];
    if (!fn) return { ok: false, error: `Unknown channel ${channel}` };
    return { ok: true, data: await fn(payload) };
  } catch (e) {
    return { ok: false, error: e.message || String(e), hostKey: e.hostKey };
  }
});

ssh.on('closed', () => {
  send('conn', { connected: false });
  setActiveCount(0);
});

// ---- deploys in progress: the menu count and the app's taskbar button ----
// Polled here rather than in the page, so it keeps going while the window is minimised or
// hidden (when the taskbar is all there is to look at). The "Deploying now" screen refreshes
// faster and reports its own count, which resets this poll's clock.
const ACTIVITY_POLL_MS = 10000;
let activeCount = 0;
let countAt = 0;
function setActiveCount(n) {
  countAt = Date.now();
  if (n === activeCount) return;
  activeCount = n;
  send('activity', { count: n });
  if (!win || win.isDestroyed()) return;
  // Windows: an animated (indeterminate) progress bar across the taskbar button.
  win.setProgressBar(n ? 1 : -1, { mode: n ? 'indeterminate' : 'none' });
  win.setTitle(n ? `VPS Manager — ${n} deploying` : 'VPS Manager');
  if (tray) tray.setToolTip(win.getTitle());
  if (!n) win.setOverlayIcon(null, '');
}
(async function pollActivity() {
  if (ssh.connected && Date.now() - countAt > ACTIVITY_POLL_MS - 1000) {
    try {
      setActiveCount((await activity.list()).active.length);
    } catch {
      // Keep the last count; the screen itself shows errors.
    }
  }
  setTimeout(pollActivity, ACTIVITY_POLL_MS);
})();

// ---- the app on this PC: start with Windows, tray icon, close to tray ----
// Launches made by Windows at sign-in carry this flag, so only those start hidden; opening
// the app yourself always shows the window.
const HIDDEN_ARG = '--hidden';
let quitting = false;

/** Register (or remove) the app in Windows' startup list to match the settings. */
function syncLoginItem() {
  const { startWithWindows, startHidden } = store.get().app;
  // Run from source (npm start), Windows has to be told which folder electron.exe should open.
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), ...(startHidden ? [HIDDEN_ARG] : [])];
  app.setLoginItemSettings({ openAtLogin: startWithWindows, path: process.execPath, args });
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  tray = new Tray(icon);
  tray.setToolTip('VPS Manager');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open VPS Manager', click: showWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', showWindow);
}

function createWindow() {
  const startHidden = store.get().app.startHidden && process.argv.includes(HIDDEN_ARG);
  win = new BrowserWindow({
    show: !startHidden,
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#07080c',
    title: 'VPS Manager',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    // No native title bar: the app draws its own top bar (#titlebar) and Windows overlays
    // just the minimise / maximise / close buttons on its right-hand end.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07080c', symbolColor: '#a9b1c6', height: 48 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // The UI is local-only: never navigate away or open child windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  // Closing the window keeps the app (and its deploy watch) running in the tray.
  win.on('close', (e) => {
    if (quitting || !store.get().app.closeToTray) return;
    e.preventDefault();
    win.hide();
  });
}

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});
app.whenReady().then(() => {
  createTray();
  createWindow();
  // From source the startup entry is only written when the setting is saved, so running
  // `npm start` doesn't quietly add a development copy to Windows startup.
  if (app.isPackaged) syncLoginItem();
});
app.on('window-all-closed', () => {
  ssh.disconnect();
  app.quit();
});
