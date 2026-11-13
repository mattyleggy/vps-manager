import { h, api, act, button, badge, confirm, field, input, select, pageHead, load, toast } from '../ui.js';

async function connect(ctx, acceptFingerprint) {
  try {
    await api('conn:connect', { acceptFingerprint });
    toast('Connected', 'ok');
  } catch (e) {
    if (!e.hostKey) throw e;
    // First connection (or the server's key changed): the user must approve the fingerprint
    // before any credentials are offered to that host.
    const changed = e.hostKey.kind === 'changed';
    const ok = await confirm(
      changed ? 'WARNING: server host key has changed' : 'Trust this server?',
      changed
        ? `The server presented a different key than last time.\n\nPreviously trusted: ${e.hostKey.known}\nPresented now:      ${e.hostKey.fingerprint}\n\nThis is expected if you rebuilt or reinstalled the VPS. If you did not, someone may be intercepting the connection — do not continue.`
        : `First connection to this server. Its host key fingerprint is:\n\n${e.hostKey.fingerprint}\n\nYou can compare it with the output of this command in the Vultr web console:\nssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`,
      { okLabel: changed ? 'Trust new key' : 'Trust & connect', danger: changed }
    );
    if (ok) await connect(ctx, e.hostKey.fingerprint);
  }
}

export function render(root, ctx) {
  root.append(pageHead('Settings'));
  load(root, async () => {
    const s = await api('settings:get');
    const c = s.connection;
    const host = input({ value: c.host, placeholder: '203.0.113.10 or server.example.com' });
    const port = input({ value: String(c.port || 22) });
    const user = input({ value: c.username || 'root' });
    const auth = select([['key', 'Private key file'], ['agent', 'Windows OpenSSH agent'], ['password', 'Password']], c.authType || 'key');
    const keyPath = input({ value: c.keyPath || '', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' });
    const secret = h('input', { type: 'password', autocomplete: 'off', placeholder: c.hasSecret ? '(saved — leave blank to keep)' : '' });
    const keyField = field('Private key', h('div', { class: 'row' }, h('div', { class: 'spacer' }, keyPath), button('Browse…', async () => {
      const p = await api('conn:pickKey');
      if (p) keyPath.value = p;
    })));
    const secretLabel = h('label', null, '');
    const secretField = h('div', { class: 'field' }, secretLabel, secret, h('div', { class: 'hint' }, 'Stored encrypted with Windows data protection, readable only by your Windows account.'));
    const sync = () => {
      keyField.classList.toggle('hidden', auth.value !== 'key');
      secretField.classList.toggle('hidden', auth.value === 'agent');
      secretLabel.textContent = auth.value === 'password' ? 'Password' : 'Key passphrase (if the key has one)';
    };
    auth.addEventListener('change', sync);
    sync();

    const saveConn = () => {
      const patch = { host: host.value.trim(), port: port.value.trim() || 22, username: user.value.trim() || 'root', authType: auth.value, keyPath: keyPath.value.trim() };
      if (secret.value) patch.secret = secret.value;
      return api('settings:save', { connection: patch });
    };

    const email = input({ value: s.certEmail || '', placeholder: 'you@example.com' });
    const ghToken = h('input', { type: 'password', autocomplete: 'off', placeholder: s.github.hasToken ? '(saved — leave blank to keep)' : 'github_pat_…' });
    const vultrKey = h('input', { type: 'password', autocomplete: 'off', placeholder: s.vultr.hasKey ? '(saved — leave blank to keep)' : 'Vultr API key' });
    const aiKey = h('input', { type: 'password', autocomplete: 'off', placeholder: s.ai.hasKey ? '(saved — leave blank to keep)' : 'sk-ant-…' });
    const known = s.hostKeys[`${c.host}:${c.port || 22}`];

    // App behaviour on this PC: each box saves as soon as it's ticked.
    const flag = (key, label, hint) => {
      const box = h('input', { type: 'checkbox', id: `app-${key}`, checked: s.app[key] });
      box.addEventListener('change', () => {
        sync2();
        act(null, () => api('settings:save', { app: { [key]: box.checked } }), 'Saved');
      });
      return { box, el: h('div', { class: 'app-flag' }, h('label', { class: 'check', for: `app-${key}` }, box, label), h('div', { class: 'hint muted' }, hint)) };
    };
    const startWin = flag('startWithWindows', 'Start with Windows', 'Opens VPS Manager when you sign in to Windows.');
    const startHidden = flag('startHidden', 'Start minimised to the tray', 'When started by Windows, stay in the notification area instead of opening the window. Opening the app yourself always shows it.');
    const closeTray = flag('closeToTray', 'Closing the window keeps it running in the tray', 'The deploy count on the tray icon keeps updating. Use Quit in the tray icon’s menu to exit.');
    const sync2 = () => (startHidden.box.disabled = !startWin.box.checked);
    sync2();

    return [
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'section-head' }, h('h2', null, 'Server connection'), ctx.conn.connected ? badge(`Connected as ${ctx.conn.username}`, 'ok') : badge('Not connected')),
        h('div', { class: 'field-row' }, field('Server address', host, 'Your Vultr VPS IP or hostname.'), field('SSH port', port), field('User', user, 'root, or a user with passwordless sudo.')),
        field('Authentication', auth),
        keyField,
        secretField,
        h(
          'div',
          { class: 'row' },
          button(
            ctx.conn.connected ? 'Save & reconnect' : 'Save & connect',
            (b) =>
              act(b, async () => {
                await saveConn();
                await connect(ctx);
              }),
            'primary'
          ),
          ctx.conn.connected && button('Disconnect', () => api('conn:disconnect')),
          c.hasSecret && button('Forget saved passphrase/password', (b) => act(b, () => api('settings:save', { connection: { secret: '' } }), 'Removed').then(ctx.refresh), 'ghost'),
          known && button('Forget trusted host key', (b) => act(b, () => api('conn:forgetHostKey'), 'Host key forgotten').then(ctx.refresh), 'ghost')
        ),
        known && h('div', { class: 'hint muted mono section' }, `Trusted host key: ${known}`)
      ),
      h(
        'div',
        { class: 'card section' },
        h('div', { class: 'section-head' }, h('h2', null, "Let's Encrypt")),
        field('Email for certificates', email, "Used by certbot for expiry notices when you press “Get certificate” on a site."),
        button('Save', (b) => act(b, () => api('settings:save', { certEmail: email.value.trim() }), 'Saved'))
      ),
      h(
        'div',
        { class: 'card section' },
        h('div', { class: 'section-head' }, h('h2', null, 'GitHub'), s.github.hasToken ? badge('Token saved', 'ok') : badge('No token')),
        field(
          'GitHub token',
          ghToken,
          'Quickest: “Quick token” opens GitHub with a classic token already set up (the “repo” scope), so you only press Generate and paste it here. It can list all your repositories, private ones included, and add deploy keys and webhooks, but it has write access to every repo you own. For a tighter one use “Fine-grained token”, as described next.'
        ),
        field(
          'Fine-grained alternative',
          h('span'),
          'Lets “Add deploy key” and “Add webhook” on the Auto-deploy screen set up a repository for you. Create a fine-grained token, give it access to the repositories you deploy, and under Repository permissions set both Administration (for deploy keys) and Webhooks to “Read and write”. Stored encrypted with Windows data protection; sent only to api.github.com.'
        ),
        h(
          'div',
          { class: 'row' },
          button('Save token', (b) => act(b, () => (ghToken.value.trim() ? api('settings:save', { github: { token: ghToken.value.trim() } }) : Promise.reject(new Error('Paste a token first'))), 'GitHub token saved').then(ctx.refresh)),
          button('Quick token: all my repos ↗', () => api('open:external', 'https://github.com/settings/tokens/new?scopes=repo&description=VPS%20Manager'), 'primary'),
          button('Fine-grained token ↗', () => api('open:external', 'https://github.com/settings/personal-access-tokens/new')),
          s.github.hasToken && button('Remove saved token', (b) => act(b, () => api('settings:save', { github: { token: '' } }), 'Removed').then(ctx.refresh), 'ghost')
        )
      ),
      h(
        'div',
        { class: 'card section' },
        h('div', { class: 'section-head' }, h('h2', null, 'Vultr DNS'), s.vultr.hasKey ? badge('API key saved', 'ok') : s.vultr.fromEnv ? badge('Using VULTR_API_KEY', 'ok') : badge('No API key')),
        field(
          'Vultr API key',
          vultrKey,
          'Lets the DNS screen and “Point DNS here” manage the records of domains hosted on Vultr DNS. Create it in the Vultr portal under Account → API, and under Access Control there allow this PC’s public IP address, or Vultr rejects every request. The key can manage your whole Vultr account, not only DNS. Stored encrypted with Windows data protection; sent only to api.vultr.com.'
        ),
        h(
          'div',
          { class: 'row' },
          button('Save key', (b) => act(b, () => (vultrKey.value.trim() ? api('settings:save', { vultr: { key: vultrKey.value.trim() } }) : Promise.reject(new Error('Paste a key first'))), 'Vultr API key saved').then(ctx.refresh)),
          button('Vultr API settings ↗', () => api('open:external', 'https://my.vultr.com/settings/#settingsapi')),
          s.vultr.hasKey && button('Remove saved key', (b) => act(b, () => api('settings:save', { vultr: { key: '' } }), 'Removed').then(ctx.refresh), 'ghost')
        )
      ),
      h(
        'div',
        { class: 'card section' },
        h('div', { class: 'section-head' }, h('h2', null, 'AI assistant'), s.ai.hasKey ? badge('API key saved', 'ok') : badge('No API key')),
        field(
          'Anthropic API key',
          aiKey,
          'Used by the Assistant panel. Stored encrypted with Windows data protection. Create one at console.anthropic.com; usage is billed to that account. If left empty, the ANTHROPIC_API_KEY environment variable is used when set.'
        ),
        h(
          'div',
          { class: 'row' },
          button('Save key', (b) => act(b, () => (aiKey.value.trim() ? api('settings:save', { ai: { key: aiKey.value.trim() } }) : Promise.reject(new Error('Paste a key first'))), 'API key saved').then(ctx.refresh)),
          s.ai.hasKey && button('Remove saved key', (b) => act(b, () => api('settings:save', { ai: { key: '' } }), 'Removed').then(ctx.refresh), 'ghost')
        )
      ),
      h('div', { class: 'card section' }, h('div', { class: 'section-head' }, h('h2', null, 'Windows')), startWin.el, startHidden.el, closeTray.el),
    ];
  });
}
