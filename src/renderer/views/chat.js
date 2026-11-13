import { h, api, button, badge, icon } from '../ui.js';

// The assistant side panel: docked to the right of whichever screen is showing, so the
// conversation stays in view while the user works. The transcript lives here; the main
// process holds the model's own history and streams events to it.
const state = { items: [], busy: false };
let els = null; // { panel, toggle, body, list, input, sendBtn, stopBtn, empty, working }

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

function renderItem(item) {
  if (item.kind === 'user') return h('div', { class: 'msg user' }, item.text);
  if (item.kind === 'assistant') return h('div', { class: 'msg assistant' }, renderText(item.text));
  if (item.kind === 'tool') {
    if (item.status === 'confirm') return renderConfirm(item);
    const [dot, label] = STATUS[item.status] || STATUS.running;
    return h(
      'div',
      { class: 'msg tool' },
      h('span', { class: `dot ${dot}` }),
      item.plan ? h('span', { class: 'tool-title' }, item.plan.title) : [h('span', { class: 'mono' }, item.name.replace('_', ' › ')), h('span', { class: 'muted tool-input' }, inputSummary(item.input))],
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted nowrap', title: item.error || '' }, label)
    );
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
  if (pinned) toBottom();
}

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
  els.input.placeholder = asking ? 'Answer the question above: run it or not' : state.busy ? 'Working… you can type your next message' : 'Ask about the server, or tell it what to do';
}

const lastOpenAssistant = () => {
  const last = state.items[state.items.length - 1];
  return last && last.kind === 'assistant' && !last.closed ? last : null;
};

function answer(item, approved) {
  if (item.status !== 'confirm') return;
  window.api.reviewReply(item.plan.id, approved);
  item.status = approved ? 'running' : 'declined';
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
    if (cur) {
      cur.text += ev.delta;
      paint(cur);
    } else {
      add({ kind: 'assistant', text: ev.delta });
    }
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
  } else if (ev.type === 'notice' || ev.type === 'error') {
    add({ kind: ev.type, text: ev.text });
  } else if (ev.type === 'done') {
    state.busy = false;
    const cur = lastOpenAssistant();
    if (cur) cur.closed = true;
  }
  sync();
}

function sendMessage(text) {
  text = text.trim();
  if (!text || state.busy) return false;
  state.busy = true;
  add({ kind: 'user', text });
  toBottom();
  api('chat:send', { text }).catch((e) => {
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
  const sendBtn = button('Send', submit, 'primary');
  const stopBtn = button('Stop', () => api('chat:stop').catch(() => {}), 'danger');
  const list = h('div', { class: 'chat-list' });
  const working = h('div', { class: 'chat-working muted hidden' }, h('span', { class: 'dot run' }), 'Working…');
  const empty = h(
    'div',
    { class: 'chat-empty' },
    h('div', { class: 'muted' }, 'Ask questions or give instructions in plain language. Before the assistant changes anything on the server it tells you what it is about to do, shows the exact commands here and asks whether to run them.'),
    h('div', { class: 'chat-suggestions' }, SUGGESTIONS.map((s) => button(s, () => sendMessage(s), 'small'))),
    h('div', { class: 'hint muted' }, "Your messages, and the server details needed to answer them (config files, logs, names), are sent to Anthropic's API using your API key. The webhook secret and your SSH credentials are never sent.")
  );
  const body = h('div', { class: 'assistant-body' }, empty, list, working);

  panel.append(
    h(
      'header',
      { class: 'assistant-head' },
      h('span', { class: 'assistant-title' }, icon('sparkle', 16), 'Assistant'),
      h('span', { class: 'spacer' }),
      button(
        'New chat',
        async () => {
          await api('chat:reset').catch(() => {});
          state.items = [];
          list.replaceChildren();
          sync();
        },
        'small ghost'
      ),
      button('Close', () => setOpen(false), 'small ghost')
    ),
    body,
    h('div', { class: 'composer' }, input, sendBtn, stopBtn)
  );

  els = { panel, toggle, body, list, input, sendBtn, stopBtn, empty, working };
  toggle.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  window.api.on('chat', onEvent);

  let open = true;
  try {
    open = localStorage.getItem('assistantOpen') !== '0';
  } catch {
    /* default to open */
  }
  setOpen(open);
  sync();
}
