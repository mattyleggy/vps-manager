'use strict';

const INFO_SCRIPT = String.raw`
import json, os, shutil, subprocess

def sh(c):
    try:
        return subprocess.run(c, shell=True, capture_output=True, text=True, timeout=10).stdout.strip()
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

mem = {}
for l in open('/proc/meminfo'):
    p = l.split()
    mem[p[0].rstrip(':')] = int(p[1]) * 1024

d = shutil.disk_usage('/')
print(json.dumps({
    'hostname': os.uname().nodename,
    'os': osr.get('PRETTY_NAME', ''),
    'kernel': os.uname().release,
    'uptime': float(open('/proc/uptime').read().split()[0]),
    'load': os.getloadavg(),
    'cpus': os.cpu_count(),
    'mem': {'total': mem.get('MemTotal', 0), 'available': mem.get('MemAvailable', 0)},
    'disk': {'total': d.total, 'used': d.used, 'free': d.free},
    'rebootRequired': os.path.exists('/var/run/reboot-required'),
    'services': {s: sh('systemctl is-active ' + s) or 'not installed' for s in ['nginx', 'docker', 'deploy-agent', 'ufw']},
    'versions': {
        'nginx': sh('command -v nginx >/dev/null && nginx -v 2>&1').replace('nginx version: ', ''),
        'docker': sh('command -v docker >/dev/null && docker --version 2>/dev/null'),
        'certbot': sh('command -v certbot >/dev/null && certbot --version 2>&1'),
    },
    'ips': sh('hostname -I').split(),
}))
`;

// Raw kernel counters for the live graphs. The page samples this every few seconds and
// turns the differences between two samples into rates (CPU %, bytes/s, disk ops/s).
const SAMPLE_SCRIPT = String.raw`
import json, os, re, time
cpu = [int(x) for x in open('/proc/stat').readline().split()[1:]]
mem = {}
for l in open('/proc/meminfo'):
    p = l.split()
    mem[p[0].rstrip(':')] = int(p[1]) * 1024
rx = tx = 0
for l in open('/proc/net/dev').readlines()[2:]:
    name, rest = l.split(':', 1)
    if name.strip() == 'lo' or name.strip().startswith(('veth', 'docker', 'br-')):
        continue
    f = rest.split()
    rx += int(f[0]); tx += int(f[8])
rd = wr = rs = ws = 0
disks = set(os.listdir('/sys/block'))
for l in open('/proc/diskstats'):
    f = l.split()
    if f[2] in disks and not f[2].startswith(('loop', 'ram', 'zram', 'sr')):
        rd += int(f[3]); rs += int(f[5]); wr += int(f[7]); ws += int(f[9])
psi = {}
for k in ('cpu', 'memory', 'io'):
    try:
        m = re.search(r'some avg10=([\d.]+)', open('/proc/pressure/' + k).read())
        psi[k] = float(m.group(1)) if m else None
    except Exception:
        psi[k] = None
print(json.dumps({
    't': time.time(),
    'cpu': cpu,
    'mem': {'total': mem.get('MemTotal', 0), 'available': mem.get('MemAvailable', 0), 'swapTotal': mem.get('SwapTotal', 0), 'swapFree': mem.get('SwapFree', 0)},
    'net': {'rx': rx, 'tx': tx},
    'disk': {'reads': rd, 'writes': wr, 'readBytes': rs * 512, 'writeBytes': ws * 512},
    'load': os.getloadavg(),
    'cpus': os.cpu_count(),
    'psi': psi,
}))
`;

// The last 24 hours of CPU, memory, network, disk and load, from sysstat (sar). sysstat's
// collector writes a sample every few minutes to /var/log/sysstat/saDD; sadf turns those files
// into JSON. Returned as parallel arrays (one entry per sample) to keep the transfer small.
const HISTORY_SCRIPT = String.raw`
import calendar, json, os, re, shutil, subprocess, time

HOURS = 24
now = time.time()
out = {'installed': bool(shutil.which('sadf')), 'enabled': False, 'collecting': False, 'interval': None, 'cpus': os.cpu_count(), 'points': {}}
try:
    out['enabled'] = bool(re.search(r'^ENABLED="?true"?', open('/etc/default/sysstat').read(), re.M))
except Exception:
    out['enabled'] = out['installed']
try:
    out['collecting'] = subprocess.run(['systemctl', 'is-active', 'sysstat-collect.timer'], capture_output=True, text=True, timeout=5).stdout.strip() == 'active'
except Exception:
    pass

files = []
for d in ('/var/log/sysstat', '/var/log/sa'):
    try:
        for n in os.listdir(d):
            p = os.path.join(d, n)
            if re.match(r'^sa\d+$', n) and os.path.getmtime(p) > now - (HOURS + 2) * 3600:
                files.append(p)
    except Exception:
        pass
files.sort(key=os.path.getmtime)

keys = ['t', 'cpu', 'iowait', 'steal', 'mem', 'swap', 'rx', 'tx', 'rd', 'wr', 'rio', 'wio', 'l1']
pts = {k: [] for k in keys}
SKIP = ('lo', 'veth', 'docker', 'br-', 'virbr')
intervals = []
for f in files if out['installed'] else []:
    try:
        r = subprocess.run(['sadf', '-j', f, '--', '-u', '-r', '-S', '-b', '-q', '-n', 'DEV'], capture_output=True, text=True, timeout=30)
        stats = json.loads(r.stdout)['sysstat']['hosts'][0].get('statistics', [])
    except Exception:
        continue
    for s in stats:
        ts = s.get('timestamp') or {}
        try:
            tt = time.strptime(ts['date'] + ' ' + ts['time'], '%Y-%m-%d %H:%M:%S')
        except Exception:
            continue
        t = calendar.timegm(tt) if ts.get('utc', 1) else time.mktime(tt)
        if t < now - HOURS * 3600 or (pts['t'] and t <= pts['t'][-1]):
            continue
        cpu = next((c for c in s.get('cpu-load', []) if str(c.get('cpu')) in ('all', '-1')), None)
        if cpu is None:
            continue
        mem = s.get('memory', {})
        io = s.get('io', {})
        q = s.get('queue', {})
        rx = tx = 0.0
        for n in (s.get('network', {}) or {}).get('net-dev', []):
            if not str(n.get('iface', '')).startswith(SKIP):
                rx += n.get('rxkB', 0) * 1024
                tx += n.get('txkB', 0) * 1024
        rd = io.get('io-reads', {})
        wr = io.get('io-writes', {})
        if ts.get('interval'):
            intervals.append(ts['interval'])
        row = {
            't': t,
            'cpu': round(100 - cpu.get('idle', 100), 2),
            'iowait': cpu.get('iowait', 0),
            'steal': cpu.get('steal', 0),
            'mem': mem.get('memused-percent', 0),
            'swap': mem.get('swpused-percent', 0),
            'rx': round(rx), 'tx': round(tx),
            'rd': round(rd.get('bread', 0) * 512), 'wr': round(wr.get('bwrtn', 0) * 512),
            'rio': rd.get('rtps', 0), 'wio': wr.get('wtps', 0),
            'l1': q.get('ldavg-1', 0),
        }
        for k in keys:
            pts[k].append(row[k])
if intervals:
    intervals.sort()
    out['interval'] = intervals[len(intervals) // 2]
out['points'] = pts
print(json.dumps(out))
`;

// Install sysstat and have it take a sample every 2 minutes (its default is every 10).
const ENABLE_HISTORY = `set -e
if ! command -v sadf >/dev/null; then
  echo "Installing sysstat..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sysstat
fi
if [ -f /etc/default/sysstat ]; then sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat; fi
mkdir -p /etc/systemd/system/sysstat-collect.timer.d
printf '[Timer]\\nOnCalendar=\\nOnCalendar=*:00/2\\n' > /etc/systemd/system/sysstat-collect.timer.d/vps-manager.conf
systemctl daemon-reload
systemctl enable --now sysstat
systemctl enable sysstat-collect.timer
systemctl restart sysstat-collect.timer
echo "sysstat is collecting a sample every 2 minutes. The 24-hour graphs fill in from now on."`;

module.exports = (ssh) => ({
  info: () => ssh.python(INFO_SCRIPT),
  sample: () => ssh.python(SAMPLE_SCRIPT, { timeout: 15000 }),
  history: () => ssh.python(HISTORY_SCRIPT, { timeout: 60000 }),
  ENABLE_HISTORY,
});
