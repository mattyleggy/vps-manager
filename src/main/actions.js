'use strict';
// The action registry: every operation the app can perform on the server, defined once.
//
// The same definition drives three things:
//   - the UI      : buttons call api('<id>', input)
//   - the review  : `change: true` actions are planned, shown to the user and only then run
//   - the AI chat : each action is offered to the model as a tool (description + input schema)
//
// To add a capability, add one entry here. Fields:
//   id          '<area>:<verb>' - the IPC channel; the AI tool name is the id with ':' -> '_'
//   description what it does and when to use it (this is what the model reads)
//   input       JSON Schema of the input object (validated for both the UI and the model)
//   change      true if it modifies the server -> goes through review-before-apply
//   review      (input) => { title, detail?, danger? } shown at the top of the review dialog
//   run         (input) => result
//   progress    optional; true = after approval the UI shows each step live (running, done, failed)
//   forModel    optional (result, input) => what the model should see instead of the raw
//               result (trim bulk, hide secrets)

const dns = require('dns').promises;
const net = require('net');
const { check, port } = require('./validate');
const { recordBody, zoneFor, TYPES, NAMESERVERS } = require('./vultr');
const { SIZE_MB, KEEP } = require('./remote/traffic');

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const cap = (s) => s[0].toUpperCase() + s.slice(1);
/** IPv4 ranges that are not reachable from the internet (private, loopback, link-local, carrier NAT). */
const PRIVATE_IP = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
/** Record name + zone -> full hostname ('' or '@' = the zone itself). */
const fqdn = (name, zone) => (name && name !== '@' ? `${name}.${zone}` : zone);

const COMPOSE_NOTES = {
  rebuild: 'Rebuilds the images and recreates containers whose image or config changed. Expect a brief restart of those containers.',
  pull: 'Pulls newer images and recreates the containers that use them.',
  restart: 'Restarts every container in this project.',
  stop: 'Every container in this project stops serving until it is started again.',
  start: 'Creates and starts the containers of this project.',
};

/** Commands that get the red "read carefully" treatment when the assistant proposes them in Server mode. */
const DANGEROUS =
  /\brm\s+-\w*[rf]|\bmkfs|\bdd\s+if=|\b(reboot|shutdown|poweroff|halt|userdel|deluser|wipefs|fdisk|parted)\b|\bchmod\s+-R|\bchown\s+-R|\biptables\s+-F|\bufw\s+(disable|reset|deny)|\bsystemctl\s+(stop|disable|mask)\b|\bapt(-get)?\s+(remove|purge|autoremove)|\bdrop\s+(table|database)\b|\btruncate\b|>\s*\/(etc|boot|var\/lib)\//i;

const SITE_KIND ={ type: 'string', enum: ['site', 'conf.d'], description: '"site" = /etc/nginx/sites-available (the normal case), "conf.d" = /etc/nginx/conf.d' };

/** "https://github.com/owner/name.git" or "git@github.com:owner/name.git" -> "owner/name". */
const repoSlug = (s) =>
  String(s)
    .trim()
    .replace(/^(https?:\/\/|ssh:\/\/git@|git@)?(www\.)?github\.com[/:]/i, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');

/**
 * Validate the input of deploy:launch and fill in what was left out. Pure, so the review text
 * and the run agree. defaults: { hasToken, certEmail } decide the optional steps.
 */
function launchInput(a, { hasToken, certEmail }) {
  const repo = check('repo', repoSlug(a.repo));
  const domains = String(a.domains).split(/[\s,]+/).filter(Boolean).map((d) => check('domain', d.toLowerCase()));
  if (!domains.length) throw new Error('Enter at least one domain');
  const name = check('projectName', a.name || repo.split('/')[1].replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+/, ''));
  const type = a.type || 'proxy';
  const path = check('absPath', a.path || `/opt/apps/${name}`).replace(/\/+$/, '');
  const L = {
    repo,
    name,
    domains,
    site: check('siteName', domains[0].replace(/^\*\./, '')),
    type,
    path,
    branch: a.branch ? check('branch', a.branch) : '',
    command: String(a.command || '').trim(),
    auto: a.auto !== false,
    deployKey: a.deployKey === undefined ? !!hasToken : a.deployKey,
    webhook: a.webhook === undefined ? !!hasToken && a.auto !== false : a.webhook,
    https: a.https === undefined ? !!certEmail : a.https,
    certDomains: domains.filter((d) => !d.startsWith('*.')),
  };
  if (type === 'static') {
    const sub = String(a.subdir || '').replace(/^\/+|\/+$/g, '');
    L.root = check('absPath', sub ? `${path}/${sub}` : path);
  } else {
    if (a.upstreamPort === undefined) throw new Error('Enter the local port the app listens on');
    L.upstreamPort = port(a.upstreamPort);
  }
  if (L.webhook && !L.auto) throw new Error('A webhook only makes sense with automatic deploys. Turn automatic deploys on, or the webhook off.');
  if (L.webhook && !hasToken) throw new Error('Creating the webhook needs a GitHub token. Save one in Settings → GitHub, or turn the webhook off.');
  if (L.deployKey && !hasToken) throw new Error('Adding a deploy key needs a GitHub token. Save one in Settings → GitHub, or turn the deploy key off.');
  if (L.https && !certEmail) throw new Error("HTTPS needs your Let's Encrypt email. Set it in Settings, or turn HTTPS off.");
  if (L.https && !L.certDomains.length) throw new Error('A wildcard domain cannot get a certificate this way. Add a plain domain or turn HTTPS off.');
  return L;
}

module.exports = ({ ssh, store, system, nginx, docker, deploy, github, vultr, activity, detect, security, osv, traffic, shellJob, job }) => {
  // The last repository scan, so reopening the screen (or the assistant asking) doesn't re-run it.
  let repoScan = null;

  /** Check a repos scan's pinned packages against OSV.dev; OSV being unreachable is reported, not thrown. */
  async function checkRepos(scan) {
    const packages = scan.repos.flatMap((r) => r.lockfiles.flatMap((l) => l.packages.map(([name, version]) => ({ ecosystem: l.ecosystem, name, version }))));
    let hits = new Map();
    let osvError = null;
    try {
      hits = await osv.check(packages);
    } catch (e) {
      osvError = `Could not reach OSV.dev: ${e.message}`;
    }
    const result = security.withFindings(scan, hits);
    const checkedAt = Date.now() / 1000;
    for (const r of result.repos) r.checkedAt = checkedAt;
    return { result, osvError };
  }

  /** Resolve domains from this PC: does each point at the server ('ok'), elsewhere, or nowhere ('none')? */
  async function dnsStatus(domains, ips) {
    const mine = new Set([...(ips || (await system.info()).ips), ssh.info.host]);
    const out = {};
    await Promise.all(
      domains.slice(0, 200).map(async (d) => {
        try {
          check('domain', d);
          if (d.startsWith('*.')) return (out[d] = { status: 'wildcard', addrs: [] });
          const res = await Promise.allSettled([dns.resolve4(d), dns.resolve6(d)]);
          const addrs = res.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
          out[d] = { status: !addrs.length ? 'none' : addrs.some((a) => mine.has(a)) ? 'ok' : 'elsewhere', addrs };
        } catch {
          out[d] = { status: 'none', addrs: [] };
        }
      })
    );
    return out;
  }
  /**
   * The Vultr instance this server is, matched by IP (or the given id), with every read-only
   * detail the API has about it. Each part is fetched on its own so one failure (an API key
   * without billing access, say) leaves the rest; failures are listed in `errors`.
   */
  async function vultrInstance(id) {
    if (!vultr.hasKey()) return { hasKey: false };
    const instances = await vultr.listInstances();
    let inst = id ? instances.find((i) => i.id === id) : null;
    if (!inst && !id && ssh.connected) {
      const mine = new Set([ssh.info.host]);
      if (!net.isIP(ssh.info.host)) (await dns.resolve4(ssh.info.host).catch(() => [])).forEach((a) => mine.add(a));
      (await system.info().then((s) => s.ips).catch(() => [])).forEach((a) => mine.add(a));
      inst = instances.find((i) => mine.has(i.main_ip) || mine.has(i.v6_main_ip) || mine.has(i.internal_ip));
    }
    const list = instances.map((i) => ({ id: i.id, label: i.label, hostname: i.hostname, main_ip: i.main_ip, region: i.region, plan: i.plan }));
    if (!inst) return { hasKey: true, matched: false, instances: list };
    const errors = {};
    const part = (name, p) =>
      Promise.resolve()
        .then(p)
        .catch((e) => {
          errors[name] = e.message;
          return null;
        });
    const [full, bw, ipv4, ipv6, neighbors, backupSchedule, backups, snapshots, plans, regions, account, pending, fwGroup, fwRules] = await Promise.all([
      part('instance', () => vultr.instance(inst.id)),
      part('bandwidth', () => vultr.bandwidth(inst.id)),
      part('ipv4', () => vultr.ipv4(inst.id)),
      part('ipv6', () => vultr.ipv6(inst.id)),
      part('neighbors', () => vultr.neighbors(inst.id)),
      part('backupSchedule', () => vultr.backupSchedule(inst.id)),
      part('backups', () => vultr.backups(inst.id)),
      part('snapshots', () => vultr.snapshots()),
      part('plans', () => vultr.plans()),
      part('regions', () => vultr.regions()),
      part('account', () => vultr.account()),
      part('pendingCharges', () => vultr.pendingCharges()),
      part('firewall', () => (inst.firewall_group_id ? vultr.firewallGroup(inst.firewall_group_id) : null)),
      part('firewallRules', () => (inst.firewall_group_id ? vultr.firewallRules(inst.firewall_group_id) : [])),
    ]);
    const instance = full || inst;
    const bandwidth = Object.entries(bw || {})
      .map(([date, v]) => ({ date, in: Number(v.incoming_bytes) || 0, out: Number(v.outgoing_bytes) || 0 }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      hasKey: true,
      matched: true,
      instances: list,
      instance,
      plan: (plans || []).find((p) => p.id === instance.plan) || null,
      region: (regions || []).find((r) => r.id === instance.region) || null,
      bandwidth,
      ipv4,
      ipv6,
      neighbors,
      backupSchedule,
      backups,
      // Snapshots are account-wide; there is no link to the instance they were taken from.
      snapshots,
      firewall: fwGroup ? { group: fwGroup, rules: fwRules || [] } : null,
      account,
      pendingCharges: pending,
      errors,
    };
  }

  /** Who answers for a zone, looked up from this PC: { ns: [...], active: true when it is Vultr }. */
  async function delegation(zone) {
    const ns = (await dns.resolveNs(zone).catch(() => [])).map((n) => n.toLowerCase().replace(/\.$/, '')).sort();
    return { ns, active: ns.some((n) => n.endsWith('.vultr.com')) };
  }
  /** The server's public IPv4 address: the address the app connects to, resolved if it is a name. */
  async function serverIp() {
    const host = ssh.info.host;
    if (net.isIPv4(host)) return host;
    const addrs = await dns.resolve4(host).catch(() => []);
    if (addrs.length === 1) return addrs[0];
    const own = (((await system.info()) || {}).ips || []).filter((ip) => net.isIPv4(ip) && !PRIVATE_IP.test(ip));
    if (own.length === 1) return own[0];
    throw new Error(`Could not work out the server's public IPv4 address from "${host}". Give the IP address to point at.`);
  }
  /** Ports saved on deploy projects (their apps may not be running yet): [{ name, port }]. */
  async function projectPorts() {
    const list = await Promise.resolve(deploy.projectPorts()).catch(() => []);
    return Array.isArray(list) ? list : [];
  }
  const launchDefaults = () => ({ hasToken: github.hasToken(), certEmail: store.get().certEmail });

  const siteForModel = (s) => ({
    name: s.name,
    kind: s.kind,
    enabled: s.enabled,
    domains: s.summary.domains,
    serves: s.summary.targets,
    https: s.summary.ssl,
    certificateExpiry: s.certExpiry,
  });

  return [
    // ------------------------------------------------------------------ server
    {
      // The assistant's escape hatch in Server mode (chat.js gates it by mode). Like every change
      // it is planned and shown before it runs, so even a read-only command waits for Run.
      id: 'server:command',
      change: true,
      serverMode: true,
      description:
        'SERVER MODE ONLY. Run any shell command on the server (through bash -c) and get its exit code and output. Use it for what the other tools do not cover: files, logs, packages, services, firewall, cron, users, troubleshooting. Prefer a dedicated tool when one fits. The user sees every command and must press Run before it runs, read-only ones included, so compose one purposeful command per step rather than many tiny ones. Non-interactive only: no editors, pagers or prompts (use -y, --no-pager, cat, tee, sed -i). Stops after 10 minutes.',
      input: obj(
        {
          command: str('The exact shell command to run. Several commands can be joined with && or ;.'),
          purpose: str('One short sentence shown to the user as the title of the request, e.g. "Check why php8.3-fpm failed to start".'),
          asRoot: { type: 'boolean', description: 'Run with sudo (needed for system files, services and packages). Ignored when connected as root.' },
        },
        ['command', 'purpose']
      ),
      review: ({ command, purpose }) => {
        const danger = DANGEROUS.test(command);
        return {
          title: purpose,
          detail: danger ? 'This command can delete data, stop services or cut off access to the server. Read it carefully before running it.' : 'A command written by the assistant in Server mode.',
          danger,
        };
      },
      run: ({ command, purpose, asRoot }) =>
        job(purpose, async (onData) => {
          onData(`$ ${command}\n`);
          return (await ssh.exec(command, { sudo: !!asRoot, onData, what: purpose, timeout: 10 * 60 * 1000 })).code;
        }),
      forModel: (r) => ({ exitCode: r.code, output: r.output.replace(/^\$ [^\n]*\n/, '') }),
    },
    {
      id: 'system:info',
      description: 'Get server health: hostname, Ubuntu version, uptime, load, memory, disk, IP addresses, and whether nginx, docker, ufw and the deploy agent are running. Use for any "how is the server doing" question.',
      input: obj(),
      run: () => system.info(),
    },
    {
      id: 'system:sample',
      description: 'Read raw kernel counters once (CPU jiffies, memory, network bytes, disk operations, load, pressure). Two samples a few seconds apart give usage rates; for a one-off health check prefer system_info.',
      input: obj(),
      run: () => system.sample(),
    },
    {
      id: 'system:history',
      description: 'The last 24 hours of CPU (used, I/O wait, steal), memory and swap use, network and disk throughput, disk operations and load average, from sysstat on the server; one entry per sample (usually every 2 or 10 minutes). installed/enabled false means sysstat is not set up to collect (see system_enableHistory). Use for "was the server busy last night?" and similar.',
      input: obj(),
      run: () => system.history(),
      forModel: (r) => {
        const p = r.points || {};
        const n = (p.t || []).length;
        const stat = (k) => (n ? { avg: +(p[k].reduce((a, b) => a + b, 0) / n).toFixed(2), max: Math.max(...p[k]) } : null);
        return { installed: r.installed, enabled: r.enabled, collecting: r.collecting, interval: r.interval, cpus: r.cpus, samples: n, from: n ? new Date(p.t[0] * 1000).toISOString() : null, cpuPercent: stat('cpu'), iowaitPercent: stat('iowait'), stealPercent: stat('steal'), memPercent: stat('mem'), swapPercent: stat('swap'), netInBytesPerSec: stat('rx'), netOutBytesPerSec: stat('tx'), diskReadBytesPerSec: stat('rd'), diskWriteBytesPerSec: stat('wr'), load1: stat('l1') };
      },
    },
    {
      id: 'system:enableHistory',
      change: true,
      description: 'Install sysstat (if missing) and set it to record CPU, memory, disk and network usage every 2 minutes, so the 24-hour graphs on the Instance screen (and system_history) have data. Only when the user wants usage history.',
      input: obj(),
      review: () => ({
        title: 'Keep 24 hours of usage history (sysstat)',
        detail: 'Installs the sysstat package from Ubuntu if it is missing, turns its collector on and sets it to take a sample every 2 minutes. It keeps about a month of daily files in /var/log/sysstat (a few MB). The graphs fill in from now on; nothing from before is available.',
      }),
      run: () => shellJob('Enable sysstat history', system.ENABLE_HISTORY),
    },
    {
      id: 'vultr:instance',
      description: "Everything the Vultr API reports about the Vultr instance this server runs on: plan, region, status, OS, IPs, monthly cost and bandwidth allowance, daily bandwidth for about the last month, backups and snapshots, firewall group and rules, other instances on the same host, and the account's balance and pending charges. The instance is matched by IP address; id picks one explicitly. Read-only.",
      input: obj({ id: str('Vultr instance id; omit to match this server by IP') }),
      run: ({ id } = {}) => vultrInstance(id),
      forModel: (r) => (r.instance ? { ...r, bandwidth: r.bandwidth && r.bandwidth.slice(-7) } : r),
    },
    {
      id: 'activity:list',
      description: 'List what is being deployed or built on the server right now: deploy-agent deploys in progress (project, trigger, commit, current command, log path), Docker builds, compose up/pull/build, image pulls, git clone/pull, certbot, apt/dpkg and incoming file uploads (whether started by the agent, the app or by hand over SSH), containers still starting or restarting, and the last few finished deploys. Use for "is anything deploying?", "is the build still running?" or "what is the server doing?".',
      input: obj(),
      run: () => activity.list(),
    },
    {
      id: 'activity:history',
      description: 'The full history of deploy-agent deploys on the server, newest first (project, repository, trigger, commit, message, start/finish time, exit code, log path and whether that log is still kept), plus a breakdown per GitHub repository (projects, number of deploys, succeeded, failed, last deploy, average duration). repo filters to one repository: pass a "key" from the repos list (the owner/name, or "project:<name>" for a removed project). Read-only.',
      input: obj({
        repo: str('Repository key from repos[].key; omit for all repositories'),
        offset: { type: 'integer', description: 'Skip this many deploys (paging)' },
        limit: { type: 'integer', description: 'How many deploys to return (default 100, max 1000)' },
      }),
      run: ({ repo, offset, limit } = {}) => activity.history({ repo: repo || null, offset, limit }),
      forModel: (r) => ({ ...r, entries: r.entries.slice(0, 40) }),
    },
    // ------------------------------------------------------------------ security
    {
      id: 'security:repos',
      description:
        'Security check of the git repositories cloned on the server: finds every checkout under /opt, /srv, /var/www, /home, /root (and every deploy project folder), reads its lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, composer.lock, Pipfile.lock, poetry.lock, uv.lock, requirements*.txt, Cargo.lock, Gemfile.lock, go.mod) and checks each pinned package version against the OSV.dev vulnerability database. Returns each repo (path, origin, branch, last commit, uncommitted changes) with its known vulnerabilities (advisory id, severity, package, installed version, fixed versions). The result is cached; refresh: true scans again. Read-only.',
      input: obj({ refresh: { type: 'boolean', description: 'Scan again instead of returning the last result' } }),
      async run({ refresh } = {}) {
        if (repoScan && !refresh && repoScan.host === ssh.info.host) return repoScan;
        const { result, osvError } = await checkRepos(await security.repos());
        const out = { ...result, osvError, scannedAt: Date.now() / 1000, host: ssh.info.host };
        if (!osvError) repoScan = out;
        return out;
      },
      forModel: (r) => ({
        ...r,
        repos: r.repos.map((x) => ({ ...x, findings: x.findings.slice(0, 40).map(({ id, severity, package: pkg, version, fixed, summary, files }) => ({ id, severity, package: pkg, version, fixed, summary, files })), moreFindings: Math.max(0, x.findings.length - 40) })),
      }),
    },
    {
      id: 'security:repo',
      description: 'Scan one git checkout on the server again (its lockfiles, checked against OSV.dev) and update the cached security_repos result for it. Returns that repo with its known vulnerabilities. Read-only.',
      input: obj({ path: str('Absolute path of the checkout, as security_repos lists it') }, ['path']),
      async run({ path } = {}) {
        if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('path must be the absolute path of a checkout on the server');
        const scan = await security.repos(path);
        if (scan.error) throw new Error(scan.error);
        const { result, osvError } = await checkRepos(scan);
        const repo = result.repos[0];
        if (osvError) return { repo, osvError };
        if (repoScan && repoScan.host === ssh.info.host) {
          const i = repoScan.repos.findIndex((r) => r.path === repo.path);
          if (i >= 0) repoScan.repos[i] = repo;
          else repoScan.repos.push(repo);
        }
        return { repo, osvError: null };
      },
    },
    {
      id: 'system:updates',
      description:
        'Patches the server needs: every package apt can upgrade (installed and available version, source package, and whether it comes from a -security pocket), packages a plain upgrade keeps back, held packages, when the package lists were last refreshed, whether a reboot is required (and which packages asked for it), the running vs newest installed kernel, and whether unattended-upgrades is on. Read-only; run system_aptRefresh first if the lists are old.',
      input: obj(),
      run: () => security.updates(),
    },
    {
      id: 'system:aptRefresh',
      change: true,
      description: 'Run apt-get update so the list of available updates (system_updates) is current. Changes nothing installed.',
      input: obj(),
      review: () => ({ title: 'Refresh the package lists (apt-get update)', detail: 'Downloads the latest package indexes from the Ubuntu mirrors. Nothing is installed or upgraded.' }),
      run: () => shellJob('apt-get update', security.refreshCommand()),
    },
    {
      id: 'system:upgrade',
      change: true,
      description:
        'Install package updates on the server. With packages, upgrades only those (already-installed) packages, which is how to apply just the security updates from system_updates; without, runs apt-get upgrade for everything (it never removes packages or installs new ones, so kept-back packages stay). Existing config files are kept. Services using upgraded libraries are restarted by needrestart where installed.',
      input: obj({ packages: { type: 'array', items: { type: 'string' }, description: 'Package names to upgrade; omit for all' } }),
      review: ({ packages } = {}) => ({
        title: packages && packages.length ? `Install ${packages.length} package update${packages.length === 1 ? '' : 's'}` : 'Install all available updates (apt-get upgrade)',
        detail: `${packages && packages.length ? `Upgrades: ${packages.join(', ')}. ` : ''}Your changed config files are kept. Services that use upgraded libraries may restart briefly; a kernel or libc update needs a reboot to take effect.`,
      }),
      run: ({ packages } = {}) => {
        const list = (packages || []).map((p) => check('aptPackage', p));
        return shellJob(list.length ? `Upgrade ${list.length} package${list.length === 1 ? '' : 's'}` : 'apt-get upgrade', security.upgradeCommand(list));
      },
    },
    {
      id: 'system:reboot',
      change: true,
      description: 'Reboot the server, e.g. after a kernel update when system_updates reports a reboot is required. Every site and container is down until it is back up (usually under a minute). Only when the user asks for it.',
      input: obj(),
      review: () => ({
        title: 'Reboot the server',
        detail: 'Every site, container and the deploy agent stop until the server is back up, usually within a minute. The app loses its connection; press Connect in Settings (or the server pill) once it is back.',
        danger: true,
      }),
      run: () => shellJob('Reboot', security.rebootCommand()),
    },
    {
      id: 'github:repos',
      description: "List the connected user's GitHub repositories, most recently pushed first, with each one's default branch and whether it is private. With a GitHub token saved this includes private repositories; without one it falls back to the public repositories of the account the user's SSH key belongs to. Use to find or confirm a repository's exact owner/name before deploy_launch or deploy_saveProject.",
      input: obj(),
      run: () => github.listRepos(),
      forModel: (r) => ({ source: r.source, user: r.user, publicOnly: r.publicOnly, truncated: r.truncated, repos: r.repos.map((x) => ({ full_name: x.full_name, private: x.private, default_branch: x.default_branch, archived: x.archived || undefined })) }),
    },
    {
      id: 'dns:check',
      description: "Resolve domains (from the user's PC) and report whether each points at this server, elsewhere, or nowhere. Use before requesting a certificate or when a site is unreachable.",
      input: obj({ domains: { type: 'array', items: str('A domain name'), description: 'Domains to check' }, ips: { type: 'array', items: str('IP'), description: "The server's IPs; omit to look them up" } }, ['domains']),
      run: ({ domains, ips }) => dnsStatus(domains, ips),
    },

    // ------------------------------------------------------------------ DNS (Vultr)
    {
      id: 'dns:zones',
      description: "List the DNS zones (domains) hosted on the user's Vultr account, and for each whether its nameservers really are Vultr's (looked up from the user's PC); records in a zone whose nameservers point elsewhere have no effect. Call this first for anything about DNS records. hasKey false means no Vultr API key is saved in Settings.",
      input: obj(),
      async run() {
        if (!vultr.hasKey()) return { hasKey: false, nameservers: NAMESERVERS, zones: [] };
        const zones = await vultr.listZones();
        return {
          hasKey: true,
          nameservers: NAMESERVERS,
          zones: await Promise.all(zones.map(async (z) => ({ domain: z.domain, created: z.date_created, ...(await delegation(z.domain)) }))),
        };
      },
    },
    {
      id: 'dns:records',
      description: 'List the DNS records of one zone on Vultr: id, type, name (the part before the zone; empty = the domain itself), value, TTL and priority. Call before dns_saveRecord or dns_deleteRecord, which need a record id.',
      input: obj({ zone: str('The zone, e.g. example.com, as returned by dns_zones') }, ['zone']),
      run: async ({ zone }) => ({ zone: check('domain', zone.toLowerCase()), records: await vultr.listRecords(zone) }),
    },
    {
      id: 'dns:addZone',
      change: true,
      description: "Add a domain to Vultr DNS as a new, empty zone. Records in it only take effect once the domain's nameservers at its registrar are set to ns1.vultr.com and ns2.vultr.com. Use when the user wants Vultr to host a domain's DNS; then add records with dns_point or dns_saveRecord.",
      input: obj({ zone: str('The registered domain, e.g. example.com or example.com.au (not a subdomain)') }, ['zone']),
      review: ({ zone }) => ({
        title: `Add ${zone} to Vultr DNS`,
        detail: `Creates an empty DNS zone on your Vultr account. Nothing changes for visitors until the domain's nameservers at its registrar are set to ${NAMESERVERS.join(' and ')}.`,
      }),
      async run({ zone }) {
        const z = check('domain', zone.toLowerCase());
        if (z.startsWith('*.')) throw new Error('A zone cannot be a wildcard');
        if ((await vultr.listZones()).some((x) => x.domain === z)) return { zone: z, existed: true };
        await ssh.external(
          { what: `Create the DNS zone ${z} on Vultr`, via: 'Vultr API', display: `POST https://api.vultr.com/v2/domains\n${JSON.stringify({ domain: z, dns_sec: 'disabled' }, null, 2)}` },
          () => vultr.createZone(z)
        );
        return { zone: z, existed: false, nameservers: NAMESERVERS };
      },
    },
    {
      id: 'dns:point',
      change: true,
      description: "Point hostnames at this server in Vultr DNS: for each one, creates an A record with the server's public IPv4 address, or updates the existing A record (replacing a CNAME on the same name if there is one). Names that already point there are left alone. Each hostname must be inside a zone that exists on Vultr (see dns_zones). Use when setting up a site's domain, before requesting a certificate.",
      input: obj(
        {
          domains: { type: 'array', items: str('A hostname, e.g. example.com or app.example.com'), description: 'Hostnames to point at the server' },
          ip: str("IPv4 address to point at; omit to use this server's address"),
          ttl: { type: 'integer', description: 'TTL in seconds for new records (default 300)' },
        },
        ['domains']
      ),
      async review({ domains, ip }) {
        const lines = ['Creates or updates A records in Vultr DNS. Changes usually reach visitors within a few minutes (the TTL of the old record).'];
        const zones = await Promise.resolve(vultr.listZones()).catch(() => []);
        if (Array.isArray(zones)) {
          const used = [...new Set(domains.map((d) => (zoneFor(d, zones.map((z) => z.domain)) || {}).zone).filter(Boolean))];
          for (const z of used) {
            const d = await delegation(z);
            if (!d.active) lines.push(`Heads-up: ${z} ${d.ns.length ? `uses the nameservers ${d.ns.join(', ')}` : 'has no nameservers that could be looked up'}, not Vultr's. These records have no effect until its nameservers at the registrar are set to ${NAMESERVERS.join(' and ')}.`);
          }
        }
        return { title: `Point ${domains.join(', ')} at ${ip || 'this server'}`, detail: lines.join('\n\n') };
      },
      async run({ domains, ip, ttl }) {
        const target = ip ? String(ip).trim() : await serverIp();
        if (!net.isIPv4(target)) throw new Error(`Not an IPv4 address: "${target}"`);
        const hosts = [...new Set(domains.map((d) => check('domain', d.toLowerCase())))];
        if (!hosts.length) throw new Error('Enter at least one hostname');
        const zones = (await vultr.listZones()).map((z) => z.domain);
        const cache = {};
        const results = [];
        for (const host of hosts) {
          const at = zoneFor(host, zones);
          if (!at) {
            throw new Error(`${host} is not inside any DNS zone on your Vultr account${zones.length ? ` (zones: ${zones.join(', ')})` : ''}. Add its domain on the DNS screen first, and set the domain's nameservers to ${NAMESERVERS.join(' and ')}.`);
          }
          const records = cache[at.zone] || (cache[at.zone] = await vultr.listRecords(at.zone));
          const here = records.filter((r) => (r.name || '') === at.name);
          const a = here.filter((r) => r.type === 'A');
          if (a.length > 1) throw new Error(`${host} has ${a.length} A records (${a.map((r) => r.data).join(', ')}). Remove the ones you do not want on the DNS screen, then try again.`);
          if (a.length === 1 && a[0].data === target) {
            results.push({ host, zone: at.zone, status: 'already' });
            continue;
          }
          for (const c of here.filter((r) => r.type === 'CNAME')) {
            await ssh.external(
              { what: `Delete the CNAME record ${host} → ${c.data} (a name cannot have both a CNAME and an A record)`, via: 'Vultr API', display: `DELETE https://api.vultr.com/v2/domains/${at.zone}/records/${c.id}` },
              () => vultr.deleteRecord(at.zone, c.id)
            );
          }
          if (a.length === 1) {
            const body = { name: at.name, data: target, ttl: a[0].ttl };
            await ssh.external(
              { what: `Change the A record ${host} from ${a[0].data} to ${target}`, via: 'Vultr API', display: `PATCH https://api.vultr.com/v2/domains/${at.zone}/records/${a[0].id}\n${JSON.stringify(body, null, 2)}` },
              () => vultr.updateRecord(at.zone, a[0].id, { ...body, type: 'A' })
            );
            results.push({ host, zone: at.zone, status: 'updated', was: a[0].data });
          } else {
            const body = recordBody({ name: at.name, type: 'A', data: target, ttl });
            await ssh.external(
              { what: `Create the A record ${host} → ${target}`, via: 'Vultr API', display: `POST https://api.vultr.com/v2/domains/${at.zone}/records\n${JSON.stringify(body, null, 2)}` },
              () => vultr.createRecord(at.zone, body)
            );
            results.push({ host, zone: at.zone, status: 'created' });
          }
        }
        return { ip: target, results };
      },
    },
    {
      id: 'dns:saveRecord',
      change: true,
      description: 'Create a DNS record in a Vultr zone, or with id change an existing one in place (its type cannot change; delete and re-create for that). Types: A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, SSHFP. For simply pointing a hostname at this server prefer dns_point. Read dns_records first when editing.',
      input: obj(
        {
          zone: str('The zone, e.g. example.com'),
          id: str('Id of the record to change, from dns_records; omit to create a new record'),
          type: { type: 'string', enum: TYPES, description: 'Record type' },
          name: str('The part before the zone, e.g. "www" or "*"; empty string for the domain itself'),
          data: str('The value: an IP address, a hostname, or text (TXT values are quoted for you)'),
          ttl: { type: 'integer', description: 'TTL in seconds (default 300)' },
          priority: { type: 'integer', description: 'Priority, for MX and SRV records (default 10)' },
        },
        ['zone', 'type', 'name', 'data']
      ),
      review: (a) => ({ title: `${a.id ? 'Change' : 'Create'} the ${a.type} record ${fqdn(a.name, a.zone)}` }),
      async run({ zone, id, ...record }) {
        const z = check('domain', zone.toLowerCase());
        const body = recordBody(record);
        const host = fqdn(body.name, z);
        const records = await vultr.listRecords(z);
        if (id) {
          const old = records.find((r) => r.id === id);
          if (!old) throw new Error(`${z} has no record with id ${id}. It may have been deleted; refresh and try again.`);
          if (old.type !== body.type) throw new Error(`A record's type cannot be changed (${old.type} → ${body.type}). Delete it and create a new one.`);
          const { type, ...patch } = body;
          await ssh.external(
            { what: `Change the ${type} record ${fqdn(old.name, z)} (${old.data}) to ${host} → ${body.data}`, via: 'Vultr API', display: `PATCH https://api.vultr.com/v2/domains/${z}/records/${id}\n${JSON.stringify(patch, null, 2)}` },
            () => vultr.updateRecord(z, id, body)
          );
          return { zone: z, id, status: 'updated' };
        }
        if (records.some((r) => r.type === body.type && (r.name || '') === body.name && r.data === body.data)) return { zone: z, status: 'already' };
        const created = await ssh.external(
          { what: `Create the ${body.type} record ${host} → ${body.data}`, via: 'Vultr API', display: `POST https://api.vultr.com/v2/domains/${z}/records\n${JSON.stringify(body, null, 2)}` },
          () => vultr.createRecord(z, body)
        );
        return { zone: z, status: 'created', id: created && created.record && created.record.id };
      },
    },
    {
      id: 'dns:deleteRecord',
      change: true,
      description: 'Delete one DNS record from a Vultr zone, by id (from dns_records). Whatever relied on it (a site, email delivery, a verification) stops resolving. Only when the user clearly wants the record gone.',
      input: obj({ zone: str('The zone, e.g. example.com'), id: str('Record id, from dns_records') }, ['zone', 'id']),
      review: ({ zone }) => ({ title: `Delete a DNS record from ${zone}`, detail: 'Whatever relies on this record stops resolving once caches expire. It can be re-created by hand, but is not kept anywhere.', danger: true }),
      async run({ zone, id }) {
        const z = check('domain', zone.toLowerCase());
        const old = (await vultr.listRecords(z)).find((r) => r.id === id);
        if (!old) throw new Error(`${z} has no record with id ${id}. It may already be deleted.`);
        await ssh.external(
          { what: `Delete the ${old.type} record ${fqdn(old.name, z)} → ${old.data}`, via: 'Vultr API', display: `DELETE https://api.vultr.com/v2/domains/${z}/records/${id}` },
          () => vultr.deleteRecord(z, id)
        );
        return { zone: z, id, status: 'deleted' };
      },
    },

    // ------------------------------------------------------------------ nginx
    {
      id: 'nginx:list',
      description: 'List every nginx site config with its domains, what it serves (proxy target or folder), whether it is enabled, and certificate expiry. Call this first for anything about sites or domains. Use nginx_read to get a file\'s full text.',
      input: obj(),
      run: () => nginx.list(),
      forModel: (r) => ({ installed: r.installed, sites: r.sites.map(siteForModel) }),
    },
    {
      id: 'nginx:read',
      description: 'Read the full text of one nginx site config. Always call this before nginx_save so an edit starts from the current file.',
      input: obj({ name: str('Config file name, as returned by nginx_list'), kind: SITE_KIND }, ['name']),
      async run({ name, kind = 'site' }) {
        const site = (await nginx.list()).sites.find((s) => s.name === name && s.kind === kind);
        if (!site) throw new Error(`No ${kind} config named "${name}"`);
        return { name: site.name, kind: site.kind, path: site.path, enabled: site.enabled, content: site.content };
      },
    },
    {
      id: 'nginx:traffic',
      description: "Recent HTTP requests to one nginx site, read from its access log: totals by status class (2xx/3xx/4xx/5xx), requests per minute, busiest paths and client IPs, and the latest requests. Use when the user asks about a site's traffic, visitors, errors it is returning or whether it is getting requests. If the result says shared: true, the site has no access_log of its own and writes to the server-wide log; with grep: true only lines naming one of its domains were kept (usually in the Referer), so direct visits without a referrer are missed. nginx_siteLog gives it its own log.",
      input: obj(
        {
          name: str('Config file name, as returned by nginx_list'),
          kind: SITE_KIND,
          lines: { type: 'integer', description: 'How many of the most recent matching log lines to read (default 1000, max 5000)' },
          match: { type: 'string', enum: ['site', 'all'], description: 'Only for a site on the shared log: "site" (default) keeps lines naming one of its domains, "all" keeps every line of the shared log' },
        },
        ['name']
      ),
      run: (a) => traffic.read(a),
      forModel: (r) => ({ ...r, stats: { ...r.stats, perMinute: undefined }, entries: r.entries.slice(0, 40), entriesShown: Math.min(40, r.entries.length) }),
    },
    {
      id: 'nginx:siteLog',
      change: true,
      description: "Give a site its own access log with a size cap: adds `access_log /var/log/nginx/sites/<name>.access.log;` to each server block of its config that has none (then tests and reloads nginx; the old file is restored if the test fails), and sets up logrotate to rotate it, checked hourly, once it passes maxSizeMb, keeping `keep` old compressed copies. On a site that already has that log, it only changes the cap. Use when nginx_traffic reports shared: true and the user wants per-site traffic, or to change how big a site's log may get.",
      input: obj(
        {
          name: str('Config file name, as returned by nginx_list'),
          kind: SITE_KIND,
          maxSizeMb: { type: 'integer', minimum: SIZE_MB.min, maximum: SIZE_MB.max, description: `Rotate the log once it is bigger than this many MB (default ${SIZE_MB.default})` },
          keep: { type: 'integer', minimum: KEEP.min, maximum: KEEP.max, description: `How many rotated, compressed old copies to keep; 0 just empties the log (default ${KEEP.default})` },
        },
        ['name']
      ),
      review: (a) => {
        const size = a.maxSizeMb || SIZE_MB.default;
        const keep = a.keep == null ? KEEP.default : a.keep;
        const old = keep ? `the oldest of ${keep} compressed old cop${keep === 1 ? 'y is' : 'ies is'} deleted` : 'no old copy is kept';
        return {
          title: `Give ${a.name} its own access log, up to ${size} MB`,
          detail: `Requests to this site are written to /var/log/nginx/sites/${a.name}.access.log from now on (if they are not already); earlier requests stay in the shared log. Once a day and every hour, logrotate checks its size: past ${size} MB it is rotated and ${old}. The size can overshoot a little between checks.`,
        };
      },
      run: (a) => traffic.addSiteLog(a),
    },
    {
      id: 'nginx:test',
      description: 'Run nginx -t and return its output. Read-only; use to diagnose a config problem.',
      input: obj(),
      run: () => nginx.test(),
    },
    {
      id: 'nginx:create',
      change: true,
      description: 'Create and enable a new nginx site from a template. Types: "nextjs" (Next.js app on a local port), "laravel" (Laravel served by a container or Octane on a local port), "laravel-fpm" (Laravel on PHP-FPM installed on this server, served from its public/ folder), "proxy" (any other app on a local port), "app-websocket" (an app on one local port plus a separate Node.js WebSocket server on another, reached under wsPath on the same domain) and "static" (files from a folder). For the port types, omit upstreamPort to use the next free port on the server; the result reports which port was chosen, and the app must then be made to listen on it. Set https to also get a Let\'s Encrypt certificate in the same step. Use when the user wants to add a site or domain.',
      input: obj(
        {
          name: str('Config file name, conventionally the main domain, e.g. example.com'),
          type: { type: 'string', enum: ['proxy', 'nextjs', 'laravel', 'laravel-fpm', 'static', 'app-websocket'], description: 'nextjs / laravel / proxy = forward to an app on upstreamPort; app-websocket = app on upstreamPort plus a Node.js WebSocket server on wsPort under wsPath; laravel-fpm = PHP-FPM on this server serving root/public; static = serve files from root' },
          domains: str('Space-separated domain names, e.g. "example.com www.example.com"'),
          upstreamPort: { type: 'integer', description: 'Local port the app listens on (types proxy, nextjs, laravel, app-websocket). Omit to use the next free port: from 3000 for proxy and nextjs, from 8000 for laravel' },
          wsPort: { type: 'integer', description: 'Local port the Node.js WebSocket server listens on (type app-websocket). Omit to use the next free port after the app port' },
          wsPath: str('URL path forwarded to the WebSocket server (type app-websocket), e.g. "/ws" or "/socket.io/". Default "/ws"'),
          appFolder: str('Absolute folder the app runs from on the server (type app-websocket, optional; recorded in the config and used when setting up auto-deploy)'),
          wsFolder: str('Absolute folder the Node.js WebSocket server runs from (type app-websocket, optional)'),
          root: str('Absolute folder (types static and laravel-fpm). For laravel-fpm give the app folder, e.g. /opt/apps/myapp; /public is added'),
          https: { type: 'boolean', description: "Also get a Let's Encrypt certificate right after creating the site (domains must already point at this server; needs the Let's Encrypt email in Settings). Default false" },
        },
        ['name', 'type', 'domains']
      ),
      review: (a) => ({
        title: `Create and enable site ${a.name}${a.https ? ' with HTTPS' : ''}`,
        detail: a.https
          ? `The certificate step installs certbot if it is missing, uses ${store.get().certEmail} and agrees to the Let's Encrypt Subscriber Agreement on your behalf. If it fails (usually because DNS does not point here yet), the site stays up over HTTP.`
          : '',
      }),
      async run({ https, ...site }) {
        site.reserved = (await projectPorts()).map((p) => p.port);
        if (!https) return nginx.create(site);
        const email = store.get().certEmail;
        if (!email) throw new Error("Set your Let's Encrypt email in Settings first, or create the site without HTTPS");
        let created;
        const result = await job(`Create site ${site.name} with HTTPS`, async (log) => {
          created = await nginx.create(site);
          const certDomains = String(site.domains).split(/[\s,]+/).filter((d) => d && !d.startsWith('*.'));
          log(`Site ${site.name} created${created.upstreamPort ? `, forwarding to port ${created.upstreamPort}` : ''}${created.wsPort ? ` and ${created.wsPath} to port ${created.wsPort}` : ''}.\nRequesting an HTTPS certificate for ${certDomains.join(', ')}...\n`);
          const c = await ssh.exec(nginx.certbotCommand({ domains: certDomains, email }), {
            sudo: true,
            onData: log,
            what: `Get a Let's Encrypt certificate for ${certDomains.join(', ')} and switch the site to HTTPS`,
          });
          if (c.code !== 0) log(`\nThe site is up over HTTP but the certificate request failed. Once DNS points at this server, use "Get certificate" on the Sites screen.\n`);
          return c.code;
        });
        return { ...created, https: result.code === 0, ...result };
      },
    },
    {
      id: 'nginx:nextPort',
      description: 'Find the next free local port on the server for a new app: skips ports that are listening, ports existing nginx sites already forward to, ports published by any Docker container (running or stopped), and ports saved on deploy projects. Also returns "waiting": deploy projects that have a port but no nginx site forwarding to it yet; a site for one of those should use that project\'s port rather than the free one. Use before telling the user which port to run a new app on. nginx_create does this itself when upstreamPort is omitted.',
      input: obj({ from: { type: 'integer', description: 'Start searching at this port (default 3000; use 8000 for Laravel)' } }),
      async run({ from }) {
        const projects = await projectPorts();
        const r = await nginx.nextPort(from, { reserved: projects.map((p) => p.port) });
        let waiting = [];
        if (projects.length) {
          const targets = ((await nginx.list()).sites || []).flatMap((s) => s.summary.targets);
          waiting = projects.filter((p) => !targets.some((t) => new RegExp(`:${p.port}(\\D|$)`).test(t)));
        }
        return { ...r, waiting };
      },
    },
    {
      id: 'nginx:save',
      change: true,
      description: 'Replace the full text of an nginx site config, then test and reload nginx (the old file is restored automatically if the test fails). Send the complete file, not a fragment. Read it with nginx_read first.',
      input: obj({ name: str('Config file name'), kind: SITE_KIND, content: str('The complete new file content') }, ['name', 'content']),
      review: (a) => ({ title: `Save ${a.name} and reload nginx` }),
      run: ({ name, kind = 'site', content }) => nginx.save({ name, kind, content }),
    },
    {
      id: 'nginx:enable',
      change: true,
      description: 'Enable a site that exists in sites-available (link it into sites-enabled, test, reload).',
      input: obj({ name: str('Config file name') }, ['name']),
      review: (a) => ({ title: `Enable site ${a.name}` }),
      run: ({ name }) => nginx.enable(name),
    },
    {
      id: 'nginx:disable',
      change: true,
      description: 'Disable a site without deleting its config (unlink from sites-enabled, test, reload). The site stops being served.',
      input: obj({ name: str('Config file name') }, ['name']),
      review: (a) => ({ title: `Disable site ${a.name}`, detail: 'The site stops being served until it is enabled again. The config file is kept.', danger: true }),
      run: ({ name }) => nginx.disable(name),
    },
    {
      id: 'nginx:delete',
      change: true,
      description: 'Remove a site config from nginx. A copy is kept in /var/backups/vps-manager/nginx. Only when the user clearly wants the site gone.',
      input: obj({ name: str('Config file name'), kind: SITE_KIND }, ['name']),
      review: (a) => ({ title: `Delete site ${a.name}`, detail: 'The config is removed from nginx. A copy is kept in /var/backups/vps-manager/nginx on the server.', danger: true }),
      run: ({ name, kind = 'site' }) => nginx.remove({ name, kind }),
    },
    {
      id: 'nginx:reload',
      change: true,
      description: 'Test the nginx config and reload nginx if it passes.',
      input: obj(),
      review: () => ({ title: 'Reload nginx' }),
      run: () => nginx.reload(),
    },
    {
      id: 'nginx:certbot',
      change: true,
      description: "Get or renew a free Let's Encrypt HTTPS certificate for domains of an existing nginx site, and let certbot switch the site to HTTPS. The domains must already resolve to this server (check with dns_check). Needs the Let's Encrypt email set in Settings.",
      input: obj({ domains: { type: 'array', items: str('A domain name'), description: 'Domains to put on the certificate (no wildcards)' } }, ['domains']),
      review: ({ domains }) => ({
        title: `Get HTTPS certificate for ${domains.join(', ')}`,
        detail: `Installs certbot if it is missing, requests a free Let's Encrypt certificate using ${store.get().certEmail}, agrees to the Let's Encrypt Subscriber Agreement on your behalf, and lets certbot edit the site's config to enable HTTPS with a redirect. The domains must already point at this server.`,
      }),
      run({ domains }) {
        const email = store.get().certEmail;
        if (!email) throw new Error("Set your Let's Encrypt email in Settings first");
        return shellJob(`certbot: ${domains.join(', ')}`, nginx.certbotCommand({ domains, email }));
      },
    },

    // ------------------------------------------------------------------ docker
    {
      id: 'docker:list',
      description: 'List Docker containers (state, image, ports, compose project) and compose projects, plus disk usage. Call this first for anything about containers or builds.',
      input: obj(),
      run: () => docker.list(),
    },
    {
      id: 'docker:logs',
      description: 'Get the last lines of a container\'s logs. Use to diagnose a crashing or misbehaving container.',
      input: obj({ name: str('Container name, as returned by docker_list'), tail: { type: 'integer', description: 'Number of lines (default 300)' } }, ['name']),
      run: (a) => docker.logs(a),
    },
    {
      id: 'docker:container',
      change: true,
      description: 'Start, stop or restart a single container.',
      input: obj({ name: str('Container name'), action: { type: 'string', enum: ['start', 'stop', 'restart'] } }, ['name', 'action']),
      review: (a) => ({
        title: `${cap(a.action)} container ${a.name}`,
        detail: a.action === 'stop' ? 'The container stops serving until it is started again.' : '',
        danger: a.action === 'stop',
      }),
      run: (a) => docker.container(a),
    },
    {
      id: 'docker:compose',
      description: 'Act on a whole compose project: rebuild (build images and recreate changed containers), pull (pull newer images and recreate), restart, stop, start, or logs (read-only, last 300 lines). Use rebuild when the user asks to rebuild or redeploy a docker project in place.',
      change: true, // "logs" records no change steps, so it runs without a review dialog
      input: obj({ project: str('Compose project name, as returned by docker_list'), action: { type: 'string', enum: ['rebuild', 'pull', 'restart', 'stop', 'start', 'logs'] } }, ['project', 'action']),
      review: (a) => ({ title: `${cap(a.action)} compose project ${a.project}`, detail: COMPOSE_NOTES[a.action] || '', danger: a.action === 'stop' }),
      async run(a) {
        const { title, cmd, read } = await docker.composeCommand(a);
        return shellJob(title, cmd, { read });
      },
    },
    {
      id: 'docker:prune',
      change: true,
      description: 'Remove dangling images and the build cache to free disk space. Running containers and tagged images are untouched.',
      input: obj(),
      review: () => ({
        title: 'Prune unused images and build cache',
        detail: 'Frees disk space. Running containers and tagged images are not touched; the next rebuild may be slower.',
      }),
      run: () => shellJob('Prune unused images & build cache', docker.pruneCommand()),
    },
    {
      id: 'docker:pruneBuild',
      change: true,
      description: 'Delete the entire Docker build cache and report free disk space. Use when the disk is filling up; images, containers and volumes are untouched.',
      input: obj(),
      review: () => ({
        title: 'Prune the Docker build cache',
        detail: 'Deletes all cached build layers to free disk space. Images, containers and volumes are not touched; the next rebuild starts from scratch and will be slower.',
      }),
      run: () => shellJob('Prune Docker build cache', docker.pruneBuildCommand()),
    },

    // ------------------------------------------------------------------ deploys
    {
      id: 'deploy:status',
      description: 'Get the auto-deploy setup: whether the webhook agent is installed and running, the webhook URL, the configured projects (repo, branch, folder, command, auto on/off), the server\'s GitHub public key, and recent deploy history with results. Call this first for anything about deploys.',
      input: obj(),
      run: () => deploy.status(),
      // The webhook secret never needs to leave the app.
      forModel: (r) => ({ ...r, config: r.config && { ...r.config, secret: '[hidden - shown in the app\'s Auto-deploy screen]' } }),
    },
    {
      id: 'deploy:launch',
      change: true,
      progress: true, // the UI shows each approved step as it runs
      description:
        'Go from a GitHub repository to a live site in one reviewed step: adds the repo as a deploy project, optionally gives it a read-only deploy key and a push webhook (so later pushes redeploy), clones it onto the server and runs its deploy command, creates and enables an nginx site for the domain(s) pointing at the app, and optionally gets an HTTPS certificate. Use this when the user wants to put a repo online on a domain. The deploy agent must be installed (see deploy_status). If the deploy fails, the domain is not set up.',
      input: obj(
        {
          repo: str('GitHub repository as owner/name (a github.com URL is accepted too)'),
          domains: str('Space-separated domain names for the site, e.g. "example.com www.example.com"; the first one names the nginx config'),
          type: { type: 'string', enum: ['proxy', 'static'], description: 'proxy (default) = the app runs on the server (e.g. docker compose) and nginx proxies to upstreamPort; static = nginx serves files straight from the checkout' },
          upstreamPort: { type: 'integer', description: 'Local port the app listens on once deployed (required for type proxy)' },
          subdir: str('For type static: folder inside the repo to serve, e.g. "public" or "dist"; omit to serve the repo root'),
          branch: str("Branch to deploy; omit to use the repository's default branch"),
          name: str('Project name (letters, numbers, dashes, underscores); omit to use the repo name'),
          path: str('Folder on the server to clone into; omit for /opt/apps/<name>'),
          command: str('Deploy command run as root in the folder after cloning. Omit for the default: "git pull --ff-only origin <branch> && docker compose up -d --build --remove-orphans" for proxy, just the git pull for static'),
          deployKey: { type: 'boolean', description: 'Create a read-only deploy key for the repo and add it through the GitHub API (needed for private repos unless the server key is on the account). Default: true when a GitHub token is saved' },
          https: { type: 'boolean', description: "Get a Let's Encrypt certificate at the end (domains must already point at this server). Default: true when the Let's Encrypt email is set" },
          auto: { type: 'boolean', description: 'Also deploy automatically on later pushes to the branch (default true); needs the webhook' },
          webhook: { type: 'boolean', description: 'Create the push webhook on the repo through the GitHub API, so later pushes deploy automatically (the token needs Webhooks: write). Default: true when a GitHub token is saved and auto is on' },
        },
        ['repo', 'domains']
      ),
      async review(a) {
        const L = launchInput(a, launchDefaults());
        const agent = (await Promise.resolve(deploy.status()).catch(() => null)) || {};
        const agentOutdated = !!agent.version && !!agent.localVersion && agent.version !== agent.localVersion;
        const serves = L.type === 'static' ? `serves the files in ${L.root}` : `forwards to the app on port ${L.upstreamPort}`;
        const lines = [
          `Clones ${L.repo} into ${L.path}, runs its deploy command, then creates an nginx site for ${L.domains.join(', ')} that ${serves}${L.https ? ', and gets an HTTPS certificate' : ''}.`,
          'The steps run in order and stop at the first failure: if the deploy fails, nginx is not touched.',
          `On a fresh clone, .env is created from the repository's .env.example${L.upstreamPort ? ` and APP_PORT is set to ${L.upstreamPort} in it (added if the example has no APP_PORT)` : ''}, before the deploy command runs. A .env that comes with the repository is left as it is.`,
          ...(agentOutdated ? [`Heads-up: the deploy agent on the server is v${agent.version}, older than this app's v${agent.localVersion}, and will not create .env. Update it on the Auto-deploy screen first.`] : []),
          ...(L.webhook ? [`A webhook is added to ${L.repo} so later pushes redeploy it; the webhook secret is sent to GitHub but not shown here.`] : []),
        ];
        if (L.https) {
          lines.push(`The certificate step installs certbot if it is missing, uses ${store.get().certEmail} and agrees to the Let's Encrypt Subscriber Agreement on your behalf.`);
          const dnsOf = await dnsStatus(L.certDomains).catch(() => ({}));
          const off = L.certDomains.filter((d) => dnsOf[d] && dnsOf[d].status !== 'ok');
          if (off.length) {
            lines.push(
              `Heads-up: ${off.map((d) => `${d} ${dnsOf[d].status === 'none' ? 'has no DNS record yet' : `points at ${dnsOf[d].addrs.join(', ')}, not at this server`}`).join('; ')}. Unless that is a proxy in front of this server, the certificate step will fail; the site will still be up over HTTP and you can use "Get certificate" on the Sites screen later.`
            );
          }
        }
        return { title: `Launch ${L.repo} on ${L.site}`, detail: lines.join('\n\n') };
      },
      run(a) {
        const L = launchInput(a, launchDefaults());
        return job(`Launch ${L.repo} on ${L.site}`, async (log) => {
          const branch = L.branch || (await github.defaultBranch(L.repo));
          // A static site has nothing to build or start: its deploy is just the pull.
          const command = L.command || (L.type === 'static' ? `git pull --ff-only origin ${branch}` : '');

          log(`Adding deploy project ${L.name} (${L.repo}, branch ${branch})...\n`);
          await deploy.addProject({ project: { name: L.name, repo: L.repo, branch, path: L.path, command, auto: L.auto, app_port: L.upstreamPort }, deployKey: L.deployKey, webhook: L.webhook });

          log(`Cloning into ${L.path} and deploying...\n`);
          const d = await ssh.exec(deploy.runCommand(L.name), {
            sudo: true,
            onData: log,
            what: `Clone ${L.repo} (branch ${branch}) into ${L.path} if it is not there yet, create .env from .env.example${L.upstreamPort ? ` with APP_PORT=${L.upstreamPort}` : ''}, then run its deploy command as root: ${command || `git pull --ff-only origin ${branch} && docker compose up -d --build --remove-orphans`}`,
          });
          if (d.code !== 0) {
            throw new Error(`The deploy failed (exit code ${d.code}), so the domain was not set up. The project "${L.name}" is saved: fix the problem, then launch again or use Deploy now.`);
          }

          log(`\nCreating nginx site ${L.site}...\n`);
          await nginx.create({ name: L.site, type: L.type, domains: L.domains, upstreamPort: L.upstreamPort, root: L.root, hideDotfiles: true });

          if (L.https) {
            log(`Requesting an HTTPS certificate for ${L.certDomains.join(', ')}...\n`);
            const c = await ssh.exec(nginx.certbotCommand({ domains: L.certDomains, email: store.get().certEmail }), {
              sudo: true,
              onData: log,
              what: `Get a Let's Encrypt certificate for ${L.certDomains.join(', ')} and switch the site to HTTPS`,
            });
            if (c.code !== 0) {
              log(`\nThe site is live at http://${L.certDomains[0]} but the certificate request failed. Once DNS points at this server, use "Get certificate" on the Sites screen.\n`);
              return c.code;
            }
          }
          log(`\n${L.repo} is live at ${L.https ? 'https' : 'http'}://${L.certDomains[0] || L.site}\n`);
          if (L.webhook) log(`Pushes to ${branch} now redeploy it automatically.\n`);
          else if (L.auto) log(`To redeploy on every push, add the webhook to the repo (Auto-deploy screen → Add webhook).\n`);
          return 0;
        });
      },
    },
    {
      id: 'deploy:detect',
      description: 'For an existing nginx site, work out what auto-deploy for it should look like: finds the folder it is served from (through the Docker container or process on the port it forwards to, or the folder it serves), the GitHub repository and branch, and a deploy command matching how the app runs now (keeping the compose project name so a deploy replaces the running containers). Returns a ready project for deploy_saveProject plus notes on anything to check. Read-only. Use when the user wants pushes to deploy a site that already exists.',
      input: obj({ name: str('nginx site name, as returned by nginx_list'), kind: SITE_KIND }, ['name']),
      run: (a) => detect.site(a),
    },
    {
      id: 'deploy:log',
      description: 'Read the log of one past deploy. Use the "log" path from the history in deploy_status. Use to explain why a deploy failed.',
      input: obj({ file: str('Log file path from deploy_status history') }, ['file']),
      run: ({ file }) => deploy.log(file),
    },
    {
      id: 'deploy:testKey',
      description: 'Check, from the server, whether GitHub accepts the server\'s SSH key (runs ssh -T git@github.com). Read-only.',
      input: obj(),
      run: () => deploy.testKey(),
    },
    {
      id: 'deploy:install',
      change: true,
      description: 'Install or update the deploy agent (the service that receives GitHub push webhooks). Keeps existing projects and the secret. With a hostname, nginx forwards /hooks/ on that hostname to the agent; without one, the agent port is opened directly.',
      input: obj({ hostname: str('Optional (sub)domain pointing at this server for the webhook URL; empty string for none'), port: { type: 'integer', description: 'Local agent port (default 9321)' } }),
      review: () => ({
        title: 'Install / update the deploy agent',
        detail: 'Installs a small Python service that runs as root, receives GitHub push webhooks and runs your deploy commands. Existing projects and the webhook secret are kept.',
      }),
      run: (opts) =>
        job('Install deploy agent', async (onData) => {
          await deploy.install(opts, onData);
          return 0;
        }),
    },
    {
      id: 'deploy:saveProject',
      change: true,
      description: 'Add a deploy project or update an existing one (pass originalName when renaming or editing). A project maps a GitHub repo + branch to a folder on the server and a deploy command. With automatic deploys on and a GitHub token saved, the push webhook is added to the repository in the same step (see webhook). Nothing is deployed until a push or deploy_run. The agent must be installed first.',
      input: obj(
        {
          project: obj(
            {
              name: str('Short project name: letters, numbers, dashes, underscores'),
              repo: str('GitHub repository as owner/name'),
              branch: str('Branch to deploy (default master)'),
              path: str('Absolute folder on the server, at least two levels deep, e.g. /opt/apps/myapp'),
              command: str('Shell command run as root in the folder; empty string for the default "git pull --ff-only origin <branch> && docker compose up -d --build --remove-orphans"'),
              auto: { type: 'boolean', description: 'Deploy automatically on push to the branch (default true)' },
              app_port: { type: 'integer', description: 'Local port the app should listen on. On the first clone it is written to .env as APP_PORT (.env is created from .env.example). Omit: a new project gets the next free port, an existing one keeps its port' },
            },
            ['name', 'repo', 'path']
          ),
          originalName: str('Current name of the project being edited; omit when adding a new one'),
          deployKey: { type: 'boolean', description: "Also give the project its own read-only deploy key on the repository (generated on the server, public half added through the GitHub API), and if its folder is already a checkout pulling over HTTPS, switch its origin to SSH so the key is used. Default: done for a new project when a GitHub token is saved; the result's deployKey.status says what happened (added, kept, existing, skipped with a reason, no-token, off)" },
          webhook: { type: 'boolean', description: "Also create the push webhook on the repository through the GitHub API, in the same step, so pushes deploy automatically. Default: done whenever auto is on, a GitHub token is saved and the project does not have its webhook yet; the result's webhook.status says what happened (created, updated, kept, skipped with a reason, no-token, off)" },
        },
        ['project']
      ),
      review: (a) => ({
        title: `Save deploy project ${a.project.name}`,
        detail: 'The agent config is updated. Steps marked GitHub API add the project’s read-only deploy key and/or the push webhook to the repository; the webhook secret is sent to GitHub but not shown here. Nothing is deployed until you press Deploy now or push to the branch.',
      }),
      run: (a) => deploy.saveProject(a),
    },
    {
      id: 'deploy:deleteProject',
      change: true,
      description: 'Remove a deploy project from the agent config. Its folder and containers on the server are left alone.',
      input: obj({ name: str('Project name') }, ['name']),
      review: ({ name }) => ({ title: `Remove deploy project ${name}`, detail: 'Stops deploying this project. Its folder and containers on the server are left untouched.', danger: true }),
      run: ({ name }) => deploy.deleteProject(name),
    },
    {
      id: 'deploy:run',
      change: true,
      description: 'Deploy a project now: the agent runs the project\'s deploy command (cloning the repo first if the folder has no checkout) and the output is returned. Use when the user asks to deploy, redeploy or pull the latest code for a project.',
      input: obj({ name: str('Project name, as returned by deploy_status') }, ['name']),
      review: async ({ name }) => ({ title: `Deploy ${name} now`, detail: await deploy.describeRun(name) }),
      run: ({ name }) => shellJob(`Deploy: ${name}`, deploy.runCommand(name), { what: `Run the deploy command of ${name} through the agent` }),
    },
    {
      id: 'deploy:env',
      change: true,
      description: "Set up .env for a deploy project that is already cloned: creates .env from the repository's .env.example if there is none (an existing .env keeps its other values) and sets APP_PORT in it to the project's port. With no port given it uses the project's saved port, else the APP_PORT already in .env if an nginx site forwards to it, else the next free port, and saves it on the project. New clones get this automatically; use this for projects cloned earlier or after changing a port. The app must be restarted (deploy_run) to pick up a changed port.",
      input: obj({ name: str('Deploy project name, as returned by deploy_status'), port: { type: 'integer', description: 'Port to set as APP_PORT; omit to choose as described' } }, ['name']),
      review: ({ name }) => ({
        title: `Set up .env for ${name}`,
        detail: 'Only APP_PORT is written; every other value in an existing .env is kept. A .env that is part of the repository is refused, because changing it would block later pulls. The running app keeps its current port until it is redeployed or restarted.',
      }),
      run: (a) => deploy.setupEnv(a),
    },
    {
      id: 'deploy:repoKey',
      change: true,
      description: "Give one deploy project its own read-only GitHub deploy key, fully automatically: generates an SSH key pair on the server for that project (if it has none), adds the public half to the project's GitHub repository through the GitHub API, and makes the project pull with it (switching an existing checkout's origin from HTTPS to SSH if needed, since the key only works over SSH). Use this for private repositories, once per project; it is safe to repeat. Needs a GitHub token saved in Settings with Administration: write on the repository.",
      input: obj({ name: str('Deploy project name, as returned by deploy_status') }, ['name']),
      review: ({ name }) => ({
        title: `Add a GitHub deploy key for ${name}`,
        detail: 'The key is read-only and works for this one repository. The private half stays on the server; only the public half is sent to GitHub, using the token saved in Settings.',
      }),
      run: ({ name }) => deploy.repoKey(name),
    },
    {
      id: 'deploy:webhook',
      change: true,
      description: "Create the GitHub webhook for one deploy project, fully automatically: adds a push webhook to the project's repository pointing at this server's deploy agent, with the agent's secret. If the repository already has a webhook for this URL it is updated instead, which re-sends the current secret (use this after deploy_rotateSecret). Use when the user wants pushes to auto-deploy a project. Needs the deploy agent installed and a GitHub token in Settings with Webhooks: write on the repository.",
      input: obj({ name: str('Deploy project name, as returned by deploy_status') }, ['name']),
      review: ({ name }) => ({
        title: `Set up the GitHub webhook for ${name}`,
        detail: 'After this, every push to the repository calls this server, and the agent deploys when the pushed branch matches the project. The webhook secret is sent to GitHub but not shown here. GitHub sends a test "ping" straight away.',
      }),
      run: ({ name }) => deploy.repoWebhook(name),
    },
    {
      id: 'deploy:key',
      change: true,
      description: "Create the server-wide SSH key for GitHub if it does not exist and return the public key, which the user must add to GitHub by hand. Prefer deploy_repoKey, which needs no manual step; use this only when the user wants one shared key on their account.",
      input: obj(),
      review: () => ({ title: 'Create the server SSH key for GitHub' }),
      run: () => deploy.serverKey(),
    },
    {
      id: 'deploy:rotateSecret',
      change: true,
      description: 'Generate a new webhook secret. Every existing GitHub webhook stops working until the user pastes the new secret into it. Only on explicit request.',
      input: obj(),
      review: () => ({
        title: 'Rotate the webhook secret',
        detail: 'Existing GitHub webhooks will fail until they have the new secret. For webhooks this app created, press "Webhook" on each project afterwards to send it; for ones added by hand, paste it in on GitHub.',
        danger: true,
      }),
      run: () => deploy.rotateSecret(),
      forModel: () => "The secret was rotated. The new value is shown in the app's Auto-deploy screen, not here.",
    },
  ];
};

/** The AI tool name for an action id: 'nginx:create' -> 'nginx_create'. */
module.exports.toolName = (id) => id.replace(':', '_');
module.exports.launchInput = launchInput;
