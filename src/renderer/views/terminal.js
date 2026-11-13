import { h, api, button, icon } from '../ui.js';

// The terminal panel: an interactive shell on the server, docked under the current screen.
// Ctrl+` shows or hides it (VS Code's shortcut). Hiding keeps the shell running; Close ends it.
// The terminal itself is xterm.js, loaded from node_modules on first use.

const BASE = new URL('../../../node_modules/@xterm/', import.meta.url).href;
const HEIGHT_KEY = 'terminalHeight';

let loading = null;
const s = { term: null, fit: null, id: null, starting: false, open: false, els: null, isConnected: () => false };

function addScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(el);
  });
}

/** xterm's UMD build registers with an AMD loader when one is present (Monaco's), so hide it while loading. */
function loadXterm() {
  if (loading) return loading;
  loading = (async () => {
    const define = window.define;
    window.define = undefined;
    try {
      await addScript(`${BASE}xterm/lib/xterm.js`);
      await addScript(`${BASE}addon-fit/lib/addon-fit.js`);
    } finally {
      window.define = define;
    }
    return { Terminal: window.Terminal, FitAddon: window.FitAddon.FitAddon };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

function setStatus(text, dot = '') {
  s.els.dot.className = `dot ${dot}`;
  s.els.title.textContent = text;
}

function fit() {
  if (!s.term || !s.open) return;
  try {
    s.fit.fit();
  } catch {
    return; // not laid out yet
  }
  if (s.id) api('term:resize', { id: s.id, cols: s.term.cols, rows: s.term.rows }).catch(() => {});
}

async function ensureTerm() {
  if (s.term) return;
  const { Terminal, FitAddon } = await loadXterm();
  const css = getComputedStyle(document.documentElement);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: css.getPropertyValue('--mono').trim() || 'Consolas, monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 5000,
    allowProposedApi: false,
    theme: {
      background: '#090a0f',
      foreground: '#cdd3e4',
      cursor: '#a99dff',
      selectionBackground: 'rgba(124, 108, 255, 0.35)',
      black: '#1b1e29', brightBlack: '#5d6379',
      red: '#f87171', brightRed: '#fca5a5',
      green: '#34d399', brightGreen: '#6ee7b7',
      yellow: '#fbbf24', brightYellow: '#fcd34d',
      blue: '#7c9cff', brightBlue: '#a5b8ff',
      magenta: '#a99dff', brightMagenta: '#c4b5fd',
      cyan: '#3ec5ff', brightCyan: '#7dd8ff',
      white: '#c3c8d8', brightWhite: '#eceef6',
    },
  });
  s.fit = new FitAddon();
  term.loadAddon(s.fit);
  // Ctrl+Shift+C / Ctrl+C with a selection copy; Ctrl+V / Ctrl+Shift+V paste (the browser's own
  // paste event, which xterm turns into input). Everything else goes to the shell.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && (e.shiftKey || term.hasSelection())) {
      if (term.hasSelection()) api('clipboard:write', term.getSelection()).catch(() => {});
      term.clearSelection();
      return false;
    }
    if (k === 'v') return false;
    return true;
  });
  term.onData((data) => {
    if (s.id) window.api.termWrite(s.id, data);
    else if (data === '\r' && !s.starting) start();
  });
  term.open(s.els.screen);
  s.term = term;
}

/** Start a new shell on the server (the old one, if any, has ended). */
async function start() {
  if (s.starting) return;
  if (!s.isConnected()) {
    setStatus('Not connected');
    s.term.write('\r\n\x1b[33mConnect to the server first, then press Enter here to open a shell.\x1b[0m\r\n');
    return;
  }
  s.starting = true;
  setStatus('Connecting…', 'run');
  try {
    fit();
    const r = await api('term:open', { cols: s.term.cols, rows: s.term.rows });
    s.id = r.id;
    setStatus(r.target, 'ok');
    s.term.focus();
  } catch (e) {
    setStatus('Not connected', 'bad');
    s.term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n\x1b[90mPress Enter to try again.\x1b[0m\r\n`);
  } finally {
    s.starting = false;
  }
}

function onEvent(ev) {
  if (ev.id !== s.id || !s.term) return;
  if (ev.type === 'data') s.term.write(ev.data);
  else if (ev.type === 'exit') {
    s.id = null;
    setStatus('Session ended');
    s.term.write('\r\n\x1b[90m[Session ended. Press Enter to start a new one.]\x1b[0m\r\n');
  }
}

export async function show() {
  s.open = true;
  s.els.panel.classList.remove('hidden');
  s.els.toggle.classList.add('active');
  try {
    await ensureTerm();
  } catch (e) {
    setStatus(e.message, 'bad');
    return;
  }
  fit();
  if (!s.id) await start();
  s.term.focus();
}

export function hide() {
  s.open = false;
  s.els.panel.classList.add('hidden');
  s.els.toggle.classList.remove('active');
}

export const toggle = () => (s.open ? hide() : show());

/** The terminal's text content (its buffer, not the painted rows), for tests. */
export function bufferText() {
  if (!s.term) return '';
  const b = s.term.buffer.active;
  const lines = [];
  for (let i = 0; i < b.length; i++) lines.push(b.getLine(i).translateToString(true));
  return lines.join('\n').trimEnd();
}

/** End the shell and hide the panel. */
function close() {
  if (s.id) api('term:close', { id: s.id }).catch(() => {});
  s.id = null;
  if (s.term) s.term.reset();
  hide();
}

/** Drag the panel's top edge to change its height (remembered). */
function resizer(panel) {
  const grip = h('div', { class: 'term-grip', title: 'Drag to resize' });
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const move = (ev) => {
      const max = window.innerHeight - 160;
      panel.style.height = `${Math.round(Math.min(max, Math.max(140, startH + startY - ev.clientY)))}px`;
      fit();
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(HEIGHT_KEY, panel.style.height);
      } catch {
        /* not remembered */
      }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  return grip;
}

/** Called once at startup. isConnected() reports whether the app has an SSH connection. */
export function init(isConnected) {
  s.isConnected = isConnected;
  const panel = document.getElementById('terminal');
  const toggleBtn = document.getElementById('terminal-toggle');
  toggleBtn.prepend(icon('terminal', 15));
  toggleBtn.addEventListener('click', toggle);

  const dot = h('span', { class: 'dot' });
  const title = h('span', { class: 'term-title' }, 'Terminal');
  const screen = h('div', { class: 'term-screen' });
  panel.append(
    resizer(panel),
    h(
      'header',
      null,
      icon('terminal', 15),
      dot,
      title,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted term-hint' }, h('kbd', null, 'Ctrl'), '+', h('kbd', null, '`'), ' to show or hide'),
      button('Hide', hide, 'small ghost'),
      button('Close', close, 'small ghost')
    ),
    screen
  );
  try {
    const saved = localStorage.getItem(HEIGHT_KEY);
    if (saved) panel.style.height = saved;
  } catch {
    /* default height */
  }
  s.els = { panel, toggle: toggleBtn, dot, title, screen };

  new ResizeObserver(() => fit()).observe(screen);
  window.api.on('term', onEvent);
  // Capture phase, so the shortcut works even while the terminal or an editor has focus.
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'Backquote') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    },
    true
  );
}
