'use strict';
// What is being deployed or built on the server right now. Read-only.
//
// One python script reads /proc on the server; the classification below is plain JS so it can
// be unit-tested. Sources:
//   - deploy-agent deploys (push or "Deploy now"): every command the agent runs carries
//     DEPLOY_PROJECT in its environment, so they are found whatever the deploy command is.
//   - anything started by hand or by another tool: docker builds, compose up/pull, image pulls,
//     git clone/pull, certbot, apt/dpkg, incoming scp/rsync - recognised by their command line.
//   - containers that are still coming up: restarting, health "starting", or up for under a minute.

const LOGS = '/var/log/deploy-agent';

const SCRIPT = String.raw`
import json, os, re, subprocess, time

LOGS = '${LOGS}'
INTERESTING = re.compile(r'(^|/)(docker|docker-compose|docker-buildx|git|certbot|apt|apt-get|dpkg|unattended-upgrade|scp|rsync|python3?)$')
ticks = os.sysconf('SC_CLK_TCK')
uptime = float(open('/proc/uptime').read().split()[0])
now = time.time()
me = os.getpid()

parents = {}
procs = []
for d in os.listdir('/proc'):
    if not d.isdigit():
        continue
    pid = int(d)
    try:
        stat = open('/proc/%d/stat' % pid).read()
        rest = stat[stat.rindex(')') + 2:].split()
        ppid = int(rest[1])
        parents[pid] = ppid
        argv = [a for a in open('/proc/%d/cmdline' % pid, 'rb').read().decode('utf-8', 'replace').split('\0') if a]
    except Exception:
        continue
    if not argv:
        continue
    project = None
    try:
        for kv in open('/proc/%d/environ' % pid, 'rb').read().split(b'\0'):
            if kv.startswith(b'DEPLOY_PROJECT='):
                project = kv[15:].decode('utf-8', 'replace')
                break
    except Exception:
        pass
    exe = os.path.basename(argv[0])
    if not project and not INTERESTING.search(argv[0]) and not (len(argv) > 1 and INTERESTING.search(argv[1])):
        continue
    try:
        cwd = os.readlink('/proc/%d/cwd' % pid)
    except Exception:
        cwd = None
    procs.append({'pid': pid, 'ppid': ppid, 'elapsed': max(0, uptime - int(rest[19]) / ticks),
                  'args': ' '.join(argv)[:400], 'cwd': cwd, 'project': project})

# Never report this scan itself, nor the shell that started it.
mine = set()
p = me
while p and p not in mine:
    mine.add(p)
    p = parents.get(p, 0)
procs = [x for x in procs if x['pid'] not in mine]

# For agent deploys: the log being written and what the log says started it.
deploys = {}
names = {x['project'] for x in procs if x['project']}
for x in procs:
    m = re.search(r'deploy-agent\.py run (\S+)', x['args'])
    if m:
        names.add(m.group(1))
for name in names:
    info = {'log': None, 'started': None, 'trigger': None, 'commit': None, 'branch': None}
    try:
        d = os.path.join(LOGS, name)
        logs = sorted(f for f in os.listdir(d) if f.endswith('.log'))
        if logs:
            info['log'] = os.path.join(d, logs[-1])
            info['started'] = time.mktime(time.strptime(logs[-1][:-4], '%Y%m%d-%H%M%S'))
            head = open(info['log'], errors='replace').readline()
            m = re.search(r'deploying \S+ \((.*?), trigger: (\S+?)(?: (\w+))?\)', head)
            if m:
                info['branch'], info['trigger'], info['commit'] = m.group(1), m.group(2), m.group(3)
    except Exception:
        pass
    deploys[name] = info

containers = []
try:
    r = subprocess.run(['docker', 'ps', '-a', '--format', '{{json .}}'], capture_output=True, text=True, timeout=8)
    for line in r.stdout.splitlines():
        if line.startswith('{'):
            c = json.loads(line)
            containers.append({'name': c.get('Names'), 'image': c.get('Image'), 'state': c.get('State'),
                               'status': c.get('Status'), 'labels': c.get('Labels', '')})
except Exception:
    containers = None

history = []
try:
    lines = open(os.path.join(LOGS, 'history.jsonl')).read().splitlines()[-8:]
    history = [json.loads(l) for l in lines if l.strip()][::-1]
except Exception:
    pass

# Each project's GitHub repository, so a finished deploy's commit can link to it.
repos = {}
try:
    for p in json.load(open('/etc/deploy-agent/config.json')).get('projects', []):
        if p.get('name') and p.get('repo'):
            repos[p['name']] = p['repo']
except Exception:
    pass

print(json.dumps({'now': now, 'parents': parents, 'procs': procs, 'deploys': deploys, 'containers': containers, 'history': history, 'repos': repos}))
`;

/** Command-line patterns, most specific first. `null` kind = ignore (housekeeping, not a deploy). */
const RULES = [
  [/deploy-agent\.py (serve|env|version)\b/, null],
  [/deploy-agent\.py run (\S+)/, 'agent'],
  [/\bdocker(-buildx)? (buildx )?(build|bake)\b|\bdocker buildx build\b|\bdocker-buildx (build|bake)\b/, 'build', 'Docker build'],
  // "up" only when it returns on its own (-d / --build / --wait): a foreground "up" runs for good.
  [/\bdocker[- ]compose\b.*\s(build|pull|create|restart)\b|\bdocker[- ]compose\b.*\sup\b.*\s(-d|--detach|--build|--wait)\b/, 'compose', 'Docker Compose'],
  [/\bdocker (image )?pull\b/, 'pull', 'Image pull'],
  [/\bgit (clone|pull|fetch|checkout|reset)\b/, 'git', 'Git'],
  [/\bcertbot\b/, 'certbot', 'Certificate (certbot)'],
  // Not "unattended-upgrade-shutdown --wait-for-signal": that one idles for as long as the server is up.
  [/\bunattended-upgrade(\s|$)/, 'apt', 'System updates'],
  [/(^|\/)(apt|apt-get) .*\b(install|upgrade|dist-upgrade|full-upgrade|remove|purge|update)\b|(^|\/)dpkg\b/, 'apt', 'System packages'],
  [/(^|\/)scp\b.*\s-t\b|(^|\/)rsync .*--server\b/, 'upload', 'File upload'],
];

function classify(args) {
  for (const [re, kind, label] of RULES) {
    const m = re.exec(args);
    if (m) return kind ? { kind, label, project: kind === 'agent' ? m[1] : null } : { kind: null };
  }
  return null;
}

/**
 * Container states that mean a rollout is still settling. Compose labels name the project.
 */
function settling(containers) {
  return (containers || [])
    .filter((c) => c.state === 'restarting' || c.state === 'created' || /health: starting/.test(c.status || '') || (c.state === 'running' && /^Up (Less than a second|\d+ seconds?)\b/.test(c.status || '')))
    .map((c) => ({
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      project: (/(?:^|,)com\.docker\.compose\.project=([^,]*)/.exec(c.labels || '') || [])[1] || '',
    }));
}

/**
 * Turn the raw scan into a list of activities. Processes nested under another matched process
 * become its steps (a deploy's git pull and docker build show under the deploy, not on their own).
 * Pure: exported for tests.
 */
function summarize(raw) {
  const parents = raw.parents || {};
  const procs = (raw.procs || [])
    .map((p) => {
      const own = classify(p.args);
      // Inside an agent deploy every command belongs to it; what it is doing is its own kind.
      if (p.project) return { ...p, kind: 'agent', label: 'Deploy', project: p.project, step: (own && own.kind) || 'agent' };
      return own && own.kind ? { ...p, ...own, step: own.kind } : null;
    })
    .filter(Boolean);
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  // The outermost matched ancestor of each process. Agent deploys group by project instead,
  // because a push deploy's commands hang off the long-running agent, which is not itself shown.
  const rootOf = (p) => {
    let root = p;
    const seen = new Set();
    for (let q = parents[p.pid]; q && !seen.has(q); q = parents[q]) {
      seen.add(q);
      if (byPid.has(q)) root = byPid.get(q);
    }
    return root;
  };
  const groups = new Map();
  for (const p of procs) {
    const root = rootOf(p);
    const key = root.kind === 'agent' ? `agent:${root.project}` : p.kind === 'agent' ? `agent:${p.project}` : `pid:${root.pid}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const active = [];
  for (const [key, members] of groups) {
    // Oldest first: the root started first; the newest member is what is happening now.
    members.sort((a, b) => b.elapsed - a.elapsed);
    const root = members.find((m) => m.kind === 'agent') || members[0];
    const newest = members[members.length - 1];
    const item = {
      key,
      kind: root.kind,
      label: root.label,
      project: root.project || null,
      elapsed: members[0].elapsed,
      command: root.args,
      current: members.length > 1 || root.kind === 'agent' ? newest.args : null,
      currentKind: newest.step,
      cwd: (newest.cwd !== '/' && newest.cwd) || root.cwd || null,
      pids: members.map((m) => m.pid),
    };
    if (root.kind === 'agent') {
      const d = (raw.deploys || {})[root.project] || {};
      item.log = d.log || null;
      item.trigger = d.trigger || null;
      item.commit = d.commit || null;
      item.branch = d.branch || null;
      if (d.started && raw.now) item.elapsed = Math.max(item.elapsed, raw.now - d.started);
      // The python process of "Deploy now" is only the wrapper: show the deploy command instead.
      if (/deploy-agent\.py run/.test(item.command)) item.command = members.length > 1 ? members[1].args : item.command;
    }
    active.push(item);
  }
  active.sort((a, b) => (b.kind === 'agent') - (a.kind === 'agent') || b.elapsed - a.elapsed);

  return {
    active,
    settling: settling(raw.containers),
    dockerAvailable: raw.containers != null,
    recent: (raw.history || []).slice(0, 6).map((e) => ({ ...e, repo: (raw.repos || {})[e.project] || null })),
    now: raw.now,
  };
}

// The whole deploy history. The agent appends one line per deploy to history.jsonl and never
// trims it (only the per-project logs are pruned, to the newest 30), so this goes back to the
// first deploy. Bounded to the newest HISTORY_MAX lines so a very old server stays quick.
const HISTORY_MAX = 5000;
const HISTORY_SCRIPT = String.raw`
import json, os
LOGS = '${LOGS}'
entries = []
try:
    lines = open(os.path.join(LOGS, 'history.jsonl'), errors='replace').read().splitlines()
    total = len(lines)
    for l in lines[-${HISTORY_MAX}:]:
        try:
            if l.strip():
                entries.append(json.loads(l))
        except Exception:
            pass
except Exception:
    total = 0
projects = {}
try:
    for p in json.load(open('/etc/deploy-agent/config.json')).get('projects', []):
        if p.get('name'):
            projects[p['name']] = {'repo': p.get('repo') or None, 'branch': p.get('branch') or None}
except Exception:
    pass
# Which logs are still on disk: older ones are pruned by the agent.
logs = []
for e in entries:
    if e.get('log') and os.path.isfile(e['log']):
        logs.append(e['log'])
print(json.dumps({'entries': entries, 'total': total, 'projects': projects, 'logs': logs}))
`;

/**
 * Shape the raw history for the Deployments screen: every deploy newest first, each with its
 * repository, and a per-repository breakdown. A project that no longer exists keeps its deploys,
 * grouped under its own name. `repo` filters to one repository (its key from `repos`).
 * Pure: exported for tests.
 */
function summarizeHistory(raw, { repo = null, offset = 0, limit = 100 } = {}) {
  const projects = raw.projects || {};
  const logs = new Set(raw.logs || []);
  const keyOf = (project) => (projects[project] && projects[project].repo) || `project:${project}`;
  const all = (raw.entries || [])
    .filter((e) => e && e.project)
    .map((e) => ({ ...e, repo: (projects[e.project] && projects[e.project].repo) || null, repoKey: keyOf(e.project), logKept: !!e.log && logs.has(e.log) }))
    .sort((a, b) => (b.started || 0) - (a.started || 0));

  const groups = new Map();
  for (const e of all) {
    let g = groups.get(e.repoKey);
    if (!g) {
      g = { key: e.repoKey, repo: e.repo, removed: !projects[e.project], projects: [], deploys: 0, succeeded: 0, failed: 0, lastStarted: null, lastCode: null, totalTime: 0, timed: 0 };
      groups.set(e.repoKey, g);
    }
    if (!g.projects.includes(e.project)) g.projects.push(e.project);
    g.deploys++;
    if (e.code === 0) g.succeeded++;
    else g.failed++;
    if (g.lastStarted == null) {
      g.lastStarted = e.started || null; // `all` is newest first
      g.lastCode = e.code;
    }
    if (e.finished && e.started && e.finished >= e.started) {
      g.totalTime += e.finished - e.started;
      g.timed++;
    }
  }
  // Configured repositories with no deploys yet are listed too, so every repo can be picked.
  for (const [name, p] of Object.entries(projects)) {
    const key = keyOf(name);
    if (!groups.has(key)) groups.set(key, { key, repo: p.repo || null, removed: false, projects: [name], deploys: 0, succeeded: 0, failed: 0, lastStarted: null, lastCode: null, totalTime: 0, timed: 0 });
    else if (!groups.get(key).projects.includes(name)) groups.get(key).projects.push(name);
  }
  const repos = [...groups.values()]
    .map(({ totalTime, timed, ...g }) => ({ ...g, avgTime: timed ? totalTime / timed : null }))
    .sort((a, b) => (b.lastStarted || 0) - (a.lastStarted || 0) || a.key.localeCompare(b.key));

  const filtered = repo ? all.filter((e) => e.repoKey === repo) : all;
  const off = Math.max(0, Math.trunc(offset) || 0);
  const lim = Math.min(1000, Math.max(1, Math.trunc(limit) || 100));
  return {
    entries: filtered.slice(off, off + lim),
    matching: filtered.length,
    offset: off,
    repos,
    // More deploys on record than were read (only the newest HISTORY_MAX are).
    truncated: (raw.total || 0) > all.length && (raw.total || 0) > HISTORY_MAX,
  };
}

module.exports = (ssh) => ({
  async list() {
    return summarize(await ssh.python(SCRIPT, { sudo: true, timeout: 20000 }));
  },
  async history(opts = {}) {
    return summarizeHistory(await ssh.python(HISTORY_SCRIPT, { sudo: true, timeout: 30000 }), opts);
  },
});
module.exports.summarize = summarize;
module.exports.summarizeHistory = summarizeHistory;
module.exports.classify = classify;
