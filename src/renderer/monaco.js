// Loads the Monaco editor (the editor from VS Code) on first use, from the copy installed in
// node_modules, and registers the nginx language. Monaco's AMD build runs from plain script
// tags, so it needs no bundler and works under the page's script-src 'self' policy.
import { api } from './ui.js';
import { registerNginx } from './nginx-lang.js';

const BASE = new URL('../../node_modules/monaco-editor/min/', import.meta.url).href;
let loading = null;

function addScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.append(s);
  });
}

export function loadMonaco() {
  if (loading) return loading;
  loading = (async () => {
    // The worker file name carries a content hash; the main process looks it up.
    const worker = await api('monaco:worker').catch(() => null);
    await addScript(`${BASE}vs/loader.js`);
    const amdRequire = window.require;
    amdRequire.config({ paths: { vs: `${BASE}vs` } });
    // editor.main is the full editor (suggestions, hover, find, folding, formatting...); plain
    // 'vs/editor' is only the core API without those features. It adds its own stylesheet.
    const monaco = await new Promise((resolve, reject) => amdRequire(['vs/editor/editor.main'], resolve, reject));
    // editor.main installs a worker factory that starts workers from blob: URLs, which the page's
    // CSP (worker-src 'self') blocks. Workers start lazily, so replacing it now is in time: the
    // one worker an nginx editor uses (diffs, word ranges) loads straight from its file instead.
    self.MonacoEnvironment = {
      getWorker(_id, label) {
        if (!worker) throw new Error(`No Monaco worker for ${label}`); // Monaco then runs it on the page instead
        return new Worker(BASE + worker, { name: label });
      },
    };
    registerNginx(monaco);
    window.monaco = monaco;
    return monaco;
  })();
  loading.catch(() => (loading = null));
  return loading;
}
