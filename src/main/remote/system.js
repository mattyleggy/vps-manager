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

module.exports = (ssh) => ({
  info: () => ssh.python(INFO_SCRIPT),
});
