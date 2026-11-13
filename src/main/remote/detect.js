'use strict';
// Work out which folder, repository and branch an nginx site is served from, so auto-deploy can
// be set up for an existing site without typing any of it. Read-only.
//
// A site's targets lead to its folder:
//   - a proxied local port -> the Docker container publishing it -> its compose working dir
//   - a proxied local port -> the (non-Docker) process listening on it -> its working dir
//   - a served root (static files, PHP-FPM) -> that folder
// Each folder is walked up to its git checkout, whose origin remote and branch are read.
// The suggestion itself (`suggest`) is pure JS, so it can be unit-tested.

const { q: quote } = require('../ssh');

// The suggested command is shown and edited by people: quote only what needs it.
const q = (s) => (/^[A-Za-z0-9_./@+=:-]+$/.test(s) ? s : quote(s));

const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

const script = (input) => String.raw`
import json, os, re, subprocess

IN = json.loads(${JSON.stringify(JSON.stringify(input))})
COMPOSE_FILES = ${JSON.stringify(COMPOSE_FILES)}
GIT_ENV = dict(os.environ, GIT_TERMINAL_PROMPT='0', GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='safe.directory', GIT_CONFIG_VALUE_0='*')

def sh(args):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=10, env=GIT_ENV)
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''

def git_root(d):
    d = os.path.realpath(d or '/')
    for _ in range(8):
        if d in ('/', ''):
            return None
        if os.path.exists(os.path.join(d, '.git')):
            return d
        d = os.path.dirname(d)
    return None

found = []
ports = set(IN['ports'])

# 1. Docker containers publishing one of the ports.
docker_ports = set()
names = []
for line in sh(['docker', 'ps', '--format', '{{json .}}']).splitlines():
    try:
        c = json.loads(line)
    except Exception:
        continue
    pub = {int(p) for p in re.findall(r':(\d+)->', c.get('Ports') or '')}
    hit = pub & ports
    if hit:
        docker_ports |= hit
        names.append((c['Names'], sorted(hit)[0]))
for name, port in names:
    try:
        info = json.loads(sh(['docker', 'inspect', name]) or '[]')[0]
    except Exception:
        continue
    labels = (info.get('Config') or {}).get('Labels') or {}
    found.append({'via': 'docker', 'container': name, 'port': port,
                  'path': labels.get('com.docker.compose.project.working_dir'),
                  'composeProject': labels.get('com.docker.compose.project'),
                  'composeService': labels.get('com.docker.compose.service'),
                  'composeFiles': [f for f in (labels.get('com.docker.compose.project.config_files') or '').split(',') if f],
                  'image': (info.get('Config') or {}).get('Image')})

# 2. Other processes listening on one of the ports (node, php, gunicorn, ...).
inodes = {}
for f in ('/proc/net/tcp', '/proc/net/tcp6'):
    try:
        for row in open(f).read().splitlines()[1:]:
            parts = row.split()
            if parts[3] == '0A':
                port = int(parts[1].rsplit(':', 1)[1], 16)
                if port in ports and port not in docker_ports:
                    inodes[parts[9]] = port
    except Exception:
        pass
seen = set()
if inodes:
    for d in os.listdir('/proc'):
        if not d.isdigit():
            continue
        try:
            fds = os.listdir('/proc/%s/fd' % d)
        except Exception:
            continue
        for fd in fds:
            try:
                link = os.readlink('/proc/%s/fd/%s' % (d, fd))
            except Exception:
                continue
            m = re.match(r'socket:\[(\d+)\]$', link)
            if not m or m.group(1) not in inodes or d in seen:
                continue
            seen.add(d)
            try:
                if os.readlink('/proc/%s/root' % d) != '/':
                    continue  # inside a container: its working dir means nothing out here
                exe = os.path.basename(os.readlink('/proc/%s/exe' % d))
                if exe == 'docker-proxy':
                    continue
                cmd = open('/proc/%s/cmdline' % d, 'rb').read().decode('utf-8', 'replace').replace('\0', ' ').strip()
                found.append({'via': 'process', 'pid': int(d), 'exe': exe, 'cmd': cmd[:200], 'port': inodes[m.group(1)],
                              'path': os.readlink('/proc/%s/cwd' % d)})
            except Exception:
                pass

# 3. Folders nginx serves directly.
for r in IN['roots']:
    found.append({'via': 'root', 'path': r})

# Each folder: its git checkout and what is in it.
for f in found:
    p = f.get('path')
    f['exists'] = bool(p) and os.path.isdir(p)
    root = git_root(p) if f['exists'] else None
    f['gitRoot'] = root
    if root:
        f['remote'] = sh(['git', '-C', root, 'config', '--get', 'remote.origin.url'])
        f['branch'] = sh(['git', '-C', root, 'symbolic-ref', '--short', '-q', 'HEAD']) or None
        f['dirty'] = bool(sh(['git', '-C', root, 'status', '--porcelain', '--untracked-files=no']))
        f['compose'] = [n for n in COMPOSE_FILES if os.path.isfile(os.path.join(root, n))]
        f['artisan'] = os.path.isfile(os.path.join(root, 'artisan'))
        f['packageJson'] = os.path.isfile(os.path.join(root, 'package.json'))

print(json.dumps(found))
`;

/** "git@github.com:o/n.git", "https://x@github.com/o/n", "ssh://git@github.com/o/n" -> "o/n"; null if not GitHub. */
function githubSlug(url) {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)(?:www\.)?github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const SOURCE_RANK = { docker: 0, process: 1, root: 2 };
const projectName = (s) =>
  String(s || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 50) || 'app';

/**
 * From what the server reported, pick the folder and fill in a deploy project.
 * Returns { project, source, notes: [{ kind: 'info'|'warn', text }], others: [paths] }.
 */
function suggest(found, { site, ports = [], existing = [] }) {
  const usable = found.filter((f) => f.path);
  usable.sort((a, b) => !!b.gitRoot - !!a.gitRoot || SOURCE_RANK[a.via] - SOURCE_RANK[b.via]);
  const best = usable[0] || null;
  const notes = [];
  const note = (kind, text) => notes.push({ kind, text });
  const others = [...new Set(usable.slice(1).map((f) => f.gitRoot || f.path))].filter((p) => p !== (best && (best.gitRoot || best.path)));

  const port = (best && best.port) || ports[0] || null;
  if (!best) {
    note('warn', ports.length ? `Nothing on the server is listening on port ${ports.join(', ')}, so the folder could not be found. Fill it in below.` : 'This site does not forward to a local port or serve a folder, so the folder could not be found. Fill it in below.');
    const name = uniqueName(projectName(site.replace(/\.[a-z]+$/i, '')), existing);
    return { project: { name, repo: '', branch: 'master', path: `/srv/${name}`, command: '', auto: true, app_port: port }, source: null, notes, others };
  }

  const where =
    best.via === 'docker'
      ? `the Docker container ${best.container}${best.composeProject ? ` (compose project ${best.composeProject})` : ''}, which publishes port ${best.port}`
      : best.via === 'process'
        ? `${best.exe} (pid ${best.pid}), which listens on port ${best.port}`
        : 'the folder nginx serves';
  const dir = best.gitRoot || best.path;
  note('info', `Found ${dir} through ${where}.`);

  const repo = githubSlug(best.remote);
  const branch = best.branch || 'master';
  if (!best.gitRoot) {
    note('warn', `${best.path} is not a git checkout. The agent only clones into a folder that has no checkout yet, and git cannot clone into a folder that already has files, so either clone the repository there yourself first, or deploy to a new folder and point the site at it.`);
  } else if (!best.remote) {
    note('warn', 'The checkout has no "origin" remote. Enter the GitHub repository below.');
  } else if (!repo) {
    note('warn', `Its origin is ${best.remote}, which is not on GitHub. Pushes there cannot trigger the agent.`);
  } else if (/^https?:/i.test(best.remote)) {
    note('info', `It pulls over HTTPS (${best.remote.replace(/\/\/[^@/]+@/, '//')}). With “Add a read-only deploy key” ticked below, saving also switches it to SSH so the key is used.`);
  }
  if (best.gitRoot && !best.branch) note('warn', 'The checkout is not on a branch (detached HEAD). Check the branch below.');
  if (best.dirty) note('warn', 'The checkout has uncommitted changes to tracked files. “git pull --ff-only” refuses to overwrite them, so deploys fail until they are committed or reset.');
  if (best.gitRoot && best.path && best.gitRoot !== best.path && best.via === 'root') note('info', `nginx serves ${best.path}, inside the checkout.`);

  const command = deployCommand(best, branch, notes);
  const base = best.composeProject || (best.gitRoot || best.path).split('/').filter(Boolean).pop() || site;
  const name = uniqueName(projectName(base), existing);
  for (const o of others) note('info', `Also found: ${o}. Change the folder below if that is the right one.`);
  return {
    project: { name, repo: repo || '', branch, path: dir, command, auto: true, app_port: port },
    source: best,
    notes,
    others,
  };
}

/** The deploy command that matches how the app runs now. '' = the agent's default. */
function deployCommand(f, branch, notes) {
  const pull = `git pull --ff-only origin ${branch}`;
  const root = f.gitRoot || f.path;
  if (f.via === 'docker' && f.composeProject) {
    const wd = f.path || root;
    const sub = wd !== root && wd.startsWith(`${root}/`) ? wd.slice(root.length + 1) : null;
    const files = (f.composeFiles || []).map((x) => (x.startsWith(`${wd}/`) ? x.slice(wd.length + 1) : x));
    const defaultFile = files.length === 1 && COMPOSE_FILES.includes(files[0]);
    const dirName = wd.split('/').filter(Boolean).pop();
    // Same project name and files as the running containers, or "up" would start a second copy.
    if (!sub && (defaultFile || !files.length) && f.composeProject === dirName.toLowerCase().replace(/[^a-z0-9_-]/g, '')) return '';
    const fileArgs = defaultFile || !files.length ? '' : ` ${files.map((x) => `-f ${q(x)}`).join(' ')}`;
    notes.push({ kind: 'info', text: `The command keeps the compose project name${fileArgs ? ' and files' : ''} the containers run under now, so a deploy replaces them instead of starting a second copy.` });
    return `${pull} && ${sub ? `cd ${q(sub)} && ` : ''}docker compose -p ${q(f.composeProject)}${fileArgs} up -d --build --remove-orphans`;
  }
  if (f.via === 'docker') {
    notes.push({ kind: 'warn', text: `${f.container} was started without Docker Compose, so there is no command to rebuild it from the checkout. Write the deploy command yourself (e.g. build the image and re-create the container).` });
    return pull;
  }
  if (f.compose && f.compose.length) return '';
  if (f.artisan) {
    notes.push({ kind: 'info', text: 'Laravel without Docker: the command installs dependencies, runs migrations and refreshes the caches. Adjust it if your app needs more (queues, npm build).' });
    return `${pull} && composer install --no-dev --optimize-autoloader --no-interaction && php artisan migrate --force && php artisan optimize`;
  }
  if (f.via === 'process') {
    notes.push({ kind: 'warn', text: `The app runs as ${f.exe} outside Docker. The command below only updates the code${f.packageJson ? ' and builds it' : ''}; add the restart (e.g. “pm2 reload <app>” or “systemctl restart <service>”).` });
    return f.packageJson ? `${pull} && npm ci && npm run build --if-present` : pull;
  }
  return pull; // static files: updating the checkout is the whole deploy
}

function uniqueName(name, existing) {
  const taken = new Set(existing);
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name}-${i}`)) return `${name}-${i}`;
}

/** Ports and folders an nginx site's targets point at (only local ports count). */
function siteTargets(targets) {
  const ports = [];
  const roots = [];
  for (const t of targets || []) {
    const m = /^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)(?:\/|$)/i.exec(t);
    if (m) ports.push(Number(m[1]));
    else if (/^\/[A-Za-z0-9._\/@+-]*$/.test(t) && !t.includes('..')) roots.push(t.replace(/\/+$/, '') || '/');
  }
  return { ports: [...new Set(ports)], roots: [...new Set(roots)] };
}

module.exports = (ssh, nginx, deploy) => ({
  async site({ name, kind = 'site' }) {
    const data = await nginx.list();
    const s = (data.sites || []).find((x) => x.name === name && (x.kind || 'site') === kind);
    if (!s) throw new Error(`nginx site "${name}" not found`);
    const { ports, roots } = siteTargets(s.summary.targets);
    const found = ports.length || roots.length ? await ssh.python(script({ ports, roots }), { sudo: true }) : [];
    const status = await deploy.status().catch(() => null);
    const projects = (status && status.config && status.config.projects) || [];
    const r = suggest(found, { site: name, ports, existing: projects.map((p) => p.name) });
    const same = projects.find((p) => p.path === r.project.path);
    if (same) r.notes.unshift({ kind: 'warn', text: `The deploy project “${same.name}” already deploys ${same.path}. Edit that one on the Auto-deploy screen instead of adding a second.` });
    return { ...r, agentInstalled: !!(status && status.installed), existingProject: same ? same.name : null };
  },
});
module.exports.suggest = suggest;
module.exports.githubSlug = githubSlug;
module.exports.siteTargets = siteTargets;
module.exports.script = script;
