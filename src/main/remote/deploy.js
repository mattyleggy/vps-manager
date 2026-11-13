'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { q, planning } = require('../ssh');
const { check, port } = require('../validate');

const DIR = '/opt/deploy-agent';
const SCRIPT = `${DIR}/deploy-agent.py`;
const CONFIG = '/etc/deploy-agent/config.json';
const UNIT = '/etc/systemd/system/deploy-agent.service';
const LOGS = '/var/log/deploy-agent';
const NGINX_SITE = 'deploy-agent';
const SERVER_KEY = '/root/.ssh/github_deploy_ed25519';

const agentFile = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'agent', name), 'utf8');
const localVersion = () => (/^VERSION = "([^"]+)"/m.exec(agentFile('deploy-agent.py')) || [])[1];

const STATUS_SCRIPT = String.raw`
import json, os, re, subprocess

def sh(c):
    try:
        return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return ''

out = {'installed': os.path.isfile('${SCRIPT}'), 'version': None, 'active': sh('systemctl is-active deploy-agent'),
       'config': None, 'history': [], 'serverKey': None, 'repoKeys': {}, 'https': False, 'python': sh('python3 --version')}
try:
    out['serverKey'] = open('${SERVER_KEY}.pub').read().strip()
except Exception:
    pass
if out['installed']:
    m = re.search(r'^VERSION = "([^"]+)"', open('${SCRIPT}').read(), re.M)
    out['version'] = m.group(1) if m else None
try:
    out['config'] = json.load(open('${CONFIG}'))
except Exception:
    pass
try:
    lines = open('${LOGS}/history.jsonl').read().splitlines()[-40:]
    out['history'] = [json.loads(l) for l in lines if l.strip()][::-1]
except Exception:
    pass
for p in (out['config'] or {}).get('projects', []):
    k = p.get('ssh_key')
    if k and os.path.isfile(k + '.pub'):
        out['repoKeys'][p['name']] = open(k + '.pub').read().strip()
    p['cloned'] = os.path.isdir(os.path.join(p.get('path', '/nonexistent'), '.git'))
    p['env'] = None
    if p['cloned']:
        envp = os.path.join(p['path'], '.env')
        e = {'exists': os.path.isfile(envp), 'example': os.path.isfile(envp + '.example'), 'port': None}
        try:
            m = re.search(r'^[ \\t]*(?:export[ \\t]+)?APP_PORT[ \\t]*=[ \\t"]*([0-9]+)', open(envp, errors='replace').read(), re.M)
            e['port'] = int(m.group(1)) if m else None
        except Exception:
            pass
        p['env'] = e
try:
    out['https'] = 'ssl_certificate' in open('/etc/nginx/sites-available/${NGINX_SITE}').read()
except Exception:
    pass
print(json.dumps(out))
`;

const nginxSite = (host, p) => `# Managed by VPS Manager: public endpoint for GitHub webhooks.
server {
    listen 80;
    listen [::]:80;
    server_name ${host};

    location /hooks/ {
        proxy_pass http://127.0.0.1:${p};
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        client_max_body_size 5m;
    }

    location / {
        return 404;
    }
}
`;

function cleanProject(input) {
  const p = {
    name: check('projectName', input.name),
    repo: check('repo', input.repo),
    branch: check('branch', input.branch || 'master'),
    path: check('absPath', input.path).replace(/\/+$/, ''),
    command: String(input.command || '').replace(/\r\n/g, '\n').trim(),
    auto: input.auto !== false,
  };
  if (p.path.split('/').filter(Boolean).length < 2) throw new Error('Deploy path must be at least two levels deep, e.g. /opt/apps/myapp');
  if (input.ssh_key) p.ssh_key = check('absPath', input.ssh_key);
  // Who owns the checkout (user or user:group). Omitted: the agent's default, matt:matt.
  if (input.owner) p.owner = check('owner', input.owner);
  // The port the site forwards to; on the first clone the agent writes it to .env as APP_PORT.
  if (input.app_port != null) p.app_port = port(input.app_port);
  return p;
}

const reservedPorts = (projects) => projects.map((x) => x.app_port).filter((n) => n != null);

module.exports = (ssh, nginx, github) => {
  async function readConfig() {
    const r = await ssh.exec(`cat ${q(CONFIG)}`, { sudo: true, read: true });
    if (r.code !== 0) throw new Error('The deploy agent is not installed yet');
    return JSON.parse(r.stdout);
  }
  const writeConfig = (cfg, what) =>
    ssh.writeFile(CONFIG, JSON.stringify(cfg, null, 2) + '\n', { mode: '600', what: what || `Write the agent config ${CONFIG} (root-only; contains the webhook secret)` });

  /**
   * Make sure the project has its own key pair on the server and that the public half is a
   * read-only deploy key on its GitHub repo. Safe to repeat: a key already on the repo is left alone.
   */
  async function ensureRepoKey(name, repo) {
    const key = `/root/.ssh/deploy_${name}_ed25519`;

    // Reads first: what exists on the server, and what GitHub already has. A bad token or a
    // repo it cannot manage fails here, before anything is shown for approval.
    const existing = await ssh.exec(`cat ${q(key + '.pub')} 2>/dev/null`, { sudo: true, read: true });
    let pub = existing.code === 0 ? existing.stdout.trim() : '';
    const onGitHub = await github.listDeployKeys(repo);
    const present = !!pub && onGitHub.some((k) => github.keyBody(k.key) === github.keyBody(pub));
    if (!pub) {
      const out = await ssh.run(
        `set -e
mkdir -p /root/.ssh && chmod 700 /root/.ssh
ssh-keygen -q -t ed25519 -N '' -C ${q('deploy-' + name)} -f ${q(key)}
cat ${q(key + '.pub')}`,
        { sudo: true, what: `Generate an SSH key pair for ${name} on the server (the private half never leaves it)` }
      );
      pub = (out || '').trim();
    }
    if (!present) {
      const title = `vps-manager: ${name} @ ${ssh.info.host}`;
      await ssh.external(
        {
          what: `Add the public key to ${repo} on GitHub as a read-only deploy key`,
          via: 'GitHub API',
          display: `POST https://api.github.com/repos/${repo}/keys
{
  "title": ${JSON.stringify(title)},
  "key": "<public key from ${key}.pub>",
  "read_only": true
}`,
        },
        () => github.addDeployKey(repo, title, pub)
      );
    }
    return { key, pub, present };
  }

  /**
   * Make sure `repo` has a push webhook for `url` carrying the agent's secret: created, or - if
   * one for this URL exists - updated in place, which re-sends the secret. The secret goes to
   * GitHub only; it is never shown in the review. Returns the existing hook, if there was one.
   */
  async function ensureWebhook(repo, url, secret) {
    // Read first, so a token problem surfaces before anything is shown for approval.
    const existing = (await github.listHooks(repo)).find((h) => h.config && h.config.url === url);
    const hook = (sec) => ({ active: true, events: ['push'], config: { url, content_type: 'json', secret: sec, insecure_ssl: '0' } });
    const shown = JSON.stringify(existing ? hook('<webhook secret from the agent config>') : { name: 'web', ...hook('<webhook secret from the agent config>') }, null, 2);
    await ssh.external(
      {
        what: existing ? `Update the existing webhook on ${repo} (re-sends the current secret)` : `Create a webhook on ${repo} that calls this server on every push`,
        via: 'GitHub API',
        display: `${existing ? 'PATCH' : 'POST'} https://api.github.com/repos/${repo}/hooks${existing ? `/${existing.id}` : ''}\n${shown}`,
      },
      () => (existing ? github.updateHook(repo, existing.id, hook(secret)) : github.createHook(repo, hook(secret)))
    );
    return existing;
  }

  /**
   * The deploy key part of saving a project. deployKey: true = required, false = never, omitted =
   * for a new project with no key when a GitHub token is saved (and then a token that cannot
   * manage the repo's keys does not block the save). Sets p.ssh_key when a key is in place.
   * Resolves { status: added|kept|existing|skipped|no-token|off, reason? }.
   */
  async function projectKey(p, before, deployKey) {
    if (before && before.ssh_key && !p.ssh_key) p.ssh_key = before.ssh_key;
    const hasToken = typeof github.hasToken === 'function' && github.hasToken();
    const isNew = !before;
    if (deployKey === false) return { status: p.ssh_key ? 'existing' : 'off' };
    if (deployKey === undefined && (!isNew || p.ssh_key)) return { status: p.ssh_key ? 'existing' : 'off' };
    if (!hasToken) {
      if (deployKey === true) throw new Error('Adding a deploy key needs a GitHub token. Save one in Settings → GitHub, or turn the deploy key off.');
      return { status: 'no-token' };
    }
    if (deployKey === undefined) {
      // Asked for by default rather than by the user: a token problem is reported, not fatal.
      let problem = null;
      await github.listDeployKeys(p.repo).catch((e) => (problem = e.message));
      if (problem) return { status: 'skipped', reason: problem };
    }
    const { key, present } = await ensureRepoKey(p.name, p.repo);
    p.ssh_key = key;
    return { status: present ? 'kept' : 'added' };
  }

  /**
   * A deploy key is only used over SSH. If the project's folder is already a checkout that pulls
   * this repo over HTTPS, point its origin at the SSH address (a reviewed step). Resolves the old
   * URL when it was switched, else null.
   */
  async function sshRemote(p) {
    const git = `git -c safe.directory='*' -C ${q(p.path)}`;
    const r = await ssh.exec(`[ -e ${q(p.path + '/.git')} ] && ${git} config --get remote.origin.url`, { sudo: true, read: true });
    const url = r.code === 0 ? r.stdout.trim() : '';
    const m = /^https?:\/\/(?:[^@/]+@)?(?:www\.)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url);
    if (!m || m[1].toLowerCase() !== p.repo.toLowerCase()) return null;
    const to = `git@github.com:${p.repo}.git`;
    await ssh.run(`${git} remote set-url origin ${q(to)}`, {
      sudo: true,
      what: `Make the checkout in ${p.path} pull over SSH (origin ${url.replace(/\/\/[^@/]+@/, '//')} → ${to}), so it uses the deploy key`,
    });
    return url.replace(/\/\/[^@/]+@/, '//');
  }

  const api = {
    localVersion,

    async status() {
      const s = await ssh.python(STATUS_SCRIPT, { sudo: true });
      s.localVersion = localVersion();
      if (s.config) {
        const c = s.config;
        s.webhookUrl = c.public_host
          ? `${s.https ? 'https' : 'http'}://${c.public_host}/hooks/github`
          : `http://${ssh.info.host}:${c.port}/hooks/github`;
      }
      return s;
    },

    /** Install or update the agent. opts: { hostname?, port }. Keeps the existing secret and projects. */
    async install(opts, log = () => {}) {
      const p = port(opts.port || 9321);
      const host = opts.hostname ? check('domain', opts.hostname) : '';
      let cfg;
      try {
        cfg = await readConfig();
      } catch {
        cfg = { secret: ssh.memo('secret', () => crypto.randomBytes(32).toString('hex')), projects: [] };
      }
      cfg.port = p;
      cfg.listen = host ? '127.0.0.1' : '0.0.0.0';
      cfg.public_host = host;

      log('Checking python3...\n');
      await ssh.run('command -v python3 >/dev/null || { echo "python3 is not installed on the server" >&2; exit 1; }', { read: true });
      log('Uploading agent...\n');
      await ssh.run(`mkdir -p ${DIR} /etc/deploy-agent ${LOGS} && chmod 700 /etc/deploy-agent`, { sudo: true, what: 'Create the agent folders' });
      await ssh.writeFile(SCRIPT, agentFile('deploy-agent.py').replace(/\r\n/g, '\n'), { mode: '755', what: `Upload the agent program to ${SCRIPT}` });
      await ssh.writeFile(UNIT, agentFile('deploy-agent.service').replace(/\r\n/g, '\n'), { what: `Write the systemd unit ${UNIT}` });
      await writeConfig(cfg);
      log('Setting up the server SSH key for GitHub...\n');
      await api.serverKey();
      log('Starting service...\n');
      await ssh.run('systemctl daemon-reload && systemctl enable deploy-agent >/dev/null 2>&1 && systemctl restart deploy-agent', {
        sudo: true,
        what: 'Register the deploy-agent service, start it now and on every boot',
      });

      if (host) {
        // Don't clobber the site if it already points at the right place (certbot may have added TLS to it).
        const cur = await ssh.exec(`cat /etc/nginx/sites-available/${NGINX_SITE}`, { sudo: true, read: true });
        const fine = cur.code === 0 && cur.stdout.includes(`server_name ${host};`) && cur.stdout.includes(`127.0.0.1:${p};`);
        if (!fine) {
          log(`Creating nginx site for ${host}...\n`);
          await nginx.save({ name: NGINX_SITE, kind: 'site', content: nginxSite(host, p) });
        }
        await nginx.enable(NGINX_SITE);
      } else {
        log(`Opening port ${p} in ufw (if ufw is active)...\n`);
        await ssh.run(`if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow ${p}/tcp; fi`, {
          sudo: true,
          what: `Open port ${p} to the internet in the ufw firewall (only if ufw is active)`,
        });
        await ssh.exec(`[ -e /etc/nginx/sites-available/${NGINX_SITE} ] && rm -f /etc/nginx/sites-enabled/${NGINX_SITE} && nginx -t && systemctl reload nginx`, {
          sudo: true,
          what: 'Disable the agent\'s nginx site if one exists (not needed without a hostname)',
        });
      }

      if (planning()) return; // the health check below only makes sense after the real run
      await new Promise((r) => setTimeout(r, 1200));
      const health = await ssh.exec(`curl -fsS --max-time 5 http://127.0.0.1:${p}/hooks/health`, { read: true });
      if (health.code !== 0) {
        const j = await ssh.exec('journalctl -u deploy-agent -n 15 --no-pager', { sudo: true, read: true });
        throw new Error(`Agent was installed but is not answering on port ${p}:\n${j.stdout.trim()}`);
      }
      log('Agent is running.\n');
    },

    /**
     * Add or update a project. With automatic deploys on, the push webhook is set up in the same
     * reviewed step. webhook: true = required, false = never, omitted = when a GitHub token is
     * saved (and then a token that cannot manage the repo's webhooks does not block the save).
     * Resolves { name, app_port, webhook: { status: created|updated|kept|skipped|no-token|off, reason? } }.
     */
    async saveProject({ project, originalName, webhook, deployKey }) {
      const cfg = await readConfig();
      const p = cleanProject(project);
      const list = cfg.projects || (cfg.projects = []);
      const idx = list.findIndex((x) => x.name === (originalName || p.name));
      if (list.some((x, i) => x.name === p.name && i !== idx)) throw new Error(`A project named "${p.name}" already exists`);
      const keyResult = await projectKey(p, idx >= 0 ? list[idx] : null, deployKey);
      // A new project always gets a port of its own, so its first clone can write APP_PORT to .env.
      if (idx < 0 && p.app_port == null) p.app_port = (await nginx.nextPort(3000, { reserved: reservedPorts(list) })).port;
      if (idx >= 0) {
        if (!p.ssh_key && list[idx].ssh_key) p.ssh_key = list[idx].ssh_key;
        if (p.app_port == null && list[idx].app_port != null) p.app_port = list[idx].app_port;
        // The "webhook exists" marker belongs to the repo: keep it only while the repo is the same.
        if (list[idx].webhook_url && list[idx].repo === p.repo) p.webhook_url = list[idx].webhook_url;
        list[idx] = p;
      } else {
        list.push(p);
      }

      const hasToken = typeof github.hasToken === 'function' && github.hasToken();
      let hook = { status: p.auto && webhook !== false && !hasToken ? 'no-token' : 'off' };
      if (webhook === true && !p.auto) throw new Error('A webhook only makes sense with automatic deploys. Turn automatic deploys on, or the webhook off.');
      if (p.auto && (webhook === true || (webhook === undefined && hasToken))) {
        const url = (await api.status()).webhookUrl;
        if (p.webhook_url === url) {
          hook = { status: 'kept' };
        } else {
          // Asked for by default rather than by the user: a token problem is reported, not fatal.
          let problem = null;
          if (webhook === undefined) await github.listHooks(p.repo).catch((e) => (problem = e.message));
          if (problem) {
            hook = { status: 'skipped', reason: problem };
          } else {
            const existing = await ensureWebhook(p.repo, url, cfg.secret);
            p.webhook_url = url;
            hook = { status: existing ? 'updated' : 'created' };
          }
        }
      }
      await writeConfig(cfg);
      // Only when this save put the key in place: editing a project never rewrites its remote unasked.
      const remote = ['added', 'kept'].includes(keyResult.status) ? await sshRemote(p) : null;
      return { name: p.name, app_port: p.app_port, webhook: hook, deployKey: keyResult, remote };
    },

    /** Removes the project from the agent config only. Files on the server are left alone. */
    async deleteProject(name) {
      const cfg = await readConfig();
      cfg.projects = (cfg.projects || []).filter((x) => x.name !== name);
      await writeConfig(cfg);
    },

    /**
     * Create (once) the server's GitHub key and make root's ssh use it for github.com,
     * so deploy commands can simply "git pull". Returns the public key.
     */
    async serverKey() {
      const pub = await ssh.run(
        `set -e
k=${SERVER_KEY}
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$k" ] || ssh-keygen -q -t ed25519 -N '' -C "deploy@$(hostname)" -f "$k"
if ! grep -qs 'vps-manager: github deploy key' /root/.ssh/config; then
  printf '\\n# vps-manager: github deploy key\\nHost github.com\\n    IdentityFile %s\\n    IdentitiesOnly yes\\n    StrictHostKeyChecking accept-new\\n' "$k" >> /root/.ssh/config
  chmod 600 /root/.ssh/config
fi
cat "$k.pub"`,
        { sudo: true, what: `Create the server's GitHub key ${SERVER_KEY} if it does not exist, and make root's SSH use it for github.com` }
      );
      return pub.trim();
    },

    /**
     * Give one project its own read-only deploy key: generate a key pair on the server (once),
     * add the public half to the project's GitHub repo through the GitHub API, and point the
     * project at it. Safe to repeat: a key that is already on the repo is left alone.
     */
    async repoKey(name) {
      check('projectName', name);
      const cfg = await readConfig();
      const p = (cfg.projects || []).find((x) => x.name === name);
      if (!p) throw new Error(`Project "${name}" not found`);
      const { key, pub, present } = await ensureRepoKey(name, p.repo);
      if (p.ssh_key !== key) {
        p.ssh_key = key;
        await writeConfig(cfg, `Make ${name} pull with this key (updates ${CONFIG})`);
      }
      const remote = await sshRemote(p);
      return { repo: p.repo, publicKey: pub, alreadyOnGitHub: present, remote };
    },

    /**
     * First half of "launch": add (or update) a deploy project and, with deployKey, give it its
     * own read-only GitHub key - with a single config write, so the plan shown for review is
     * exactly what the real run does. Returns the saved project.
     */
    async addProject({ project, deployKey, webhook }) {
      // The webhook needs the agent's public URL, which depends on live state (its nginx site, TLS).
      const s = webhook ? await api.status() : null;
      const cfg = await readConfig();
      const p = cleanProject(project);
      const list = cfg.projects || (cfg.projects = []);
      const idx = list.findIndex((x) => x.name === p.name);
      if (idx >= 0 && String(list[idx].repo).toLowerCase() !== p.repo.toLowerCase()) {
        throw new Error(`A deploy project named "${p.name}" already exists for ${list[idx].repo}. Choose another project name.`);
      }
      if (idx >= 0 && list[idx].ssh_key) p.ssh_key = list[idx].ssh_key;
      if (idx >= 0 && p.app_port == null && list[idx].app_port != null) p.app_port = list[idx].app_port;
      if (idx >= 0 && list[idx].webhook_url) p.webhook_url = list[idx].webhook_url;
      if (deployKey) p.ssh_key = (await ensureRepoKey(p.name, p.repo)).key;
      if (webhook) {
        await ensureWebhook(p.repo, s.webhookUrl, cfg.secret);
        p.webhook_url = s.webhookUrl;
      }
      if (idx >= 0) list[idx] = p;
      else list.push(p);
      await writeConfig(cfg, `${idx >= 0 ? 'Update' : 'Add'} the deploy project ${p.name} in the agent config ${CONFIG}`);
      return p;
    },

    /**
     * Create the GitHub webhook that makes pushes to a project's repo call this server's agent.
     * If the repo already has a webhook for this URL it is updated in place instead, which
     * re-sends the current secret (useful after rotating it). The secret goes to GitHub only;
     * it is never shown in the review dialog or returned.
     */
    async repoWebhook(name) {
      check('projectName', name);
      const s = await api.status();
      if (!s.installed || !s.config) throw new Error('Install the deploy agent first: the webhook needs its URL and secret');
      const p = (s.config.projects || []).find((x) => x.name === name);
      if (!p) throw new Error(`Project "${name}" not found`);
      const url = s.webhookUrl;

      const existing = await ensureWebhook(p.repo, url, s.config.secret);

      const cfg = await readConfig();
      const cp = (cfg.projects || []).find((x) => x.name === name);
      if (cp && cp.webhook_url !== url) {
        cp.webhook_url = url;
        await writeConfig(cfg, `Record that ${name} has its webhook (updates ${CONFIG})`);
      }
      return { repo: p.repo, url, updated: !!existing, insecure: url.startsWith('http://') };
    },

    /** Ask GitHub, from the server, whether the key is accepted (for an account key it names the account). */
    async testKey() {
      const r = await ssh.exec('ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com 2>&1', { sudo: true, read: true });
      return r.stdout.trim();
    },

    async rotateSecret() {
      const cfg = await readConfig();
      cfg.secret = ssh.memo('secret', () => crypto.randomBytes(32).toString('hex'));
      await writeConfig(cfg);
      return cfg.secret;
    },

    /** What "Deploy now" will make the agent run, for the review dialog. */
    async describeRun(name) {
      const p = ((await readConfig()).projects || []).find((x) => x.name === name);
      if (!p) throw new Error(`Project "${name}" not found`);
      const cmd = p.command || `git pull --ff-only origin ${p.branch || 'master'} && docker compose up -d --build --remove-orphans`;
      return `The agent will run this as root in ${p.path}:\n\n${cmd}\n\nIf ${p.path} has no git checkout yet, it first clones ${p.repo} (branch ${p.branch || 'master'}) into it and, unless the repository has its own .env, creates .env from .env.example${p.app_port ? ` with APP_PORT=${p.app_port}` : ''}.\n\nWhat it writes (the clone, .env, files a git pull changes) is then handed to ${p.owner || 'matt:matt'} instead of staying owned by root.`;
    },

    /** Ports saved on deploy projects: [{ name, port }]. Empty when the agent is not installed. */
    async projectPorts() {
      const cfg = await readConfig().catch(() => null);
      return ((cfg && cfg.projects) || []).filter((p) => p.app_port != null).map((p) => ({ name: p.name, port: p.app_port }));
    },

    /**
     * Set up .env in a project that is already cloned: created from .env.example if missing, with
     * APP_PORT set to the project's port. The port is, in order: the one given, the one saved on the
     * project, the APP_PORT already in .env if an nginx site forwards to it (so a working app keeps
     * its port), else the next free port. A newly chosen port is saved on the project.
     */
    async setupEnv({ name, port: wanted }) {
      const s = await api.status();
      if (!s.installed) throw new Error('The deploy agent is not installed yet');
      if (s.version !== s.localVersion) throw new Error(`The deploy agent on the server (v${s.version}) is older than this app's (v${s.localVersion}) and cannot set up .env. Update it on the Auto-deploy screen first.`);
      const info = ((s.config && s.config.projects) || []).find((x) => x.name === name);
      if (!info) throw new Error(`Project "${name}" not found`);
      if (!info.cloned) throw new Error(`${name} is not cloned yet. Its .env is set up automatically on the first deploy.`);
      const cfg = await readConfig();
      const list = cfg.projects || [];
      const p = list.find((x) => x.name === name);
      let chosen = wanted != null ? port(wanted) : p.app_port;
      if (chosen == null && info.env && info.env.port) {
        const served = (await nginx.list()).sites.some((site) => site.summary.targets.some((t) => new RegExp(`:${info.env.port}(\\D|$)`).test(t)));
        if (served) chosen = info.env.port;
      }
      if (chosen == null) chosen = (await nginx.nextPort(3000, { reserved: reservedPorts(list) })).port;
      if (p.app_port !== chosen) {
        p.app_port = chosen;
        await writeConfig(cfg, `Save port ${chosen} on the deploy project ${name} in the agent config ${CONFIG}`);
      }
      const r = await ssh.exec(`python3 ${SCRIPT} env ${q(name)}`, {
        sudo: true,
        what: `In ${p.path}: ${info.env && info.env.exists ? 'keep the existing .env' : info.env && info.env.example ? 'create .env from .env.example' : 'create .env'} and set APP_PORT=${chosen} in it`,
      });
      const output = `${r.stdout || ''}${r.stderr || ''}`.trim();
      if (r.code !== 0) throw new Error(output || `Setting up .env failed (exit code ${r.code})`);
      return { name, port: chosen, output };
    },

    runCommand(name) {
      check('projectName', name);
      return `python3 ${SCRIPT} run ${q(name)} --trigger manual`;
    },

    async log(file) {
      if (!file.startsWith(LOGS + '/') || !/^[A-Za-z0-9_\/.-]+\.log$/.test(file) || file.includes('..')) throw new Error('Invalid log path');
      return ssh.run(`tail -c 200000 ${q(file)}`, { sudo: true, read: true });
    },
  };
  return api;
};
