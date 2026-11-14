'use strict';
// Recent HTTP traffic for one nginx site, read from its access log.
//
// The log is found from the site's own `access_log` directive. A site without one writes to
// the server-wide log set in nginx.conf (usually /var/log/nginx/access.log). The default
// "combined" format does not record the host, so on a shared log the site's lines are picked
// out by grepping for its domain names: they show up in the Referer of most requests (and in
// the host, if a custom format logs it). Direct hits with no referrer cannot be attributed.
// `addSiteLog` gives the site a log of its own, with a size cap enforced by logrotate.

const { check } = require('../validate');
const { q } = require('../ssh');

// A folder of its own: Ubuntu's /etc/logrotate.d/nginx rotates /var/log/nginx/*.log daily, and
// logrotate rejects a file that two configs both match, so per-site logs (with their own size
// cap) live one level down.
const LOG_DIR = '/var/log/nginx/sites';
const MAX_LINES = 5000;
const SIZE_MB = { min: 1, max: 10240, default: 50 };
const KEEP = { min: 0, max: 20, default: 1 };
const ROTATE_STATE = '/var/lib/logrotate/vps-manager.status';

/** Where "Give this site its own log" points the site's access_log. */
const siteLogPath = (name) => `${LOG_DIR}/${check('siteName', name)}.access.log`;
const rotatePath = (name) => `/etc/logrotate.d/vps-manager-site-${check('siteName', name)}`;
// cron ignores files in /etc/cron.d whose names contain dots.
const cronPath = (name) => `/etc/cron.d/vps-manager-log-${check('siteName', name).replace(/\./g, '_')}`;

function intIn(v, { min, max, default: d }, label) {
  if (v == null || v === '') return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}

/**
 * logrotate config for a site log: rotate once it passes maxSizeMb (checked hourly by the cron
 * entry, and by the daily logrotate run), keep `keep` old copies (0 = just empty it), then have
 * nginx reopen its log files.
 */
function rotateConfig(path, { maxSizeMb, keep }) {
  return `# Written by VPS Manager: keeps ${path} under about ${maxSizeMb} MB.
${path} {
    size ${maxSizeMb}M
    rotate ${keep}
    missingok
    notifempty
    compress
    delaycompress
    create 0640 www-data adm
    sharedscripts
    postrotate
        if [ -s /run/nginx.pid ]; then kill -USR1 "$(cat /run/nginx.pid)"; fi
    endscript
}
`;
}
const cronLine = (name) => `# Written by VPS Manager: check the size of ${siteLogPath(name)} every hour.\n17 * * * * root /usr/sbin/logrotate -s ${ROTATE_STATE} ${rotatePath(name)} >/dev/null 2>&1\n`;

const TAIL_SCRIPT = (input) => String.raw`
import json, os, re, time
IN = json.loads(${JSON.stringify(JSON.stringify(input))})
N = IN['lines']

def strip_comments(text):
    return re.sub(r'#[^\n]*', '', text)

def logs_in(text):
    out = []
    for args in re.findall(r'(?:^|[;{}\s])access_log\s+([^;]+);', strip_comments(text)):
        parts = args.split()
        if not parts or parts[0] == 'off' or parts[0].startswith('syslog:') or '$' in parts[0]:
            continue
        path = parts[0] if parts[0].startswith('/') else os.path.join('/usr/share/nginx', parts[0])
        fmt = parts[1] if len(parts) > 1 and '=' not in parts[1] else 'combined'
        if path not in [o['path'] for o in out]:
            out.append({'path': path, 'format': fmt})
    return out

def read(path):
    try:
        return open(path, errors='replace').read()
    except Exception:
        return ''

def tail(path, n, keep=None, limit=8 * 1024 * 1024):
    # The last n lines (only those keep matches, when grepping), reading back from the end,
    # at most limit bytes. Returns (lines oldest first, bytes scanned).
    out, rest, scanned = [], b'', 0
    with open(path, 'rb') as f:
        f.seek(0, 2)
        pos = f.tell()
        while pos > 0 and len(out) < n and scanned < limit:
            step = min(262144, pos)
            pos -= step
            f.seek(pos)
            parts = (f.read(step) + rest).split(b'\n')
            scanned += step
            rest = parts.pop(0) if pos > 0 else b''  # cut off: finished by the next chunk
            for raw in reversed(parts):
                if not raw.strip() or (keep is not None and not keep.search(raw)):
                    continue
                out.append(raw.decode('utf-8', 'replace'))
                if len(out) >= n:
                    break
    return out[::-1], scanned

own = logs_in(read(IN['conf']))
shared = not own
logs = own or logs_in(read('/etc/nginx/nginx.conf')) or [{'path': '/var/log/nginx/access.log', 'format': 'combined'}]
log = logs[0]
grep = None
if shared and IN['match'] == 'site' and IN['domains']:
    # Each domain as a whole name: "a.com" matches "https://a.com/x" but not "data.com" or "a.com.evil".
    names = b'|'.join(re.escape(d.encode()) for d in IN['domains'])
    grep = re.compile(rb'(?<![A-Za-z0-9.-])(?:' + names + rb')(?![A-Za-z0-9-]|\.[A-Za-z0-9])', re.I)
limit = (64 if grep is not None else 8) * 1024 * 1024
res = {'path': log['path'], 'format': log['format'], 'shared': shared, 'others': [l['path'] for l in logs[1:]],
       'exists': os.path.isfile(log['path']), 'lines': [], 'size': 0, 'now': time.time(),
       'grep': grep is not None, 'scanned': 0, 'limit': None}
if res['exists']:
    try:
        res['size'] = os.path.getsize(log['path'])
        lines, scanned = tail(log['path'], N, grep, limit)
        # Just rotated: top up from the previous file so the page isn't empty afterwards.
        if len(lines) < N and scanned < limit and os.path.isfile(log['path'] + '.1'):
            more, extra = tail(log['path'] + '.1', N - len(lines), grep, limit - scanned)
            lines, scanned = more + lines, scanned + extra
        res['lines'], res['scanned'] = lines, scanned
    except Exception as e:
        res['error'] = str(e)
rot = read(IN['rotate'])
size = re.search(r'^\s*size\s+(\d+)M\s*$', rot, re.M)
keep = re.search(r'^\s*rotate\s+(\d+)\s*$', rot, re.M)
if size and log['path'] == IN['ownPath']:
    res['limit'] = {'maxSizeMb': int(size.group(1)), 'keep': int(keep.group(1)) if keep else 0}
print(json.dumps(res))
`;

// ---------------------------------------------------------------- parsing (pure)

// combined: $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent"
// "common" is the same without the last two; anything a custom format appends after them is ignored.
const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const LINE = new RegExp(`^(\\S+) \\S+ (\\S+) \\[([^\\]]+)\\] ${STR} (\\d{3}) (\\d+|-)(?: ${STR} ${STR})?`);
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "13/Nov/2026:10:12:01 +0100" -> epoch ms, or null. */
function parseTime(s) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m || !(m[2] in MONTHS)) return null;
  const offset = (m[7] === '-' ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60000;
  return Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]) - offset;
}

const unescape = (s) => (s == null ? '' : s.replace(/\\x([0-9a-f]{2})/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/\\(.)/g, '$1'));

/** One access-log line -> { ip, user, time, method, path, protocol, status, bytes, referer, agent }, or null. */
function parseLine(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const request = unescape(m[4]);
  const r = /^([A-Z]+) (\S+)(?: (HTTP\/[\d.]+))?$/.exec(request);
  return {
    ip: m[1],
    user: m[2] === '-' ? '' : m[2],
    time: parseTime(m[3]),
    method: r ? r[1] : '',
    path: r ? r[2] : request,
    protocol: r ? r[3] || '' : '',
    status: Number(m[5]),
    bytes: m[6] === '-' ? 0 : Number(m[6]),
    referer: m[7] && m[7] !== '-' ? unescape(m[7]) : '',
    agent: m[8] && m[8] !== '-' ? unescape(m[8]) : '',
  };
}

// Files a browser fetches while rendering a page (scripts, styles, images, fonts, media, source
// maps) and framework asset folders. Any other GET/HEAD, whatever its status, counts as a page
// load: extensionless paths and .html/.php style ones.
const ASSET_EXT = /\.(m?js|css|map|json|xml|txt|webmanifest|png|jpe?g|gif|svg|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|flac|pdf|zip|gz|wasm)$/i;
const ASSET_DIR = /^\/(_next|_nuxt|static|assets|build|dist|wp-content|wp-includes)(\/|$)/i;

/** True when an entry looks like a person loading a page, not the page's assets or an API call. */
function isPageLoad(e) {
  if (e.method && e.method !== 'GET' && e.method !== 'HEAD') return false;
  const path = (e.path || '').split(/[?#]/)[0];
  if (!path.startsWith('/')) return false;
  if (ASSET_DIR.test(path) || /^\/api(\/|$)/i.test(path) || ASSET_EXT.test(path)) return false;
  return true;
}

// Known automated clients, checked in order: [pattern, name]. The first group are crawlers and
// link previewers that say who they are; the second, HTTP libraries and scanners.
const BOTS = [
  [/Googlebot|Google-InspectionTool|GoogleOther|Storebot-Google|AdsBot-Google|Mediapartners-Google|APIs-Google|Google-Extended|FeedFetcher-Google/i, 'Google'],
  [/bingbot|BingPreview|msnbot|adidxbot/i, 'Bing'],
  [/GPTBot|ChatGPT-User|OAI-SearchBot/i, 'OpenAI'],
  [/ClaudeBot|Claude-User|Claude-SearchBot|anthropic-ai/i, 'Anthropic'],
  [/PerplexityBot|Perplexity-User/i, 'Perplexity'],
  [/Applebot/i, 'Apple'],
  [/facebookexternalhit|facebookcatalog|meta-externalagent|meta-externalfetcher|meta-webindexer|FacebookBot/i, 'Meta'],
  [/YandexBot|YandexImages|YandexMetrika/i, 'Yandex'],
  [/Baiduspider/i, 'Baidu'],
  [/DuckDuckBot|DuckAssistBot/i, 'DuckDuckGo'],
  [/Bytespider/i, 'ByteDance'],
  [/Amazonbot/i, 'Amazon'],
  [/AhrefsBot|AhrefsSiteAudit/i, 'Ahrefs'],
  [/SemrushBot|SiteAuditBot/i, 'Semrush'],
  [/Chrome-Lighthouse|Lighthouse/i, 'Lighthouse'],
  [/HeadlessChrome|PhantomJS|Puppeteer|Playwright|Selenium/i, 'Headless browser'],
  [/\bcurl\//i, 'curl'],
  [/\bWget\//i, 'Wget'],
  [/python-requests|python-urllib|aiohttp|httpx|Python\//i, 'Python'],
  [/Go-http-client/i, 'Go'],
  [/\bokhttp|Apache-HttpClient|\bJava\//i, 'Java'],
  [/node-fetch|undici|axios|got \(|Node\.js/i, 'Node.js'],
  [/libwww-perl|\bPHP\/|GuzzleHttp|Ruby|Faraday/i, 'Script'],
  [/zgrab|masscan|Nmap|nuclei|sqlmap|nikto|Censys|Expanse|internet-measurement|Palo Alto|ModatScanner|l9scan|leakix/i, 'Scanner'],
];
// Anything else that names itself a bot, crawler or spider: use that product name.
const SELF_NAMED = /(?<![\w.-])([\w.-]*?(?:bot|crawler|spider|scraper|fetcher|checker|monitor|indexer))(?=[\/;\s)+]|$)/i;
const GENERIC = /\b(bot|crawl|crawler|spider|slurp|scrap|preview|monitor|uptime|archiver|httpclient|indexer)\b/i;
// A full browser string with "(compatible; Name/1.0 …)" tacked on is a crawler borrowing a
// browser's identity (old Internet Explorer also says "compatible; MSIE", which is not a bot).
const COMPATIBLE = /\(compatible;\s*([A-Za-z][\w.-]*)/i;

/**
 * The name of the automated client an access-log user agent belongs to, or '' for what looks like
 * a person's browser. A missing user agent counts as a bot: real browsers always send one.
 */
function botName(agent) {
  const ua = String(agent || '').trim();
  if (!ua || ua === '-') return 'No user agent';
  for (const [re, name] of BOTS) if (re.test(ua)) return name;
  // Product tokens only: a bot named in a URL ("…/webmasters/crawler") is skipped here.
  const own = SELF_NAMED.exec(ua.replace(/https?:\/\/\S*/gi, ''));
  if (own && !/^(Mobile|CriOS)$/i.test(own[1])) return own[1];
  const compat = COMPATIBLE.exec(ua);
  if (compat && !/^(MSIE|Trident)/i.test(compat[1])) return compat[1];
  if (GENERIC.test(ua)) return 'Bot';
  // Real browsers all start with Mozilla/5.0 (or Opera/); anything else is a tool.
  if (!/^(Mozilla\/5\.0|Opera\/)/.test(ua)) return ua.split(/[\/\s;(]/)[0].slice(0, 40) || 'Bot';
  return '';
}

function top(counts, n) {
  return [...counts]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

/**
 * Totals over the parsed entries (oldest first), and a per-minute series for the last
 * `minutes` minutes before `now` (epoch ms).
 */
function stats(entries, now, minutes = 60) {
  const classes = { 2: 0, 3: 0, 4: 0, 5: 0, other: 0 };
  const paths = new Map();
  const ips = new Map();
  let bytes = 0;
  const perMinute = Array.from({ length: minutes }, () => ({ total: 0, errors: 0 }));
  const start = Math.floor(now / 60000) * 60000 - (minutes - 1) * 60000;
  for (const e of entries) {
    const c = Math.floor(e.status / 100);
    if (c in classes) classes[c]++;
    else classes.other++;
    bytes += e.bytes;
    const p = e.path.split('?')[0];
    paths.set(p, (paths.get(p) || 0) + 1);
    ips.set(e.ip, (ips.get(e.ip) || 0) + 1);
    if (e.time != null && e.time >= start) {
      const i = Math.floor((e.time - start) / 60000);
      if (i < minutes) {
        perMinute[i].total++;
        if (e.status >= 400) perMinute[i].errors++;
      }
    }
  }
  const times = entries.map((e) => e.time).filter((t) => t != null);
  const last5 = perMinute.slice(-5).reduce((n, m) => n + m.total, 0);
  return {
    total: entries.length,
    classes,
    bytes,
    uniqueIps: ips.size,
    first: times.length ? Math.min(...times) : null,
    last: times.length ? Math.max(...times) : null,
    perMinuteNow: last5 / 5,
    perMinute: { start, values: perMinute },
    topPaths: top(paths, 10),
    topIps: top(ips, 10),
  };
}

/**
 * Add `access_log <file>;` as the first line inside every top-level `server {` block that has no
 * access_log of its own. Returns the new text, or throws when there is nothing to change.
 */
function addSiteLog(content, name) {
  const file = siteLogPath(name);
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  let depth = 0;
  // Server blocks that already log somewhere (anything but "off" at their own level) keep their setting.
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/#.*/, '');
    if (depth === 0 && /^\s*server\s*\{\s*$/.test(code)) blocks.push({ line: i, logs: false, indent: lines[i].match(/^\s*/)[0] });
    if (depth === 1 && blocks.length && /^\s*access_log\s+(?!off\s*;)\S/.test(code)) blocks[blocks.length - 1].logs = true;
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  if (!blocks.length) throw new Error('No "server {" block found in this config, so there is nowhere to add the log');
  const at = new Map(blocks.filter((b) => !b.logs).map((b) => [b.line, b.indent]));
  if (!at.size) throw new Error('Every server block in this config already has its own access_log');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (at.has(i)) out.push(`${at.get(i)}    access_log ${file};`);
  }
  return out.join('\n');
}

module.exports = (ssh, nginx) => {
  async function findSite(name, kind) {
    const site = ((await nginx.list()).sites || []).find((s) => s.name === name && s.kind === kind);
    if (!site) throw new Error(`No ${kind === 'conf.d' ? 'conf.d' : 'site'} config named "${name}"`);
    return site;
  }
  return {
    /**
     * The last `lines` requests of a site, newest first. On a shared log, match 'site' (the
     * default) keeps only lines that name one of the site's domains; 'all' keeps every line.
     */
    async read({ name, kind = 'site', lines, match = 'site', pages = false, who = 'all' }) {
      const site = await findSite(name, kind);
      // Page loads are a small share of all requests, so read further back for them.
      const n = Math.min(MAX_LINES, Math.max(1, Math.trunc(Number(lines)) || (pages ? MAX_LINES : 1000)));
      const domains = site.summary.domains.filter((d) => !d.startsWith('*.'));
      const input = { conf: site.path, lines: n, domains, match: match === 'all' ? 'all' : 'site', rotate: rotatePath(name), ownPath: siteLogPath(name) };
      const r = await ssh.python(TAIL_SCRIPT(input), { sudo: true });
      const entries = [];
      let unparsed = 0;
      for (const l of r.lines) {
        const e = parseLine(l);
        if (e) entries.push(e);
        else unparsed++;
      }
      const scannedEntries = entries.length;
      for (const e of entries) e.bot = botName(e.agent);
      if (pages || who === 'humans' || who === 'bots') {
        const keep = entries.filter((e) => (!pages || isPageLoad(e)) && (who === 'humans' ? !e.bot : who === 'bots' ? !!e.bot : true));
        entries.splice(0, entries.length, ...keep);
      }
      const now = Math.round(r.now * 1000);
      return {
        site: site.name,
        kind: site.kind,
        domains,
        path: r.path,
        others: r.others,
        format: r.format,
        shared: r.shared,
        // Shared log only: true when just the lines naming one of the site's domains were kept.
        grep: r.grep,
        scanned: r.scanned,
        // The site's own log in LOG_DIR, and its size cap if one is set: { maxSizeMb, keep }.
        canLimit: r.path === siteLogPath(name),
        limit: r.limit,
        exists: r.exists,
        error: r.error || null,
        size: r.size,
        now,
        unparsed,
        // pages: only page loads were kept, out of `read` parsed log lines.
        pages: !!pages,
        who: who === 'humans' || who === 'bots' ? who : 'all',
        read: scannedEntries,
        sample: unparsed && !entries.length ? r.lines.slice(-3) : [],
        stats: stats(entries, now),
        entries: entries.reverse(),
      };
    },

    /**
     * Give a site its own access log, capped at maxSizeMb with `keep` rotated copies; for a site
     * that already logs there, just change the cap. nginx.save backs up, tests and reloads.
     */
    async addSiteLog({ name, kind = 'site', maxSizeMb, keep }) {
      const site = await findSite(name, kind);
      const limit = { maxSizeMb: intIn(maxSizeMb, SIZE_MB, 'Max size (MB)'), keep: intIn(keep, KEEP, 'Old copies to keep') };
      const path = siteLogPath(name);
      const hasIt = site.content.includes(`access_log ${path}`);
      const content = hasIt ? null : addSiteLog(site.content, name); // throws if every block logs elsewhere
      await ssh.run(`mkdir -p ${q(LOG_DIR)} && chown root:adm ${q(LOG_DIR)} && chmod 755 ${q(LOG_DIR)}`, { sudo: true, what: `Create the folder for per-site logs, ${LOG_DIR}` });
      await ssh.writeFile(rotatePath(name), rotateConfig(path, limit), {
        what: `Write ${rotatePath(name)}: rotate ${path} once it passes ${limit.maxSizeMb} MB, keeping ${limit.keep ? `${limit.keep} old compressed cop${limit.keep === 1 ? 'y' : 'ies'}` : 'no old copies'}`,
      });
      await ssh.writeFile(cronPath(name), cronLine(name), { what: `Write ${cronPath(name)}: check the log's size every hour` });
      if (content) await nginx.save({ name, kind, content });
      return { name, path, ...limit, added: !!content };
    },
  };
};

module.exports.parseLine = parseLine;
module.exports.parseTime = parseTime;
module.exports.stats = stats;
module.exports.isPageLoad = isPageLoad;
module.exports.botName = botName;
module.exports.addSiteLog = addSiteLog;
module.exports.siteLogPath = siteLogPath;
module.exports.rotateConfig = rotateConfig;
module.exports.SIZE_MB = SIZE_MB;
module.exports.KEEP = KEEP;
