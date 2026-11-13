import { h, badge, modal } from '../ui.js';

// Live progress of an approved action: one row per reviewed step, marked as it runs, finishes
// or fails, with the output each step produced. The main process sends 'progress' events
// (start / step / end) for actions that ask for it; console output arrives as 'job' events.

const LABEL = { wait: ['Waiting', ''], run: ['Running…', 'info'], ok: ['Done', 'ok'], fail: ['Failed', 'bad'], skip: ['Not run', 'warn'] };
const DOT = { wait: '', run: 'run', ok: 'ok', fail: 'bad', skip: '' };
const OUTPUT_LIMIT = 100000;

let current = null; // the run being shown
const starters = new Set();

/** Call fn once, the next time an approved run starts (used to move a form out of the way). Returns a cancel function. */
export function onNextStart(fn) {
  starters.add(fn);
  return () => starters.delete(fn);
}

function setState(step, state) {
  step.state = state;
  step.dot.className = `dot ${DOT[state]}`;
  step.status.replaceChildren(badge(...LABEL[state]));
  step.el.dataset.state = state;
}

function append(pre, text) {
  pre.textContent = (pre.textContent + text).slice(-OUTPUT_LIMIT);
  pre.classList.remove('hidden');
  pre.scrollTop = pre.scrollHeight;
}

function start(ev) {
  for (const fn of [...starters]) {
    starters.delete(fn);
    fn();
  }
  const summary = h('div', { class: 'info-box progress-summary' }, `Running ${ev.steps.length === 1 ? 'the step' : `${ev.steps.length} steps, in order`}. You can close this window; the run continues and its output stays in the panel at the bottom.`);
  const steps = ev.steps.map((s, i) => {
    const dot = h('span', { class: 'dot' });
    const status = h('span');
    const out = h('pre', { class: 'output hidden' });
    const el = h(
      'div',
      { class: 'step progress-step' },
      h('div', { class: 'step-head' }, dot, h('span', { class: 'step-n' }, String(i + 1)), h('span', null, s.what), h('span', { class: 'spacer' }), s.via && badge(s.via, 'info'), status),
      out
    );
    const step = { el, dot, status, out, state: 'wait' };
    setState(step, 'wait');
    return step;
  });
  const rest = h('pre', { class: 'output hidden' });
  const run = { id: ev.id, steps, summary, rest, pending: '', done: false };
  current = run;
  modal({
    title: ev.title,
    wide: true,
    body: [summary, steps.map((s) => s.el), rest],
    onClose: () => {
      if (current === run && run.done) current = null;
    },
  });
}

function step(ev) {
  const s = current.steps[ev.index];
  if (!s) return;
  setState(s, ev.state);
  if (ev.state === 'run') {
    // Lines printed just before a step starts announce it, so they belong to it.
    if (current.pending) append(s.out, current.pending);
    current.pending = '';
    s.el.scrollIntoView({ block: 'nearest' });
  } else if (ev.state === 'fail' && ev.code != null && ev.code !== 0 && !s.out.textContent.trim()) {
    append(s.out, `Exit code ${ev.code}\n`);
  }
}

function end(ev) {
  const run = current;
  run.done = true;
  for (const s of run.steps) {
    if (s.state === 'run') setState(s, ev.ok ? 'ok' : 'fail');
    else if (s.state === 'wait') setState(s, 'skip');
  }
  if (run.pending.trim()) append(run.rest, run.pending);
  run.pending = '';
  const n = run.steps.length;
  const failed = run.steps.findIndex((s) => s.state === 'fail');
  const skipped = run.steps.filter((s) => s.state === 'skip').length;
  let text;
  if (failed < 0 && !skipped && ev.ok) {
    run.summary.className = 'info-box progress-summary done';
    text = n === 1 ? 'The step completed.' : `All ${n} steps completed.`;
  } else {
    run.summary.className = 'error-box progress-summary';
    text =
      failed >= 0
        ? `Step ${failed + 1} failed${skipped ? `, so the ${skipped === 1 ? 'step' : `${skipped} steps`} after it ${skipped === 1 ? 'was' : 'were'} not run` : ''}. Its output is shown under the step.`
        : `The run stopped${skipped ? ` before ${skipped === 1 ? 'the last step' : `the last ${skipped} steps`}` : ''}.`;
    if (ev.error) text += `\n\n${ev.error}`;
  }
  run.summary.textContent = text;
  run.summary.scrollIntoView({ block: 'nearest' });
}

/** 'progress' events from the main process. */
export function handle(ev) {
  if (ev.type === 'start') return start(ev);
  if (!current || current.id !== ev.id || current.done) return;
  if (ev.type === 'step') step(ev);
  else if (ev.type === 'end') end(ev);
}

/** 'job' events: console output goes under the step that is running when it arrives. */
export function onJob(ev) {
  if (!current || current.done || ev.type !== 'data') return;
  const running = current.steps.find((s) => s.state === 'run');
  if (running) append(running.out, ev.text);
  else current.pending += ev.text;
}
