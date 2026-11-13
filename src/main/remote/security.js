'use strict';
// Security screens: the git checkouts on the server with the dependencies their lockfiles pin
// (checked against OSV.dev by src/main/osv.js), and the apt updates the server is waiting on.
// Both scans are read-only.

// Finds git checkouts under the usual app folders (plus every deploy project's folder), and
// reads the lockfiles in each one. Lockfiles are parsed here so only name/version pairs travel.
const REPOS_SCRIPT = String.raw`
import base64, json, os, re, subprocess

ONLY = ''  # set to one checkout's path to scan just that repository

ROOTS = ['/opt', '/srv', '/var/www', '/home', '/root', '/usr/local/src', '/app', '/apps']
REPO_DEPTH = 5
LOCK_DEPTH = 4
SKIP = {'node_modules', 'vendor', '.git', '.cache', '.npm', '.yarn', '.pnpm-store', 'venv', '.venv', 'env',
        '__pycache__', 'site-packages', 'dist', 'build', '.next', '.nuxt', 'target', 'storage', 'bower_components'}
LOCKS = {
    'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'yarn.lock': 'npm', 'pnpm-lock.yaml': 'npm',
    'composer.lock': 'Packagist', 'Pipfile.lock': 'PyPI', 'poetry.lock': 'PyPI', 'uv.lock': 'PyPI',
    'Cargo.lock': 'crates.io', 'Gemfile.lock': 'RubyGems', 'go.mod': 'Go',
}
MAX_PACKAGES = 20000

projects = {}
try:
    for p in json.load(open('/etc/deploy-agent/config.json')).get('projects', []):
        if p.get('path'):
            projects[os.path.realpath(p['path'])] = p.get('name')
except Exception:
    pass

def git(path, *args):
    try:
        r = subprocess.run(['git', '-c', 'safe.directory=*', '-C', path] + list(args), capture_output=True, text=True, timeout=15)
        return r.stdout.strip() if r.returncode == 0 else ''
    except Exception:
        return ''

def redact(url):
    # https://user:token@github.com/x -> https://github.com/x (tokens never leave the server)
    return re.sub(r'^(\w+://)[^/@]+@', r'\1', url)

def find_repos():
    found = []
    seen = set()
    roots = [r for r in ROOTS if os.path.isdir(r)] + [p for p in projects if os.path.isdir(p)]
    for root in roots:
        base = root.rstrip('/').count('/')
        for d, dirs, files in os.walk(root, followlinks=False):
            real = os.path.realpath(d)
            if '.git' in dirs or '.git' in files:
                if real not in seen:
                    seen.add(real)
                    found.append(real)
                dirs[:] = []
                continue
            if d.count('/') - base >= REPO_DEPTH:
                dirs[:] = []
                continue
            dirs[:] = [x for x in dirs if x not in SKIP and not x.startswith('.')]
    return sorted(found)

def parse_npm_lock(text):
    data = json.loads(text)
    out = set()
    if isinstance(data.get('packages'), dict):
        for key, v in data['packages'].items():
            if not key or v.get('link') or not v.get('version'):
                continue
            name = v.get('name') or key.split('node_modules/')[-1]
            out.add((name, v['version']))
    else:
        def walk(deps):
            for name, v in (deps or {}).items():
                if isinstance(v, dict):
                    if v.get('version') and not str(v['version']).startswith(('file:', 'link:', 'git')):
                        out.add((name, v['version']))
                    walk(v.get('dependencies'))
        walk(data.get('dependencies'))
    return out

def parse_yarn(text):
    out = set()
    names = []
    for line in text.splitlines():
        if not line or line.startswith('#'):
            continue
        if not line.startswith(' '):
            names = []
            if line.startswith('__metadata'):
                continue
            for spec in line.rstrip(':').split(','):
                spec = spec.strip().strip('"')
                if '@workspace:' in spec or '@link:' in spec or '@portal:' in spec or '@file:' in spec:
                    continue
                if '@' in spec[1:]:
                    names.append(spec[:spec.index('@', 1)])
            continue
        m = re.match(r'^\s+version:?\s+"?([^"\s]+)"?', line)
        if m and names:
            out.add((names[0], m.group(1)))
            names = []
    return out

def parse_pnpm(text):
    out = set()
    section = None
    for line in text.splitlines():
        if line and not line.startswith(' '):
            section = line.rstrip(':').strip()
            continue
        if section not in ('packages', 'snapshots'):
            continue
        m = re.match(r"^  ['\"]?/?([^'\"\s]+?)['\"]?:\s*$", line)
        if not m:
            continue
        key = re.sub(r'\(.*$', '', m.group(1))
        if '@' in key[1:]:
            i = key.rindex('@')
            name, ver = key[:i], key[i + 1:]
        elif '/' in key[1:]:
            name, ver = key.rsplit('/', 1)
        else:
            continue
        if re.match(r'^\d', ver):
            out.add((name, ver))
    return out

def parse_composer(text):
    data = json.loads(text)
    out = set()
    for p in (data.get('packages') or []) + (data.get('packages-dev') or []):
        v = str(p.get('version', ''))
        if p.get('name') and v and not v.startswith('dev-'):
            out.add((p['name'], v[1:] if re.match(r'^v\d', v) else v))
    return out

def parse_pipfile(text):
    data = json.loads(text)
    out = set()
    for sec in ('default', 'develop'):
        for name, v in (data.get(sec) or {}).items():
            ver = str(v.get('version', '')) if isinstance(v, dict) else ''
            if ver.startswith('=='):
                out.add((name, ver[2:]))
    return out

def parse_toml_packages(text, need_source=False):
    # [[package]] blocks with name = "..." / version = "..." (poetry.lock, uv.lock, Cargo.lock)
    out = set()
    for block in re.split(r'^\[\[package\]\]\s*$', text, flags=re.M)[1:]:
        block = re.split(r'^\[', block, maxsplit=1, flags=re.M)[0]
        n = re.search(r'^name\s*=\s*"([^"]+)"', block, re.M)
        v = re.search(r'^version\s*=\s*"([^"]+)"', block, re.M)
        if not n or not v:
            continue
        if need_source and not re.search(r'^source\s*=', block, re.M):
            continue  # a crate of this workspace, not a dependency
        if re.search(r'^source\s*=\s*\{\s*(editable|virtual|directory)', block, re.M):
            continue  # uv: the project itself
        out.add((n.group(1), v.group(1)))
    return out

def parse_requirements(text):
    out = set()
    for line in text.splitlines():
        m = re.match(r'^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([^\s;#]+)', line)
        if m:
            out.add((m.group(1), m.group(3)))
    return out

def parse_gemfile(text):
    out = set()
    in_gem = False
    for line in text.splitlines():
        if line and not line.startswith(' '):
            in_gem = line.strip() == 'GEM'
            continue
        m = in_gem and re.match(r'^    ([A-Za-z0-9_.-]+) \(([^)\s]+)\)\s*$', line)
        if m:
            ver = re.sub(r'-(x86|x64|aarch64|arm|universal|java|mingw|mswin|darwin|linux).*$', '', m.group(2))
            out.add((m.group(1), ver))
    return out

def parse_gomod(text):
    out = set()
    block = False
    for line in text.splitlines():
        s = line.split('//')[0].strip()
        if s.startswith('require ('):
            block = True
            continue
        if block and s == ')':
            block = False
            continue
        if s.startswith('require '):
            s = s[len('require '):].strip()
        elif not block:
            continue
        parts = s.split()
        if len(parts) >= 2 and parts[1].startswith('v'):
            out.add((parts[0], parts[1]))
    return out

def parse(name, text):
    if name in ('package-lock.json', 'npm-shrinkwrap.json'): return parse_npm_lock(text)
    if name == 'yarn.lock': return parse_yarn(text)
    if name == 'pnpm-lock.yaml': return parse_pnpm(text)
    if name == 'composer.lock': return parse_composer(text)
    if name == 'Pipfile.lock': return parse_pipfile(text)
    if name in ('poetry.lock', 'uv.lock'): return parse_toml_packages(text)
    if name == 'Cargo.lock': return parse_toml_packages(text, need_source=True)
    if name == 'Gemfile.lock': return parse_gemfile(text)
    if name == 'go.mod': return parse_gomod(text)
    if re.match(r'^requirements.*\.txt$', name): return parse_requirements(text)
    return set()

def lockfiles(repo):
    out = []
    base = repo.rstrip('/').count('/')
    for d, dirs, files in os.walk(repo, followlinks=False):
        if d.count('/') - base >= LOCK_DEPTH:
            dirs[:] = []
        dirs[:] = sorted(x for x in dirs if x not in SKIP and not x.startswith('.'))
        for f in sorted(files):
            eco = LOCKS.get(f) or ('PyPI' if re.match(r'^requirements.*\.txt$', f) else None)
            if not eco:
                continue
            p = os.path.join(d, f)
            entry = {'file': os.path.relpath(p, repo), 'ecosystem': eco, 'packages': []}
            try:
                if os.path.getsize(p) > 50 * 1024 * 1024:
                    raise ValueError('file is too large to read')
                entry['packages'] = sorted([list(x) for x in parse(f, open(p, encoding='utf-8', errors='replace').read())])
            except Exception as e:
                entry['error'] = str(e)[:200]
            out.append(entry)
    return out

repos = []
total = 0
if ONLY:
    ONLY = os.path.realpath(ONLY)
    if not os.path.exists(os.path.join(ONLY, '.git')):
        print(json.dumps({'error': ONLY + ' is no longer a git checkout'}))
        raise SystemExit(0)
for path in ([ONLY] if ONLY else find_repos()):
    last = git(path, 'log', '-1', '--format=%H%x09%ct%x09%s').split('\t')
    locks = lockfiles(path) if total < MAX_PACKAGES else []
    for l in locks:
        l['packages'] = l['packages'][:max(0, MAX_PACKAGES - total)]
        total += len(l['packages'])
    status = git(path, 'status', '--porcelain', '--untracked-files=no')
    repos.append({
        'path': path,
        'project': projects.get(path),
        'origin': redact(git(path, 'config', '--get', 'remote.origin.url')),
        'branch': git(path, 'rev-parse', '--abbrev-ref', 'HEAD'),
        'commit': last[0][:12] if last and last[0] else '',
        'committed': int(last[1]) if len(last) > 1 and last[1].isdigit() else None,
        'subject': last[2] if len(last) > 2 else '',
        'dirty': len([l for l in status.splitlines() if l.strip()]),
        'lockfiles': locks,
    })
print(json.dumps({'repos': repos, 'truncated': total >= MAX_PACKAGES}))
`;

// What apt would upgrade, which of those come from a -security pocket, whether a reboot is
// pending, and whether unattended-upgrades is installing security fixes on its own.
const UPDATES_SCRIPT = String.raw`
import glob, json, os, re, subprocess

def sh(args, timeout=60):
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout, env=dict(os.environ, LANG='C', LC_ALL='C'))
        return r.stdout
    except Exception:
        return ''

osr = {}
try:
    for l in open('/etc/os-release'):
        if '=' in l:
            k, v = l.rstrip().split('=', 1)
            osr[k] = v.strip('"')
except Exception:
    pass

sources = {}
for line in sh(['dpkg-query', '-W', '-f', '$' '{Package}\t$' '{source:Package}\n']).splitlines():
    p = line.split('\t')
    if len(p) == 2:
        sources[p[0]] = p[1] or p[0]

updates = []
for line in sh(['apt', 'list', '--upgradable']).splitlines():
    m = re.match(r'^(\S+?)/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]', line)
    if not m:
        continue
    name, suites = m.group(1), m.group(2).split(',')
    updates.append({
        'name': name,
        'source': sources.get(name, name),
        'suites': suites,
        'security': any(s.endswith('-security') for s in suites),
        'esm': any('esm' in s for s in suites),
        'available': m.group(3),
        'arch': m.group(4),
        'installed': m.group(5).strip(),
    })

# Packages a plain "apt-get upgrade" would hold back (new dependencies, phased updates).
sim = sh(['apt-get', '-s', '-o', 'Debug::NoLocking=1', 'upgrade'], 120)
kept = []
m = re.search(r'kept back:\n((?:  .*\n)+)', sim)
if m:
    kept = m.group(1).split()

stamps = ['/var/lib/apt/periodic/update-success-stamp'] + glob.glob('/var/lib/apt/lists/*_InRelease') + glob.glob('/var/lib/apt/lists/*_Release')
times = [os.path.getmtime(p) for p in stamps if os.path.exists(p)]

reboot_pkgs = []
try:
    reboot_pkgs = sorted(set(open('/var/run/reboot-required.pkgs').read().split()))
except Exception:
    pass

kernels = sorted((os.path.basename(p)[len('vmlinuz-'):] for p in glob.glob('/boot/vmlinuz-*')), key=lambda v: [int(x) if x.isdigit() else x for x in re.split(r'[.-]', v)])

auto = {'installed': os.path.exists('/usr/bin/unattended-upgrade'), 'enabled': False, 'lastRun': None}
for f in glob.glob('/etc/apt/apt.conf.d/*'):
    try:
        if re.search(r'APT::Periodic::Unattended-Upgrade\s+"(1|true)"', open(f).read()):
            auto['enabled'] = True
    except Exception:
        pass
try:
    log = '/var/log/unattended-upgrades/unattended-upgrades.log'
    auto['lastRun'] = os.path.getmtime(log)
    tail = open(log, errors='replace').read()[-20000:]
    m = re.findall(r'^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+ INFO (All upgrades installed|No packages found that can be upgraded unattended.*|Packages that will be upgraded: .*)$', tail, re.M)
    if m:
        auto['lastResult'] = {'at': m[-1][0], 'text': m[-1][1][:300]}
except Exception:
    pass

print(json.dumps({
    'os': osr.get('PRETTY_NAME', ''),
    'codename': osr.get('VERSION_CODENAME', ''),
    'updates': updates,
    'keptBack': kept,
    'held': sh(['apt-mark', 'showhold']).split(),
    'listsUpdated': max(times) if times else None,
    'rebootRequired': os.path.exists('/var/run/reboot-required'),
    'rebootPackages': reboot_pkgs,
    'runningKernel': os.uname().release,
    'newestKernel': kernels[-1] if kernels else None,
    'unattended': auto,
}))
`;

const APT_ENV = 'export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a';
const DPKG_OPTS = "-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold";

const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'unknown'];
const rank = (s) => SEVERITIES.indexOf(s);

/**
 * Pure: joins the server scan with OSV's answers. Each repo gets its findings (worst first,
 * each with the lockfiles that pin it), counts per severity and a package total; the raw
 * package lists are dropped.
 */
function withFindings(scan, hits) {
  const repos = scan.repos.map((r) => {
    const byKey = new Map();
    let packages = 0;
    const lockfiles = r.lockfiles.map((l) => {
      packages += l.packages.length;
      for (const [name, version] of l.packages) {
        for (const f of hits.get(`${l.ecosystem}\0${name}\0${version}`) || []) {
          const k = `${f.id}\0${f.package}\0${f.version}`;
          if (!byKey.has(k)) byKey.set(k, { ...f, files: [] });
          const e = byKey.get(k);
          if (!e.files.includes(l.file)) e.files.push(l.file);
        }
      }
      return { file: l.file, ecosystem: l.ecosystem, packages: l.packages.length, error: l.error || null };
    });
    const findings = [...byKey.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || a.package.localeCompare(b.package));
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
    const { lockfiles: _drop, ...rest } = r;
    return { ...rest, lockfiles, packages, findings, counts };
  });
  return { repos, truncated: !!scan.truncated };
}

/** The repos script, limited to one checkout when path is given (passed base64 so no quoting can break out). */
function reposScript(path) {
  if (!path) return REPOS_SCRIPT;
  return REPOS_SCRIPT.replace("\nONLY = ''", `\nONLY = base64.b64decode('${Buffer.from(String(path)).toString('base64')}').decode()`);
}

module.exports = (ssh) => ({
  withFindings,
  /** path: scan only that checkout; omitted = find and scan every one. */
  repos: (path) => ssh.python(reposScript(path), { sudo: true, timeout: 180000 }),
  updates: () => ssh.python(UPDATES_SCRIPT, { sudo: true, timeout: 180000 }),
  refreshCommand: () => `${APT_ENV}; apt-get update 2>&1`,
  /** packages: names to upgrade (only these, and only if already installed); none = everything apt would upgrade. */
  upgradeCommand: (packages) =>
    packages && packages.length
      ? `${APT_ENV}; apt-get install -y --only-upgrade ${DPKG_OPTS} ${packages.join(' ')} 2>&1`
      : `${APT_ENV}; apt-get upgrade -y ${DPKG_OPTS} 2>&1`,
  // Detached so the command returns before the connection drops.
  rebootCommand: () => "nohup sh -c 'sleep 2; systemctl reboot' >/dev/null 2>&1 & echo 'Rebooting in 2 seconds. The app reconnects when you press Connect again.'",
});
module.exports.withFindings = withFindings;
module.exports.SEVERITIES = SEVERITIES;
module.exports.REPOS_SCRIPT = REPOS_SCRIPT;
module.exports.reposScript = reposScript;
module.exports.UPDATES_SCRIPT = UPDATES_SCRIPT;
