'use strict';
const { q } = require('../ssh');
const { check, port } = require('../validate');
const { summarize } = require('./nginx-parse');

const AVAILABLE = '/etc/nginx/sites-available';
const ENABLED = '/etc/nginx/sites-enabled';
const CONFD = '/etc/nginx/conf.d';
const BACKUPS = '/var/backups/vps-manager/nginx';

const LIST_SCRIPT = String.raw`
import glob, json, os, re, subprocess

enabled = set()
if os.path.isdir('${ENABLED}'):
    for n in os.listdir('${ENABLED}'):
        enabled.add(os.path.realpath(os.path.join('${ENABLED}', n)))

files = [(p, 'site') for p in sorted(glob.glob('${AVAILABLE}/*'))]
files += [(p, 'conf.d') for p in sorted(glob.glob('${CONFD}/*.conf'))]

cache = {}
def cert_end(path):
    if path not in cache:
        try:
            o = subprocess.run(['openssl', 'x509', '-enddate', '-noout', '-in', path],
                               capture_output=True, text=True, timeout=5).stdout.strip()
            cache[path] = o.split('=', 1)[1] if '=' in o else None
        except Exception:
            cache[path] = None
    return cache[path]

res = []
for p, kind in files:
    if not os.path.isfile(p):
        continue
    try:
        c = open(p, errors='replace').read()
    except Exception:
        c = ''
    certs = {m: cert_end(m) for m in set(re.findall(r'^\s*ssl_certificate\s+([^;\s]+)\s*;', c, re.M))}
    res.append({
        'name': os.path.basename(p), 'path': p, 'kind': kind,
        'enabled': kind == 'conf.d' or os.path.realpath(p) in enabled,
        'content': c, 'certExpiry': certs,
    })
print(json.dumps({'installed': os.path.isdir('/etc/nginx'), 'sites': res}))
`;

// Run after any change: validate the whole config, reload only if it passes.
const TEST_AND_RELOAD = (onFail) => `
if out=$(nginx -t 2>&1); then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
else
  ${onFail}
  echo "$out" >&2
  exit 3
fi`;

function filePath(name, kind) {
  check('siteName', name);
  return `${kind === 'conf.d' ? CONFD : AVAILABLE}/${name}`;
}

function template({ type, domains, upstreamPort, root, hideDotfiles, fpmSocket, wsPort, wsPath = '/ws', appFolder, wsFolder }) {
  const names = domains.join(' ');
  if (type === 'static') {
    // A folder that is a git checkout must never serve its .git directory (or .env files).
    const dotfiles = hideDotfiles
      ? `
    location ~ /\\.(?!well-known/) {
        deny all;
    }
`
      : '';
    return `server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    root ${root};
    index index.html;
${dotfiles}
    location / {
        try_files $uri $uri/ =404;
    }
}
`;
  }
  if (type === 'laravel-fpm') {
    // Laravel on PHP-FPM running on this server (the config from the Laravel deployment docs).
    return `server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    root ${root};
    index index.php;
    charset utf-8;
    client_max_body_size 100m;

    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-Content-Type-Options "nosniff";

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location = /favicon.ico { access_log off; log_not_found off; }
    location = /robots.txt  { access_log off; log_not_found off; }

    error_page 404 /index.php;

    location ~ ^/index\\.php(/|$) {
        fastcgi_pass unix:${fpmSocket};
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
        include fastcgi_params;
        fastcgi_hide_header X-Powered-By;
    }

    location ~ /\\.(?!well-known).* {
        deny all;
    }
}
`;
  }
  if (type === 'nextjs' || type === 'laravel') {
    // An app that serves HTTP itself on a local port: Next.js (next start / standalone), or
    // Laravel in a container or under Octane. Both need the original host and scheme passed on.
    const next = type === 'nextjs';
    return `server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    client_max_body_size ${next ? '20m' : '100m'};

    location / {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Port $server_port;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";${
          next
            ? `
        # Let streamed responses (server components, route handlers) reach the browser as they are produced.
        proxy_buffering off;`
            : ''
        }
        proxy_read_timeout 300s;
    }
}
`;
  }
  if (type === 'app-websocket') {
    // An app on one port plus a separate Node.js WebSocket server (ws, Socket.IO, ...) on another,
    // reached through a path on the same domain. WebSocket connections are long-lived, so the
    // socket location gets long timeouts and no buffering. nginx only needs the ports; the folders
    // each one runs from are recorded as comments, read back by nginx-parse (summary.folders).
    const notes = [appFolder && `# vps-manager app-folder ${appFolder}`, wsFolder && `# vps-manager ws-folder ${wsFolder}`].filter(Boolean);
    return `${notes.length ? `${notes.join('\n')}\n` : ''}server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    client_max_body_size 50m;

    location ${wsPath} {
        proxy_pass http://127.0.0.1:${wsPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
`;
  }
  return `server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    client_max_body_size 50m;

    location / {
        proxy_pass http://127.0.0.1:${upstreamPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}
`;
}

// Site types whose app listens on a local port, and where the search for a free port starts.
const PORT_TYPES = { proxy: 3000, nextjs: 3000, laravel: 8000, 'app-websocket': 3000 };
// Where the search for a free WebSocket server port starts (app-websocket sites).
const WS_PORT_FROM = 3001;

// Every port that is taken or spoken for: listening sockets, ports nginx configs already
// forward to (an app that is down still owns its port), and ports published by any Docker
// container, running or stopped.
const USED_PORTS = `ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://'
grep -rhoE '(127\\.0\\.0\\.1|localhost|\\[::1\\]):[0-9]+' ${AVAILABLE} ${CONFD} 2>/dev/null | sed 's/.*://'
if command -v docker >/dev/null; then
  docker ps -aq 2>/dev/null | xargs -r docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' 2>/dev/null
fi
true`;

module.exports = (ssh) => {
  const api = {
    async list() {
      const data = await ssh.python(LIST_SCRIPT, { sudo: true });
      for (const s of data.sites) Object.assign(s, { summary: summarize(s.content) });
      return data;
    },

    /** Write a config. The previous version is backed up and restored if nginx -t rejects the new one. */
    async save({ name, kind, content }) {
      const f = filePath(name, kind);
      if (!String(content).trim()) throw new Error('Config is empty');
      const script = `
set -e
f=${q(f)}; b=${q(BACKUPS)}; mkdir -p "$b"
bak="$b/${name}.$(date +%Y%m%d-%H%M%S)"
existed=0
if [ -f "$f" ]; then cp -a "$f" "$bak"; existed=1; fi
cat > "$f"
${TEST_AND_RELOAD('if [ $existed = 1 ]; then cp -a "$bak" "$f"; else rm -f "$f"; fi')}`;
      await ssh.run(script, {
        sudo: true,
        input: content.replace(/\r\n/g, '\n'),
        what: `Back up and write ${f}, test the nginx config, reload nginx (the old file is restored if the test fails)`,
      });
    },

    async enable(name) {
      const f = filePath(name, 'site');
      const link = `${ENABLED}/${name}`;
      await ssh.run(`set -e\nln -sfn ${q(f)} ${q(link)}\n${TEST_AND_RELOAD(`rm -f ${q(link)}`)}`, {
        sudo: true,
        what: `Link ${name} into sites-enabled, test the nginx config, reload nginx (the link is removed again if the test fails)`,
      });
    },

    async disable(name) {
      const f = filePath(name, 'site');
      const link = `${ENABLED}/${name}`;
      await ssh.run(`set -e\nrm -f ${q(link)}\n${TEST_AND_RELOAD(`ln -sfn ${q(f)} ${q(link)}`)}`, {
        sudo: true,
        what: `Remove ${name} from sites-enabled, test the nginx config, reload nginx`,
      });
    },

    /** "Delete" moves the file into the backup folder rather than destroying it. */
    async remove({ name, kind }) {
      const f = filePath(name, kind);
      const link = `${ENABLED}/${name}`;
      const script = `
set -e
b=${q(BACKUPS)}; mkdir -p "$b"
bak="$b/${name}.$(date +%Y%m%d-%H%M%S).deleted"
was=0; [ -L ${q(link)} ] && was=1
rm -f ${q(link)}
mv ${q(f)} "$bak"
${TEST_AND_RELOAD(`mv "$bak" ${q(f)}; if [ $was = 1 ]; then ln -sfn ${q(f)} ${q(link)}; fi`)}`;
      await ssh.run(script, { sudo: true, what: `Move ${f} into ${BACKUPS}, test the nginx config, reload nginx` });
    },

    /** The lowest port >= from that nothing on the server is using or reserved for. */
    async nextPort(from = 3000, { reserved = [] } = {}) {
      const start = port(from);
      const r = await ssh.exec(USED_PORTS, { sudo: true, read: true });
      // reserved: ports promised to deploy projects whose app may not be running yet.
      const used = new Set([...(r.stdout.match(/\d+/g) || []).map(Number), ...reserved.map(Number)]);
      for (let p = start; p <= 65535; p++) {
        if (!used.has(p)) return { port: p, inUse: [...used].filter((n) => n >= start && n < p).sort((a, b) => a - b) };
      }
      throw new Error(`No free port at or above ${start}`);
    },

    /**
     * Create and enable a site from a template. Types: proxy, nextjs, laravel (app on a local
     * port; the next free port is chosen when upstreamPort is omitted), laravel-fpm and static
     * (served from a folder). app-websocket forwards to an app on upstreamPort and a Node.js
     * WebSocket server on wsPort under wsPath (default /ws); either port is picked when omitted.
     * appFolder / wsFolder (optional) record where each runs from, as comments in the config.
     * Resolves { name, type, upstreamPort?, wsPort?, wsPath?, root? }.
     */
    async create({ name, type, domains, upstreamPort, root, hideDotfiles, reserved, wsPort, wsPath, appFolder, wsFolder }) {
      if (!['proxy', 'nextjs', 'laravel', 'laravel-fpm', 'static', 'app-websocket'].includes(type)) throw new Error(`Unknown site type "${type}"`);
      check('siteName', name);
      const list = (Array.isArray(domains) ? domains : String(domains).split(/[\s,]+/)).filter(Boolean).map((d) => check('domain', d));
      if (!list.length) throw new Error('Enter at least one domain');
      const existing = await ssh.exec(`test -e ${q(`${AVAILABLE}/${name}`)}`, { sudo: true, read: true });
      if (existing.code === 0) throw new Error(`A site named "${name}" already exists`);
      const spec = { type, domains: list, hideDotfiles: !!hideDotfiles };
      if (type in PORT_TYPES) {
        spec.upstreamPort = upstreamPort == null ? (await api.nextPort(PORT_TYPES[type], { reserved })).port : port(upstreamPort);
      } else {
        spec.root = check('absPath', root).replace(/\/+$/, '');
      }
      if (type === 'app-websocket') {
        spec.wsPath = check('urlPath', wsPath == null || wsPath === '' ? '/ws' : wsPath);
        if (spec.wsPath === '/') throw new Error('The WebSocket path cannot be "/" - that is where the app is served');
        spec.wsPort = wsPort == null ? (await api.nextPort(WS_PORT_FROM, { reserved: [...(reserved || []), spec.upstreamPort] })).port : port(wsPort);
        if (spec.wsPort === spec.upstreamPort) throw new Error('The app and the WebSocket server need different ports');
        const folder = (v) => (v == null || String(v).trim() === '' ? undefined : check('absPath', v).replace(/\/+$/, '') || '/');
        spec.appFolder = folder(appFolder);
        spec.wsFolder = folder(wsFolder);
      }
      if (type === 'laravel-fpm') {
        // Laravel is served from its public/ folder; accept either the app folder or public/ itself.
        if (!/\/public$/.test(spec.root)) spec.root += '/public';
        const sock = (await ssh.exec('ls -1 /run/php/php*-fpm.sock 2>/dev/null | sort -V | tail -n 1', { sudo: true, read: true })).stdout.trim();
        if (!sock) throw new Error('PHP-FPM is not running on this server (no /run/php/php*-fpm.sock). Install it (for example: apt install php-fpm), or use the "Laravel (app on a port)" type for a Docker or Octane setup.');
        spec.fpmSocket = check('absPath', sock);
      }
      await api.save({ name, kind: 'site', content: template(spec) });
      await api.enable(name);
      return { name, type, upstreamPort: spec.upstreamPort, wsPort: spec.wsPort, wsPath: spec.wsPath, appFolder: spec.appFolder, wsFolder: spec.wsFolder, root: spec.root };
    },

    async test() {
      const r = await ssh.exec('nginx -t 2>&1', { sudo: true, read: true });
      return { ok: r.code === 0, output: r.stdout.trim() };
    },

    async reload() {
      await ssh.run(`set -e\n${TEST_AND_RELOAD(':')}`, { sudo: true, what: 'Test the nginx config and reload nginx if it passes' });
    },

    /** Shell command (run as a streamed job) that issues/renews a Let's Encrypt cert via certbot --nginx. */
    certbotCommand({ domains, email }) {
      const list = domains.map((d) => check('domain', d));
      if (!list.length) throw new Error('No domains to request a certificate for');
      check('email', email);
      return `set -e
if ! command -v certbot >/dev/null; then
  echo "certbot not found - installing..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot python3-certbot-nginx
fi
certbot --nginx --non-interactive --agree-tos --redirect -m ${q(email)} ${list.map((d) => `-d ${q(d)}`).join(' ')}`;
    },
  };
  return api;
};

module.exports.template = template;
module.exports.PORT_TYPES = PORT_TYPES;
