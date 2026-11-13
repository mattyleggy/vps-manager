import { h, api, button, copyButton, badge, icon, toast } from '../ui.js';

// The assistant side panel: docked to the right of whichever screen is showing, so the
// conversation stays in view while the user works. The transcript lives here; the main
// process holds the model's own history and streams events to it.
const state = { items: [], busy: false, mode: 'agent', chatId: null };
let els = null; // { panel, toggle, body, list, input, sendBtn, stopBtn, empty, working, modePicker, composer, history, historyBtn }

// Agent (default): only the app's own actions. Server: the assistant may also write and run any
// shell command - each one still shown here first and run only when Run is pressed.
const MODES = {
  agent: ['Agent', "Uses the app's built-in actions only."],
  server: ['Server', 'Can also write and run any shell command. You approve each one.'],
};

const SUGGESTIONS = ['How is the server doing?', 'List my sites and when their certificates expire', 'Which containers are not running, and why?', 'Show the last few deploys and whether they worked'];

const STATUS = {
  running: ['run', 'Working…'],
  done: ['ok', 'Done'],
  declined: ['', 'Not run'],
  failed: ['bad', 'Failed'],
};

// ---- minimal, safe markdown: paragraphs, bullet lists, **bold**, `code`, fenced code ----
function inline(text) {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)
    .filter(Boolean)
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return h('code', null, part.slice(1, -1));
      if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return h('strong', null, part.slice(2, -2));
      return part;
    });
}

function renderText(text) {
  const out = [];
  text.split('```').forEach((chunk, i) => {
    if (i % 2) {
      out.push(h('pre', { class: 'output' }, chunk.replace(/^[\w+-]*\n/, '').replace(/\n$/, '')));
      return;
    }
    let para = [];
    let list = null;
    const flush = () => {
      if (para.length) out.push(h('p', null, para.flatMap((line, n) => (n ? [h('br'), ...inline(line)] : inline(line)))));
      para = [];
    };
    for (const line of chunk.split('\n')) {
      const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      if (item) {
        flush();
        if (!list) out.push((list = h('ul')));
        list.append(h('li', null, inline(item[1])));
      } else if (!line.trim()) {
        flush();
        list = null;
      } else {
        list = null;
        para.push(line.replace(/^#+\s+/, ''));
      }
    }
    flush();
  });
  return out;
}

function inputSummary(input) {
  const parts = Object.entries(input || {}).map(([k, v]) => {
    if (typeof v === 'string' && (v.includes('\n') || v.length > 60)) return `${k}: (${v.split('\n').length} lines)`;
    if (v && typeof v === 'object' && !Array.isArray(v)) return `${k}: ${v.name || '{…}'}`;
    return `${k}: ${Array.isArray(v) ? v.join(', ') : v}`;
  });
  return parts.join(' · ');
}

/**
 * The question the assistant asks before it changes anything: what it is about to do, the
 * exact commands, and Run / Don't run. Nothing runs until Run is pressed.
 */
function renderConfirm(item) {
  const plan = item.plan;
  const n = plan.steps.length;
  return h(
    'div',
    { class: `msg confirm ${plan.danger ? 'danger' : ''}` },
    h('div', { class: 'confirm-kicker muted' }, 'The assistant wants to'),
    h('div', { class: 'confirm-title' }, plan.title),
    plan.detail && h('div', { class: plan.danger ? 'warn-box' : 'confirm-detail muted' }, plan.detail),
    plan.steps.map((s, i) =>
      h(
        'div',
        { class: 'step' },
        h('div', { class: 'step-head' }, h('span', { class: 'step-n' }, String(i + 1)), h('span', null, s.what || 'Run command'), h('span', { class: 'spacer' }), badge(s.via || (s.asRoot ? 'as root' : `as ${plan.user}`), s.via ? 'info' : '')),
        h('pre', { class: 'output' }, s.cmd),
        s.input != null && h('details', null, h('summary', null, `Show the content sent to this command (${s.input.split('\n').length} lines)`), h('pre', { class: 'output' }, s.input))
      )
    ),
    h('div', { class: 'confirm-foot muted' }, `Nothing has been changed yet. ${n === 1 ? 'This runs' : `These ${n} steps run in order`} on ${plan.target}.`),
    h(
      'div',
      { class: 'row confirm-actions' },
      button(n === 1 ? 'Run command' : `Run ${n} commands`, () => answer(item, true), plan.danger ? 'danger' : 'primary'),
      button("Don't run", () => answer(item, false))
    )
  );
}

const LOG_LIMIT = 200000; // characters of one step's output kept in the panel
const lastLine = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : '';
};
const lineCount = (text) => {
  const n = text ? text.replace(/\n$/, '').split('\n').length : 0;
  return n ? `${n} line${n === 1 ? '' : 's'}` : '';
};

/**
 * An approved step's output, streamed live: collapsed to its latest line, and expanded to the
 * whole log by clicking the row.
 */
function renderToolLog(item, row) {
  const log = item.log;
  const tail = h('div', { class: 'tool-tail mono' }, lastLine(log) || (item.status === 'running' ? 'Waiting for output…' : 'No output'));
  const pre = h('pre', { class: 'output tool-log' }, log);
  item.logEl = pre;
  item.tailEl = tail;
  item.countEl = h('span', { class: 'muted nowrap tool-lines' }, lineCount(log));
  const toggle = () => {
    item.logOpen = !item.logOpen;
    paint(item);
  };
  // Copies the whole log (not just what is shown), without toggling the row it sits in.
  const copy = copyButton(() => item.log, 'Copy', 'small ghost tool-copy');
  copy.title = 'Copy this output to the clipboard';
  copy.addEventListener('click', (e) => e.stopPropagation());
  copy.addEventListener('keydown', (e) => e.stopPropagation());
  return h(
    'div',
    { class: `msg tool has-log ${item.logOpen ? 'open' : ''}` },
    h('div', { class: 'tool-row', role: 'button', tabindex: '0', title: item.logOpen ? 'Hide output' : 'Show output', onclick: toggle, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle()) }, h('span', { class: 'chev' }, '▸'), row, item.countEl, copy),
    item.logOpen ? pre : tail
  );
}

function renderItem(item) {
  if (item.kind === 'user') return h('div', { class: 'msg user' }, item.text);
  if (item.kind === 'assistant') return h('div', { class: 'msg assistant' }, renderText(item.shown == null ? item.text : item.text.slice(0, item.shown)));
  if (item.kind === 'tool') {
    if (item.status === 'confirm') return renderConfirm(item);
    const [dot, label] = STATUS[item.status] || STATUS.running;
    item.logEl = item.tailEl = item.countEl = null;
    const row = [
      h('span', { class: `dot ${dot}` }),
      item.plan
        ? h('span', { class: 'tool-title' }, item.plan.title)
        : item.name === 'server_command' && item.input
          ? h('span', { class: 'tool-input tool-cmd', title: item.input.command }, `$ ${item.input.command}`)
          : [h('span', { class: 'mono' }, item.name.replace('_', ' › ')), h('span', { class: 'muted tool-input' }, inputSummary(item.input))],
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted nowrap', title: item.error || '' }, label),
    ];
    if (item.log != null) return renderToolLog(item, row);
    return h('div', { class: 'msg tool' }, row);
  }
  return h('div', { class: item.kind === 'error' ? 'error-box' : 'msg notice' }, item.text);
}

const toBottom = () => (els.body.scrollTop = els.body.scrollHeight);

function paint(item) {
  const pinned = els.body.scrollTop + els.body.clientHeight >= els.body.scrollHeight - 80;
  const el = renderItem(item);
  if (item.el && item.el.isConnected) item.el.replaceWith(el);
  else els.list.append(el);
  item.el = el;
  if (item.logEl) item.logEl.scrollTop = item.logEl.scrollHeight;
  if (pinned) toBottom();
}

/** New output for an approved step: updated in place so an open log keeps its scroll position. */
function appendLog(item, text) {
  const first = item.log == null;
  item.log = ((item.log || '') + text).slice(-LOG_LIMIT);
  if (first || !item.el || !item.el.isConnected || (!item.logEl && !item.tailEl)) return paint(item);
  const pinned = els.body.scrollTop + els.body.clientHeight >= els.body.scrollHeight - 80;
  if (item.logEl) {
    const pre = item.logEl;
    const follow = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
    pre.textContent = item.log;
    if (follow) pre.scrollTop = pre.scrollHeight;
  }
  if (item.tailEl) item.tailEl.textContent = lastLine(item.log) || 'Waiting for output…';
  if (item.countEl) item.countEl.textContent = lineCount(item.log);
  if (pinned) toBottom();
}

// ---- typing: the reply is revealed word by word, faster when a large chunk is waiting ----
let typing = null;
function typeTick() {
  typing = null;
  let more = false;
  for (const item of state.items) {
    if (item.kind !== 'assistant' || item.shown == null || item.shown >= item.text.length) continue;
    const rest = item.text.slice(item.shown);
    // ~60 words waiting adds a word per tick. Nobody watches a hidden window type, and its
    // timers are throttled, so there it is shown at once.
    const words = document.hidden ? Infinity : 1 + Math.floor(rest.length / 360);
    const re = /\s*\S+/g;
    let end = rest.length;
    for (let i = 0; i < words; i++) {
      if (!re.exec(rest)) {
        end = rest.length;
        break;
      }
      end = re.lastIndex;
    }
    item.shown += end;
    paint(item);
    if (item.shown < item.text.length) more = true;
  }
  if (more) typing = setTimeout(typeTick, 16);
}
const startTyping = () => {
  if (!typing) typing = setTimeout(typeTick, 16);
};

function add(item) {
  state.items.push(item);
  paint(item);
  sync();
  return item;
}

function sync() {
  const asking = state.items.some((i) => i.status === 'confirm');
  els.empty.classList.toggle('hidden', state.items.length > 0);
  els.sendBtn.classList.toggle('hidden', state.busy);
  els.stopBtn.classList.toggle('hidden', !state.busy);
  els.working.classList.toggle('hidden', !state.busy || asking);
  els.input.placeholder = asking
    ? 'Answer the question above: run it or not'
    : state.busy
      ? 'Working… you can type your next message'
      : state.mode === 'server'
        ? 'Describe a problem to solve on the server'
        : 'Ask about the server, or tell it what to do';
}

function setMode(mode) {
  state.mode = MODES[mode] ? mode : 'agent';
  try {
    localStorage.setItem('assistantMode', state.mode);
  } catch {
    /* not remembered */
  }
  const btn = els.modePicker.querySelector('.mode-btn');
  btn.dataset.mode = state.mode;
  btn.title = MODES[state.mode][1];
  btn.querySelector('.mode-label').textContent = MODES[state.mode][0];
  btn.querySelector('.mode-icon').replaceChildren(icon(MODE_ICONS[state.mode], 14));
  for (const opt of els.modePicker.querySelectorAll('.mode-option')) opt.setAttribute('aria-checked', String(opt.dataset.mode === state.mode));
  els.composer.classList.toggle('server', state.mode === 'server');
  sync();
}

// ---- the mode picker: a pill bottom left of the composer that opens a small menu upwards ----
const MODE_ICONS = { agent: 'sparkle', server: 'terminal' };

function modePicker() {
  const menu = h(
    'div',
    { class: 'mode-menu hidden', role: 'menu', 'aria-label': 'Assistant mode' },
    Object.entries(MODES).map(([id, [label, note]]) =>
      h(
        'button',
        { type: 'button', class: `mode-option ${id}`, role: 'menuitemradio', 'data-mode': id, onclick: () => pick(id) },
        h('span', { class: 'mode-option-icon' }, icon(MODE_ICONS[id], 15)),
        h('span', { class: 'mode-option-text' }, h('span', { class: 'mode-option-label' }, label), h('span', { class: 'mode-option-note' }, note)),
        h('span', { class: 'mode-check' }, icon('check', 14))
      )
    )
  );
  const btn = h(
    'button',
    { type: 'button', class: 'mode-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Assistant mode', onclick: () => (menu.classList.contains('hidden') ? open() : close()) },
    h('span', { class: 'mode-icon' }),
    h('span', { class: 'mode-label' }),
    h('span', { class: 'mode-chev' }, icon('chevron', 12))
  );
  const wrap = h('div', { class: 'mode-picker' }, menu, btn);
  const options = () => [...menu.querySelectorAll('.mode-option')];
  function open() {
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    (options().find((o) => o.dataset.mode === state.mode) || options()[0]).focus();
  }
  function close(refocus = false) {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
    if (refocus) btn.focus();
  }
  function pick(id) {
    setMode(id);
    close();
    els.input.focus();
  }
  menu.addEventListener('keydown', (e) => {
    const list = options();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close(true);
    }
  });
  document.addEventListener('mousedown', (e) => {
    if (!menu.classList.contains('hidden') && !wrap.contains(e.target)) close();
  });
  return wrap;
}

// ---- saved chats: each conversation is kept (transcript and model context) and can be reopened ----
const SAVED_LOG_LIMIT = 20000; // characters of a step's output kept in a saved chat

function serialize() {
  return state.items.map((item) => {
    const { el, logEl, tailEl, countEl, shown, closed, ...rest } = item;
    if (rest.status === 'confirm') rest.status = 'declined';
    if (typeof rest.log === 'string' && rest.log.length > SAVED_LOG_LIMIT) rest.log = rest.log.slice(-SAVED_LOG_LIMIT);
    return rest;
  });
}

async function saveChat() {
  try {
    state.chatId = await api('chat:save', { items: serialize(), mode: state.mode });
  } catch {
    /* not saved: the conversation still works, it just can't be reopened later */
  }
}

function showTranscript(items) {
  state.items = items;
  els.list.replaceChildren();
  for (const item of items) paint(item);
  sync();
  toBottom();
}

async function newChat() {
  await api('chat:reset').catch(() => {});
  state.chatId = null;
  showTranscript([]);
  closeHistory();
}

async function openChat(id) {
  if (state.busy) return toast('The assistant is still working. Stop it before opening another chat.', 'error');
  try {
    const c = await api('chat:open', { id });
    state.chatId = c.id;
    showTranscript(c.items.map((i) => ({ ...i, closed: true })));
    if (c.mode) setMode(c.mode);
    closeHistory();
    els.input.focus();
  } catch (e) {
    toast(e.message, 'error');
  }
}

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

const closeHistory = () => {
  els.history.classList.add('hidden');
  els.historyBtn.classList.remove('active');
};

async function toggleHistory() {
  if (!els.history.classList.contains('hidden')) return closeHistory();
  els.history.classList.remove('hidden');
  els.historyBtn.classList.add('active');
  els.history.replaceChildren(h('div', { class: 'muted history-empty' }, 'Loading…'));
  let chats = [];
  try {
    chats = await api('chat:list');
  } catch (e) {
    els.history.replaceChildren(h('div', { class: 'error-box' }, e.message));
    return;
  }
  const rows = chats.map((c) =>
    h(
      'div',
      { class: `history-item ${c.id === state.chatId ? 'current' : ''}` },
      h(
        'button',
        { type: 'button', class: 'history-open', title: c.title, onclick: () => (c.id === state.chatId ? closeHistory() : openChat(c.id)) },
        h('span', { class: 'history-title' }, c.title || 'Chat'),
        h('span', { class: 'history-meta muted' }, [ago(c.updatedAt), c.server].filter(Boolean).join(' · '))
      ),
      iconButton('trash', 'Delete chat', async (b) => {
        await api('chat:delete', { id: c.id }).catch(() => {});
        if (c.id === state.chatId) state.chatId = null;
        b.closest('.history-item').remove();
        if (!els.history.querySelector('.history-item')) els.history.append(h('div', { class: 'muted history-empty' }, 'No saved chats yet.'));
      }, 'ghost small')
    )
  );
  els.history.replaceChildren(h('div', { class: 'history-head muted' }, 'Recent chats'), ...(rows.length ? rows : [h('div', { class: 'muted history-empty' }, 'No saved chats yet.')]));
}

function iconButton(name, label, onClick, cls = '') {
  const b = h('button', { type: 'button', class: `btn icon-btn ${cls}`, 'aria-label': label, title: label }, icon(name, 16));
  b.addEventListener('click', () => onClick(b));
  return b;
}

const lastOpenAssistant = () => {
  const last = state.items[state.items.length - 1];
  return last && last.kind === 'assistant' && !last.closed ? last : null;
};

function answer(item, approved) {
  if (item.status !== 'confirm') return;
  window.api.reviewReply(item.plan.id, approved);
  item.status = approved ? 'running' : 'declined';
  if (approved && item.log == null) item.log = '';
  paint(item);
  sync();
}

/**
 * A change the assistant proposed is waiting for approval: ask in the panel, on the step
 * that proposed it. Returns false if that step is not in the transcript, so the caller can
 * fall back to the review dialog.
 */
export function review(plan) {
  const item = state.items.find((i) => i.kind === 'tool' && i.id === plan.chat);
  if (!item) return false;
  item.plan = plan;
  item.status = 'confirm';
  setOpen(true);
  paint(item);
  sync();
  toBottom();
  return true;
}

function onEvent(ev) {
  if (ev.type === 'text') {
    const cur = lastOpenAssistant();
    if (cur) cur.text += ev.delta;
    else add({ kind: 'assistant', text: ev.delta, shown: 0 });
    startTyping();
  } else if (ev.type === 'break') {
    const cur = lastOpenAssistant();
    if (cur) cur.closed = true;
  } else if (ev.type === 'discard') {
    const cur = lastOpenAssistant();
    if (cur) {
      state.items.pop();
      if (cur.el) cur.el.remove();
    }
  } else if (ev.type === 'tool') {
    const existing = state.items.find((i) => i.kind === 'tool' && i.id === ev.id);
    if (existing) paint(Object.assign(existing, { status: ev.status, error: ev.error }));
    else if (ev.status === 'running') add({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: ev.status });
  } else if (ev.type === 'log') {
    const item = state.items.find((i) => i.kind === 'tool' && i.id === ev.id);
    if (item) appendLog(item, ev.text);
  } else if (ev.type === 'notice' || ev.type === 'error') {
    add({ kind: ev.type, text: ev.text });
  } else if (ev.type === 'done') {
    state.busy = false;
    const cur = lastOpenAssistant();
    if (cur) cur.closed = true;
    saveChat();
  }
  sync();
}

function sendMessage(text) {
  text = text.trim();
  if (!text || state.busy) return false;
  state.busy = true;
  add({ kind: 'user', text });
  toBottom();
  api('chat:send', { text, mode: state.mode }).catch((e) => {
    state.busy = false;
    add({ kind: 'error', text: e.message });
  });
  return true;
}

function setOpen(open) {
  els.panel.classList.toggle('hidden', !open);
  els.toggle.classList.toggle('active', open);
  els.toggle.setAttribute('aria-pressed', String(open));
  try {
    localStorage.setItem('assistantOpen', open ? '1' : '0');
  } catch {
    /* the panel just won't be remembered */
  }
  if (open) {
    toBottom();
    els.input.focus();
  }
}

/** Called once at startup: builds the panel and subscribes to the assistant's event stream. */
export function init() {
  const panel = document.getElementById('assistant');
  const toggle = document.getElementById('assistant-toggle');
  toggle.prepend(icon('sparkle', 15));

  const input = h('textarea', { rows: '2', spellcheck: 'true' });
  const submit = () => {
    if (sendMessage(input.value)) input.value = '';
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  const sendBtn = iconButton('send', 'Send', submit, 'primary send-btn');
  const stopBtn = iconButton('stop', 'Stop', () => api('chat:stop').catch(() => {}), 'danger stop-btn');
  const list = h('div', { class: 'chat-list' });
  const working = h('div', { class: 'chat-working muted hidden' }, h('span', { class: 'dot run' }), 'Working…');
  const empty = h(
    'div',
    { class: 'chat-empty' },
    h('div', { class: 'muted' }, 'Ask questions or give instructions in plain language. Before the assistant changes anything on the server it tells you what it is about to do, shows the exact commands here and asks whether to run them. In Server mode it can also work out and run its own shell commands, again only after you press Run.'),
    h('div', { class: 'chat-suggestions' }, SUGGESTIONS.map((s) => button(s, () => sendMessage(s), 'small'))),
    h('div', { class: 'hint muted' }, "Your messages, and the server details needed to answer them (config files, logs, names), are sent to Anthropic's API using your API key. The webhook secret and your SSH credentials are never sent.")
  );
  const body = h('div', { class: 'assistant-body' }, empty, list, working);
  // Agent / Server, bottom left of the composer. Each option says what it allows.
  const modePickerEl = modePicker();
  const composer = h('div', { class: 'composer' }, input, h('div', { class: 'composer-bar' }, modePickerEl, h('span', { class: 'spacer' }), sendBtn, stopBtn));
  const history = h('div', { class: 'chat-history hidden', role: 'dialog', 'aria-label': 'Recent chats' });
  const historyBtn = iconButton('history', 'Recent chats', () => toggleHistory(), 'small ghost');

  panel.append(
    h(
      'header',
      { class: 'assistant-head' },
      h('span', { class: 'assistant-title' }, icon('sparkle', 16), 'Assistant'),
      h('span', { class: 'spacer' }),
      historyBtn,
      button('New chat', () => newChat(), 'small ghost'),
      button('Close', () => setOpen(false), 'small ghost')
    ),
    history,
    body,
    composer
  );

  els = { panel, toggle, body, list, input, sendBtn, stopBtn, empty, working, modePicker: modePickerEl, composer, history, historyBtn };
  toggle.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  document.addEventListener('mousedown', (e) => {
    if (!history.classList.contains('hidden') && !history.contains(e.target) && !historyBtn.contains(e.target)) closeHistory();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !history.classList.contains('hidden')) closeHistory();
  });
  window.api.on('chat', onEvent);

  let open = true;
  try {
    open = localStorage.getItem('assistantOpen') !== '0';
  } catch {
    /* default to open */
  }
  let mode = 'agent';
  try {
    mode = localStorage.getItem('assistantMode') || 'agent';
  } catch {
    /* default to agent */
  }
  setMode(mode);
  setOpen(open);
  sync();
}
