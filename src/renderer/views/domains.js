import { h, api, act, button, badge, modal, field, input, select, pageHead, table, load, toast, showOutput } from '../ui.js';
import { launchModal } from './launch.js';
import { pointHere } from './dns.js';
import { projectModal } from './deploys.js';
import { hasDraft } from './site.js';

/** Set up auto-deploy for a site that has none: the server works out its folder, repo and command. */
async function autoDeploy(site, ctx) {
  const r = await api('deploy:detect', { name: site.name, kind: site.kind });
  if (!r.agentInstalled) {
    toast('Install the deploy agent first (Auto-deploy screen). Then come back and press “Auto-deploy” again.', 'error');
    return ctx.go('deploys');
  }
  projectModal(null, ctx, { prefill: r.project, notes: r.notes, title: `Auto-deploy ${site.name}` });
}

function certBadge(site) {
  const dates = Object.values(site.certExpiry || {}).filter(Boolean).map((d) => Date.parse(d)).filter((t) => !Number.isNaN(t));
  if (!site.summary.ssl) return badge('HTTP only');
  if (!dates.length) return badge('HTTPS', 'ok');
  const days = Math.floor((Math.min(...dates) - Date.now()) / 86400000);
  if (days < 0) return badge('Certificate expired', 'bad');
  return badge(`HTTPS · ${days}d left`, days < 21 ? 'warn' : 'ok');
}

/** The config editor is a page of its own (Sites › name). */
const editSite = (site, ctx) => ctx.go('site', false, { name: site.name, kind: site.kind });

// What each site type needs from the form. Port types forward to an app on a local port;
// folder types are served by nginx (or PHP-FPM) straight from a folder.
const SITE_TYPES = {
  nextjs: { label: 'Next.js app', port: 3000, hint: 'Run the app on this port, e.g. “next start -p PORT”, or in docker-compose: ports: "127.0.0.1:PORT:3000".' },
  laravel: { label: 'Laravel app on a port (Docker / Octane)', port: 8000, hint: 'Publish the app’s web port on this one, e.g. in docker-compose: ports: "127.0.0.1:PORT:80". Laravel should trust the proxy so it sees HTTPS.' },
  'laravel-fpm': { label: 'Laravel on PHP-FPM installed on this server', folder: '/opt/apps/myapp', hint: 'The Laravel app folder. nginx serves its public/ folder through the newest PHP-FPM found on the server.' },
  'app-websocket': {
    label: 'App + Node.js WebSocket server (two ports)',
    port: 3000,
    ws: true,
    hint: 'The port the app (website / API) listens on.',
    wsHint: 'The port your Node.js WebSocket server (ws, Socket.IO, …) listens on. Requests under the path below go there; everything else goes to the app.',
  },
  proxy: { label: 'Other app on a local port (Docker / Node / etc.)', port: 3000, hint: 'The port your container or app listens on.' },
  static: { label: 'Static files from a folder', folder: '/var/www/example.com', hint: 'The folder nginx serves files from.' },
};

function newSite(ctx) {
  const domains = input({ placeholder: 'example.com www.example.com' });
  const name = input({ placeholder: 'example.com' });
  const type = select(Object.entries(SITE_TYPES).map(([id, t]) => [id, t.label]), 'nextjs');
  const port = input({ placeholder: '3000' });
  const wsPort = input({ placeholder: '3001' });
  const wsPath = input({ placeholder: '/ws', value: '/ws' });
  const wsPortHint = h('div', { class: 'hint' });
  const appFolder = input({ placeholder: '/opt/apps/myapp' });
  const wsFolder = input({ placeholder: '/opt/apps/myapp-ws' });
  const appFolderField = field('App folder', appFolder, 'Where the app runs from on the server. Optional: nginx only needs the port, but it is saved in the config and used when setting up auto-deploy.');
  const rootDir = input({});
  const portHint = h('div', { class: 'hint' });
  const rootHint = h('div', { class: 'hint' });
  const portLabel = h('label', null, 'Local port');
  const portField = h('div', { class: 'field' }, portLabel, port, portHint);
  const rootField = h('div', { class: 'field' }, h('label', null, 'Folder'), rootDir, rootHint);
  const wsFields = h(
    'div',
    null,
    h('div', { class: 'field' }, h('label', null, 'WebSocket server port (Node.js)'), wsPort, wsPortHint),
    field('WebSocket server folder', wsFolder, 'Where the Node.js WebSocket server runs from on the server. Optional, saved in the config like the app folder.'),
    field('WebSocket path', wsPath, 'Browsers connect to wss://your-domain + this path, e.g. /ws, or /socket.io/ for Socket.IO.')
  );
  let wsPortTouched = false;
  wsPort.addEventListener('input', () => (wsPortTouched = true));
  const https = h('input', { type: 'checkbox', id: 'site-https' });
  let nameTouched = false;
  let portTouched = false;
  let lookup = 0;
  name.addEventListener('input', () => (nameTouched = true));
  port.addEventListener('input', () => (portTouched = true));
  domains.addEventListener('input', () => {
    if (!nameTouched) name.value = domains.value.trim().split(/[\s,]+/)[0] || '';
  });

  // Show the fields this type needs and, for port types, fill in the next free port on the server.
  async function sync() {
    const t = SITE_TYPES[type.value];
    portField.classList.toggle('hidden', !t.port);
    rootField.classList.toggle('hidden', !t.folder);
    wsFields.classList.toggle('hidden', !t.ws);
    appFolderField.classList.toggle('hidden', !t.ws);
    portLabel.textContent = t.ws ? 'App port' : 'Local port';
    if (t.ws) syncWsPort();
    rootDir.placeholder = t.folder || '';
    rootHint.textContent = t.folder ? t.hint : '';
    if (!t.port) return;
    port.placeholder = String(t.port);
    portHint.textContent = t.hint;
    if (portTouched) return;
    const mine = ++lookup;
    port.value = '';
    portHint.textContent = 'Finding the next free port on the server…';
    try {
      const r = await api('nginx:nextPort', { from: t.port });
      if (mine !== lookup || portTouched) return;
      const waiting = r.waiting || [];
      if (waiting.length) {
        const [w, ...rest] = waiting;
        port.value = String(w.port);
        if (t.ws) syncWsPort();
        portHint.textContent = `${w.port} is the port of the deploy project “${w.name}”, which has no site yet.${rest.length ? ` Also waiting: ${rest.map((x) => `${x.name} on ${x.port}`).join(', ')}.` : ''} For an unrelated app use ${r.port}, the next free port. ${t.hint}`;
        return;
      }
      port.value = String(r.port);
      if (t.ws) syncWsPort();
      portHint.textContent = `${r.port} is the next free port${r.inUse.length ? ` (${r.inUse.join(', ')} ${r.inUse.length === 1 ? 'is' : 'are'} taken)` : ''}. ${t.hint}`;
    } catch (e) {
      if (mine === lookup) portHint.textContent = `Could not check which ports are free (${e.message}). ${t.hint}`;
    }
  }
  // The WebSocket server's port: the next free one that is not the app's port.
  let wsLookup = 0;
  async function syncWsPort() {
    const t = SITE_TYPES[type.value];
    wsPortHint.textContent = t.wsHint;
    if (wsPortTouched) return;
    const mine = ++wsLookup;
    const appPort = Number(port.value) || t.port;
    try {
      let r = await api('nginx:nextPort', { from: appPort + 1 });
      if (mine !== wsLookup || wsPortTouched) return;
      if (r.port === Number(port.value)) r = await api('nginx:nextPort', { from: r.port + 1 });
      if (mine !== wsLookup || wsPortTouched) return;
      wsPort.value = String(r.port);
      wsPortHint.textContent = `${r.port} is the next free port after the app’s. ${t.wsHint}`;
    } catch (e) {
      if (mine === wsLookup) wsPortHint.textContent = `Could not check which ports are free (${e.message}). ${t.wsHint}`;
    }
  }
  port.addEventListener('change', () => SITE_TYPES[type.value].ws && syncWsPort());
  type.addEventListener('change', sync);
  sync();

  modal({
    title: 'New site',
    body: [
      field('Domains', domains, 'Space-separated. Point their DNS A records at this server first.'),
      field('Config file name', name),
      field('Type', type),
      portField,
      appFolderField,
      wsFields,
      rootField,
      h('div', { class: 'check' }, https, h('label', { for: 'site-https' }, 'Get an HTTPS certificate straight away (certbot; the domains must already point at this server)')),
    ],
    actions: (close) => [
      button('Cancel', close),
      button(
        'Create & enable',
        async (btn) => {
          const t = SITE_TYPES[type.value];
          const r = await act(btn, async () => {
            const created = await api('nginx:create', {
              name: name.value.trim(),
              type: type.value,
              domains: domains.value.trim(),
              // Left blank, the server picks the next free port itself.
              upstreamPort: t.port && port.value.trim() ? Math.trunc(Number(port.value)) || 0 : undefined,
              root: t.folder ? rootDir.value.trim() : undefined,
              wsPort: t.ws && wsPort.value.trim() ? Math.trunc(Number(wsPort.value)) || 0 : undefined,
              wsPath: t.ws ? wsPath.value.trim() || '/ws' : undefined,
              appFolder: t.ws ? appFolder.value.trim() || undefined : undefined,
              wsFolder: t.ws ? wsFolder.value.trim() || undefined : undefined,
              https: https.checked || undefined,
            });
            return created || {};
          });
          if (!r) return;
          close();
          const where = r.wsPort
            ? ` It forwards to the app on port ${r.upstreamPort} and ${r.wsPath} to the WebSocket server on port ${r.wsPort}: make each listen there.`
            : r.upstreamPort
              ? ` It forwards to port ${r.upstreamPort}: make the app listen there.`
              : '';
          if (https.checked) toast(r.https ? `Site created with HTTPS.${where}` : `Site created over HTTP, but the certificate request failed (see the output below).${where}`, r.https ? 'ok' : 'error');
          else toast(`Site created.${where} Use “Get certificate” to add HTTPS.`, 'ok');
          ctx.refresh();
        },
        'primary'
      ),
    ],
  });
}

async function getCert(site, ctx) {
  const names = site.summary.domains.filter((d) => !d.startsWith('*.'));
  if (!names.length) return toast('This site has no domain names to certify.', 'error');
  const s = await api('settings:get');
  if (!s.certEmail) {
    toast("Set your Let's Encrypt email in Settings first.", 'error');
    return ctx.go('settings');
  }
  const r = await api('nginx:certbot', { domains: names });
  if (r.code === 0) toast('Certificate installed', 'ok');
  ctx.refresh();
}

export function render(root, ctx) {
  root.append(
    pageHead(
      'Sites',
      button('Test config', (b) =>
        act(b, async () => {
          const r = await api('nginx:test');
          showOutput(r.ok ? 'nginx -t: OK' : 'nginx -t: FAILED', r.output);
        })
      ),
      button('Reload nginx', (b) => act(b, () => api('nginx:reload'), 'nginx reloaded')),
      button('Refresh', ctx.refresh),
      button('Launch from GitHub', (b) => act(b, () => launchModal(ctx))),
      button('New site', () => newSite(ctx), 'primary')
    )
  );
  load(root, async () => {
    const [data, sys, settings, dep] = await Promise.all([api('nginx:list'), api('system:info').catch(() => ({ ips: [] })), api('settings:get'), api('deploy:status').catch(() => null)]);
    // The deploy project behind a site: the one whose port the site forwards to, or whose folder it serves.
    const projects = (dep && dep.installed && dep.config && dep.config.projects) || [];
    const projectOf = (site) =>
      projects.find((p) => site.summary.targets.some((t) => (p.app_port != null && new RegExp(`:${p.app_port}(\\D|$)`).test(t)) || t === p.path || t.startsWith(`${p.path}/`)));
    if (!data.installed) return h('div', { class: 'info-box' }, 'nginx is not installed on this server (no /etc/nginx).');

    const dnsCells = new Map();
    const rows = data.sites.map((site) => {
      const sm = site.summary;
      const project = projectOf(site);
      const hooked = !!project && !!project.webhook_url && project.webhook_url === dep.webhookUrl;
      const needsHook = !!project && project.auto !== false && !hooked;
      const run = (label, channel, payload, okMsg, cls) =>
        button(label, (b) => act(b, () => api(channel, payload), okMsg).then(ctx.refresh), `small ${cls || ''}`);
      return h(
        'tr',
        null,
        h(
          'td',
          null,
          h('button', { class: 'link', type: 'button', title: 'Open the config editor', onclick: () => editSite(site, ctx) }, site.name),
          h('div', { class: 'muted mono' }, site.kind === 'conf.d' ? 'conf.d' : 'sites-available'),
          hasDraft(site.name, site.kind) && badge('Unsaved edits', 'warn')
        ),
        h(
          'td',
          null,
          sm.domains.length
            ? sm.domains.map((d) => {
                const slot = h('span', { class: 'dot', title: 'Checking DNS…' });
                if (!dnsCells.has(d)) dnsCells.set(d, []);
                dnsCells.get(d).push(slot);
                return h('div', { class: 'domain' }, slot, d);
              })
            : h('span', { class: 'muted' }, '(default / no server_name)')
        ),
        h(
          'td',
          { class: 'mono' },
          sm.targets.length ? sm.targets.map((t) => h('div', null, t)) : h('span', { class: 'muted' }, '—'),
          sm.folders && sm.folders.app && h('div', { class: 'muted' }, `app in ${sm.folders.app}`),
          sm.folders && sm.folders.ws && h('div', { class: 'muted' }, `ws in ${sm.folders.ws}`)
        ),
        h('td', null, certBadge(site)),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'row' },
            site.enabled ? badge('Enabled', 'ok') : badge('Disabled'),
            hooked && h('span', { title: `Pushes to ${project.repo} (branch ${project.branch}) deploy the project “${project.name}”` }, badge('Deploys on push', 'ok')),
            needsHook && h('span', { title: `The deploy project “${project.name}” has no webhook on ${project.repo}, so pushes do not deploy it yet` }, badge('No webhook', 'warn'))
          )
        ),
        h(
          'td',
          { class: 'actions' },
          button('Edit', () => editSite(site, ctx), 'small'),
          button('Traffic', () => ctx.go('traffic', false, { name: site.name, kind: site.kind }), 'small'),
          (settings.vultr.hasKey || settings.vultr.fromEnv) && sm.domains.length > 0 && button('Point DNS here', (b) => act(b, () => pointHere(sm.domains, ctx)), 'small'),
          !project &&
            site.name !== 'deploy-agent' &&
            button('Auto-deploy', (b) => act(b, () => autoDeploy(site, ctx)), 'small'),
          needsHook &&
            button(
              'Add webhook',
              async (b) => {
                const r = await act(b, () => api('deploy:webhook', { name: project.name }));
                if (r) toast(`Webhook ${r.updated ? 'updated' : 'added'} on ${project.repo}: pushes now deploy ${site.name}`, 'ok');
                ctx.refresh();
              },
              'small primary'
            ),
          button('Get certificate', (b) => act(b, () => getCert(site, ctx)), 'small'),
          site.kind === 'site' && (site.enabled ? run('Disable', 'nginx:disable', { name: site.name }, 'Site disabled') : run('Enable', 'nginx:enable', { name: site.name }, 'Site enabled')),
          button(
            'Delete',
            async (b) => {
              await act(b, () => api('nginx:delete', { name: site.name, kind: site.kind }), 'Site deleted');
              ctx.refresh();
            },
            'small danger'
          )
        )
      );
    });

    // DNS lookups happen from this PC, after the table is on screen.
    api('dns:check', { domains: [...dnsCells.keys()], ips: sys.ips })
      .then((res) => {
        for (const [d, slots] of dnsCells) {
          const r = res[d] || { status: 'none', addrs: [] };
          const [cls, tip] = {
            ok: ['ok', `DNS points at this server (${r.addrs.join(', ')})`],
            elsewhere: ['run', `DNS points elsewhere: ${r.addrs.join(', ')} (a proxy such as Cloudflare, or not this server)`],
            none: ['bad', 'No DNS record found'],
            wildcard: ['', 'Wildcard name — not checked'],
          }[r.status];
          for (const s of slots) {
            s.className = `dot ${cls}`;
            s.title = tip;
          }
        }
      })
      .catch(() => {});

    return [
      table(['Config', 'Domains', 'Serves', 'TLS', 'Status', ''], rows, 'No nginx sites found.', { fit: true }),
      h('div', { class: 'hint muted section' }, 'Dot next to a domain: green = DNS points at this server, amber = points elsewhere (e.g. behind a proxy), red = no DNS record. Hover for details.'),
    ];
  });
}
