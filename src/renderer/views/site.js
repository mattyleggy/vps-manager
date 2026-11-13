// The nginx config editor: its own page under Sites, with the Monaco editor, nginx syntax help,
// a diff against the file on the server, and "write it with AI", which streams the new config
// into the editor as it is written. Saving goes through the usual review (and nginx -t).
import { h, api, button, badge, toast, breadcrumbs, icon, confirm, load } from '../ui.js';
import { loadMonaco } from '../monaco.js';
import { lintNginx, nginxErrors, formatNginx } from '../nginx-lang.js';

// Unsaved edits survive leaving the page (until the app is closed): `${kind}:${name}` -> { content, base }.
const drafts = new Map();
export const hasDraft = (name, kind = 'site') => drafts.has(`${kind}:${name}`);

// The preload bridge has no way to remove a listener, so there is one for the life of the page
// and it hands events to whichever editor is generating.
let onGen = null;
window.api.on('nginx-gen', (ev) => onGen && onGen(ev));

const PROMPTS = [
  ['HTTPS redirect', 'Redirect all HTTP requests to HTTPS (keep any certificate settings already here).'],
  ['WebSockets', 'Make WebSocket connections work through the proxy, with long read timeouts for them.'],
  ['gzip', 'Turn on gzip compression for text, JSON, JavaScript, CSS and SVG responses.'],
  ['Security headers', 'Add a sensible set of security headers (HSTS only if this site already serves HTTPS).'],
  ['Cache assets', 'Cache static assets (images, fonts, CSS, JS) in browsers for 30 days.'],
  ['Rate limit', 'Rate-limit each client IP to 10 requests per second with a burst of 20, returning 429 when exceeded.'],
  ['Bigger uploads', 'Allow uploads up to 100 MB and give slow requests 5 minutes before timing out.'],
];

const MONO = "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace";

export function render(root, ctx) {
  const { name, kind = 'site' } = ctx.params || {};
  if (!name) return ctx.go('domains');
  const key = `${kind}:${name}`;
  root.classList.add('site-page');
  root.append(breadcrumbs([['Sites', () => ctx.go('domains')], [name]]));

  load(root, async () => {
    const [site, monaco] = await Promise.all([api('nginx:read', { name, kind }), loadMonaco()]);
    if (!root.isConnected) return null; // the user moved on while it loaded
    return buildEditor(root, ctx, monaco, site, key);
  });
}

function buildEditor(root, ctx, monaco, site, key) {
  let saved = site.content;
  let lastError = '';
  let gen = null; // the AI generation in progress: { id, before, started, queue, follow }
  const draft = drafts.get(key);
  const model = monaco.editor.createModel(draft ? draft.content : saved, 'nginx');
  model.updateOptions({ tabSize: 4, insertSpaces: true });
  const original = monaco.editor.createModel(saved, 'nginx'); // what is on the server, for the diff

  // ---------------------------------------------------------------- layout
  const statusDot = h('span', { class: 'dot' });
  const statusText = h('span', null);
  const problemsEl = h('button', { class: 'status-item problems', type: 'button', title: 'Show problems (F8)' });
  const cursorEl = h('span', { class: 'status-item muted' });
  const editorHost = h('div', { class: 'monaco-host' });
  const diffHost = h('div', { class: 'monaco-host hidden' });
  const errorBox = h('div', { class: 'error-box editor-error hidden' });
  const notice = h('div', { class: 'hidden' });

  const formatBtn = button('Format', () => replaceAll(formatNginx(model.getValue())), 'small');
  formatBtn.title = 'Re-indent the file (Shift+Alt+F)';
  const revertBtn = button('Revert', revert, 'small');
  revertBtn.title = 'Discard your edits and go back to the version on the server';
  const changesBtn = button('Changes', () => setDiff(!diff), 'small');
  changesBtn.title = 'Compare with the version on the server';
  const trafficBtn = button('Traffic', () => ctx.go('traffic', false, { name: site.name, kind: site.kind }), 'small');
  trafficBtn.title = 'Recent requests to this site, from its nginx access log';
  const saveBtn = button('Save & reload nginx', save, 'primary');
  saveBtn.title = 'Save (Ctrl+S). You see the exact change before anything runs; nginx -t must pass or the old file is kept.';

  const prompt = h('textarea', {
    class: 'ai-prompt',
    rows: 4,
    spellcheck: 'false',
    placeholder: saved.trim() ? 'Describe the change, e.g. “send /api to port 4000 and allow 50 MB uploads”' : 'Describe the site, e.g. “example.com and www, a Next.js app on port 3000, with WebSockets”',
  });
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      generate();
    }
  });
  const chips = h(
    'div',
    { class: 'chips' },
    PROMPTS.map(([label, text]) =>
      h('button', { class: 'chip', type: 'button', title: text, onclick: () => ((prompt.value = text), prompt.focus()) }, label)
    )
  );
  const genBtn = button('Generate', () => generate(), 'primary');
  genBtn.prepend(icon('sparkle', 15));
  const stopBtn = button('Stop', () => api('nginx:generateStop').catch(() => {}), 'hidden');
  const aiStatus = h('div', { class: 'ai-status muted' });

  const page = h(
    'div',
    { class: 'site-editor' },
    h(
      'div',
      { class: 'page-head' },
      h('h1', null, site.name),
      site.enabled ? badge('Enabled', 'ok') : badge('Disabled'),
      h('span', { class: 'spacer' }),
      trafficBtn,
      formatBtn,
      revertBtn,
      changesBtn,
      saveBtn
    ),
    notice,
    h(
      'div',
      { class: 'site-layout' },
      h(
        'section',
        { class: 'editor-card' },
        h('div', { class: 'editor-bar' }, icon('file', 15), h('span', { class: 'mono' }, site.path), h('span', { class: 'spacer' }), statusDot, statusText),
        editorHost,
        diffHost,
        h('div', { class: 'editor-status' }, problemsEl, h('span', { class: 'spacer' }), cursorEl, h('span', { class: 'status-item muted' }, 'nginx · Spaces: 4'))
      ),
      h(
        'aside',
        { class: 'ai-card' },
        h('div', { class: 'ai-head' }, icon('sparkle', 16), h('span', null, 'Write with AI')),
        prompt,
        chips,
        h('div', { class: 'row' }, genBtn, stopBtn, h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, 'Ctrl+Enter')),
        aiStatus,
        h('div', { class: 'hint muted' }, 'The new config is typed into the editor as it is written. Nothing reaches the server until you save, and saving shows you the change first. Ctrl+Z undoes a whole generation.')
      )
    ),
    errorBox
  );

  if (draft) {
    const changedOnServer = draft.base !== saved;
    notice.className = changedOnServer ? 'warn-box' : 'info-box';
    notice.replaceChildren(
      h('span', null, changedOnServer ? 'Your unsaved edits are restored, but the file on the server has changed since you started. Use Changes to compare before saving. ' : 'Your unsaved edits from earlier are restored. '),
      button('Discard them', () => (notice.classList.add('hidden'), replaceAll(saved)), 'small ghost')
    );
  }

  // ---------------------------------------------------------------- editor
  const common = {
    theme: 'vpsm-dark',
    automaticLayout: true,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 20,
    fontLigatures: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    fixedOverflowWidgets: true,
    padding: { top: 12, bottom: 12 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    renderLineHighlight: 'all',
  };
  const editor = monaco.editor.create(editorHost, {
    ...common,
    model,
    minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
    cursorSmoothCaretAnimation: 'on',
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    quickSuggestions: { other: true, comments: false, strings: false },
    suggest: { showWords: false, preview: true },
    wordBasedSuggestions: 'off',
    renderWhitespace: 'selection',
    formatOnPaste: false,
  });
  let diff = null;
  const writing = editor.createDecorationsCollection();

  function setDiff(on) {
    if (on === !!diff) return;
    if (on) {
      diff = monaco.editor.createDiffEditor(diffHost, {
        ...common,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        originalEditable: false,
        readOnly: !!gen,
        minimap: { enabled: false },
        hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4 },
        renderOverviewRuler: true,
      });
      diff.setModel({ original, modified: model });
      editorHost.classList.add('hidden');
      diffHost.classList.remove('hidden');
      diff.getModifiedEditor().focus();
    } else {
      diff.dispose();
      diff = null;
      diffHost.replaceChildren();
      diffHost.classList.add('hidden');
      editorHost.classList.remove('hidden');
      editor.focus();
    }
    changesBtn.classList.toggle('active', on);
    changesBtn.textContent = on ? 'Back to editor' : 'Changes';
  }

  /** Replace the whole text as one undoable step (works while the editor is read-only, too). */
  function replaceAll(text) {
    if (text === model.getValue()) return;
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    model.pushStackElement();
  }

  // ---------------------------------------------------------------- status and checks
  const SEV = { error: monaco.MarkerSeverity.Error, warning: monaco.MarkerSeverity.Warning };
  function updateStatus() {
    const dirty = model.getValue() !== saved;
    statusDot.className = `dot ${gen ? 'run' : dirty ? 'warn' : 'ok'}`;
    statusText.textContent = gen ? 'AI is writing…' : dirty ? 'Unsaved changes' : 'Saved on the server';
    revertBtn.disabled = !dirty || !!gen;
    saveBtn.disabled = !!gen;
    formatBtn.disabled = !!gen;
  }
  function lint() {
    if (gen) return; // a half-written file is always "broken"
    const problems = lintNginx(model.getValue());
    monaco.editor.setModelMarkers(
      model,
      'lint',
      problems.map((p) => ({ startLineNumber: p.line, startColumn: p.col, endLineNumber: p.endLine || p.line, endColumn: p.endCol || p.col + 1, message: p.message, severity: SEV[p.severity], source: 'check' }))
    );
    showProblemCount();
  }
  function showProblemCount() {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri });
    const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
    const warnings = markers.length - errors;
    problemsEl.className = `status-item problems ${errors ? 'bad' : warnings ? 'warn' : 'ok'}`;
    problemsEl.textContent = errors || warnings ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'No problems found';
  }
  problemsEl.addEventListener('click', () => {
    const target = diff ? diff.getModifiedEditor() : editor;
    target.focus();
    target.trigger('status', 'editor.action.marker.next', null);
  });
  let lintTimer = 0;
  model.onDidChangeContent(() => {
    updateStatus();
    clearTimeout(lintTimer);
    lintTimer = setTimeout(lint, 250);
  });
  editor.onDidChangeCursorPosition((e) => (cursorEl.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`));
  cursorEl.textContent = 'Ln 1, Col 1';

  /** Show nginx -t's complaint, and mark the lines it points at. */
  function showError(message) {
    lastError = message;
    const paths = [site.path, `/etc/nginx/sites-enabled/${site.name}`];
    const found = nginxErrors(message, paths);
    monaco.editor.setModelMarkers(
      model,
      'nginx',
      found.map((f) => {
        const line = Math.min(Math.max(1, f.line), model.getLineCount());
        return { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line), message: `nginx -t: ${f.message}`, severity: SEV[f.severity], source: 'nginx -t' };
      })
    );
    showProblemCount();
    if (found.length) editor.revealLineInCenter(Math.min(found[0].line, model.getLineCount()));
    errorBox.replaceChildren(
      h('div', { class: 'row' }, h('strong', null, 'Not saved: nginx rejected this config. The previous file is still in place.'), h('span', { class: 'spacer' }),
        button('Fix with AI', () => generate('Fix the problem nginx -t reported, changing as little as possible.', { fix: true }), 'small primary'),
        button('Dismiss', clearError, 'small ghost')),
      h('pre', { class: 'output' }, message)
    );
    errorBox.classList.remove('hidden');
  }
  function clearError() {
    lastError = '';
    errorBox.classList.add('hidden');
    monaco.editor.setModelMarkers(model, 'nginx', []);
    showProblemCount();
  }

  // ---------------------------------------------------------------- save / revert
  async function save() {
    if (gen) return;
    const content = model.getValue();
    const errors = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'lint' }).filter((m) => m.severity === monaco.MarkerSeverity.Error);
    if (errors.length && !(await confirm('Save with problems?', `The editor found ${errors.length} problem${errors.length === 1 ? '' : 's'} (first: line ${errors[0].startLineNumber}, ${errors[0].message}). nginx -t will most likely reject it, in which case the old file is kept.`, { okLabel: 'Save anyway' }))) return;
    const label = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await api('nginx:save', { name: site.name, kind: site.kind, content });
      saved = content;
      original.setValue(saved);
      drafts.delete(key);
      notice.classList.add('hidden');
      clearError();
      toast('Saved, tested and reloaded nginx', 'ok');
    } catch (e) {
      if (!e.cancelled) showError(e.message);
    } finally {
      saveBtn.textContent = label;
      updateStatus();
    }
  }

  async function revert() {
    if (model.getValue() === saved) return;
    if (!(await confirm('Revert your edits?', 'The editor goes back to the version on the server. You can still undo this with Ctrl+Z while the page is open.', { okLabel: 'Revert' }))) return;
    replaceAll(saved);
    notice.classList.add('hidden');
  }

  // ---------------------------------------------------------------- write with AI
  function setGenerating(on) {
    editor.updateOptions({ readOnly: on });
    if (diff) diff.updateOptions({ readOnly: on });
    prompt.disabled = on;
    genBtn.classList.toggle('hidden', on);
    stopBtn.classList.toggle('hidden', !on);
    page.classList.toggle('generating', on);
    for (const c of chips.children) c.disabled = on;
    updateStatus();
  }

  function setAiStatus(text, cls = '') {
    aiStatus.className = `ai-status ${cls || 'muted'}`;
    aiStatus.replaceChildren(...(cls === 'run' ? [h('span', { class: 'spinner' })] : []), text);
  }

  async function generate(instruction, { fix = false } = {}) {
    if (gen) return;
    instruction = instruction || prompt.value.trim();
    if (!instruction) {
      prompt.focus();
      return toast('Describe what the config should do first', 'error');
    }
    setDiff(false);
    gen = { id: null, before: model.getValue(), started: false, queue: [], follow: true };
    onGen = handle;
    setGenerating(true);
    setAiStatus('Starting…', 'run');
    try {
      const r = await api('nginx:generate', { name: site.name, kind: site.kind, path: site.path, current: gen.before, instruction, lastError: fix ? lastError : '' });
      if (!gen) return;
      gen.id = r.id;
      for (const ev of gen.queue.splice(0)) handle(ev);
    } catch (e) {
      finish();
      setAiStatus(e.message, 'bad');
    }
  }

  function append(text) {
    const end = model.getFullModelRange().getEndPosition();
    model.pushEditOperations([], [{ range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column), text }], () => null);
    const last = model.getLineCount();
    writing.set([{ range: new monaco.Range(last, 1, last, 1), options: { isWholeLine: true, className: 'ai-writing-line' } }]);
    if (gen.follow) editor.revealLine(last, 1 /* immediate: smooth scrolling lags behind fast output */);
  }

  function handle(ev) {
    if (!gen) return;
    if (gen.id == null) return void gen.queue.push(ev);
    if (ev.id !== gen.id) return;
    if (ev.type === 'thinking') {
      setAiStatus('Thinking about the change…', 'run');
    } else if (ev.type === 'delta') {
      if (!gen.started) {
        // The whole generation is one undo step: Ctrl+Z brings back the text from before it.
        gen.started = true;
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: '' }], () => null);
        editor.setScrollTop(0);
      }
      append(ev.text);
      const lines = `${model.getLineCount()} lines`;
      setAiStatus(`Writing… ${lines}`, 'run');
      statusText.textContent = `AI is writing… ${lines}`; // visible even when the AI card is scrolled away
    } else if (ev.type === 'done') {
      if (!gen.started) {
        model.pushStackElement();
        gen.started = true;
      }
      if (model.getValue() !== ev.text) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: ev.text }], () => null);
      model.pushStackElement();
      const changedFromBefore = ev.text !== gen.before;
      finish();
      if (!changedFromBefore) return setAiStatus('Done: the AI left the file as it was.', 'ok');
      setAiStatus(ev.text === saved ? 'Done. The result matches the file on the server.' : 'Done. Showing what changed compared with the server. Save when it looks right.', 'ok');
      if (ev.text !== saved) setDiff(true);
    } else if (ev.type === 'error' || ev.type === 'stopped') {
      if (gen.started) {
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: gen.before }], () => null);
        model.pushStackElement();
      }
      finish();
      setAiStatus(ev.type === 'stopped' ? 'Stopped. Your text is as it was before.' : ev.message, ev.type === 'stopped' ? 'muted' : 'bad');
    }
  }

  function finish() {
    gen = null;
    onGen = null;
    writing.clear();
    setGenerating(false);
    lint();
  }

  // Scrolling up while it writes stops the editor following the new lines.
  editor.onDidScrollChange((e) => {
    if (!gen || !e.scrollTopChanged) return;
    const bottom = e.scrollTop + editor.getLayoutInfo().height >= e.scrollHeight - 40;
    gen.follow = bottom;
  });

  // ---------------------------------------------------------------- keys and leaving
  page.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        save();
      }
    },
    true
  );

  ctx.onLeave(() => {
    if (gen) {
      api('nginx:generateStop').catch(() => {});
      const before = gen.before;
      gen = null;
      onGen = null;
      model.setValue(before);
    }
    const content = model.getValue();
    if (content !== saved) drafts.set(key, { content, base: saved });
    else drafts.delete(key);
    clearTimeout(lintTimer);
    if (diff) diff.dispose();
    editor.dispose();
    model.dispose();
    original.dispose();
  });

  updateStatus();
  lint();
  requestAnimationFrame(() => editor.focus());
  return page;
}
