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

const SITE_KIND = { type: 'string', enum: ['site', 'conf.d'], description: '"site" = /etc/nginx/sites-available (the normal case), "conf.d" = /etc/nginx/conf.d' };

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

module.exports = ({ ssh, store, system, nginx, docker, deploy, github, vultr, activity, detect, shellJob, job }) => {
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
      id: 'system:info',
      description: 'Get server health: hostname, Ubuntu version, uptime, load, memory, disk, IP addresses, and whether nginx, docker, ufw and the deploy agent are running. Use for any "how is the server doing" question.',
      input: obj(),
      run: () => system.info(),
    },
    {
      id: 'activity:list',
      description: 'List what is being deployed or built on the server right now: deploy-agent deploys in progress (project, trigger, commit, current command, log path), Docker builds, compose up/pull/build, image pulls, git clone/pull, certbot, apt/dpkg and incoming file uploads (whether started by the agent, the app or by hand over SSH), containers still starting or restarting, and the last few finished deploys. Use for "is anything deploying?", "is the build still running?" or "what is the server doing?".',
      input: obj(),
      run: () => activity.list(),
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
      id: 'nginx:test',
      description: 'Run nginx -t and return its output. Read-only; use to diagnose a config problem.',
      input: obj(),
      run: () => nginx.test(),
    },
    {
      id: 'nginx:create',
      change: true,
      description: 'Create and enable a new nginx site from a template. Types: "nextjs" (Next.js app on a local port), "laravel" (Laravel served by a container or Octane on a local port), "laravel-fpm" (Laravel on PHP-FPM installed on this server, served from its public/ folder), "proxy" (any other app on a local port) and "static" (files from a folder). For the port types, omit upstreamPort to use the next free port on the server; the result reports which port was chosen, and the app must then be made to listen on it. Set https to also get a Let\'s Encrypt certificate in the same step. Use when the user wants to add a site or domain.',
      input: obj(
        {
          name: str('Config file name, conventionally the main domain, e.g. example.com'),
          type: { type: 'string', enum: ['proxy', 'nextjs', 'laravel', 'laravel-fpm', 'static'], description: 'nextjs / laravel / proxy = forward to an app on upstreamPort; laravel-fpm = PHP-FPM on this server serving root/public; static = serve files from root' },
          domains: str('Space-separated domain names, e.g. "example.com www.example.com"'),
          upstreamPort: { type: 'integer', description: 'Local port the app listens on (types proxy, nextjs, laravel). Omit to use the next free port: from 3000 for proxy and nextjs, from 8000 for laravel' },
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
          log(`Site ${site.name} created${created.upstreamPort ? `, forwarding to port ${created.upstreamPort}` : ''}.\nRequesting an HTTPS certificate for ${certDomains.join(', ')}...\n`);
          const c = await ssh.exec(nginx.certbotCommand({ domains: certDomains, email }), {
            sudo: true,
            onData: log,
            what: `Get a Let's Encrypt certificate for ${certDomains.join(', ')} and switch the site to HTTPS`,
          });
          if (c.code !== 0) log(`\nThe site is up over HTTP but the certificate request failed. Once DNS points at this server, use "Get certificate" on the Domains screen.\n`);
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
              `Heads-up: ${off.map((d) => `${d} ${dnsOf[d].status === 'none' ? 'has no DNS record yet' : `points at ${dnsOf[d].addrs.join(', ')}, not at this server`}`).join('; ')}. Unless that is a proxy in front of this server, the certificate step will fail; the site will still be up over HTTP and you can use "Get certificate" on the Domains screen later.`
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
              log(`\nThe site is live at http://${L.certDomains[0]} but the certificate request failed. Once DNS points at this server, use "Get certificate" on the Domains screen.\n`);
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
