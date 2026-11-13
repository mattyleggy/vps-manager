'use strict';
// The part of the Vultr API v2 the app uses: DNS zones ("domains") and their records.
// Talks only to api.vultr.com, with the API key the user saved in Settings.

const API = 'https://api.vultr.com/v2';
const ZONE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;
const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA', 'SSHFP'];
const NAMESERVERS = ['ns1.vultr.com', 'ns2.vultr.com'];
const MAX_PAGES = 10; // 500 per page

/** Vultr stores TXT data wrapped in double quotes. */
const txt = (data) => (/^".*"$/s.test(data) ? data : `"${data.replace(/"/g, '\\"')}"`);

/**
 * Validate a record and return it in the shape the API takes:
 * { name, type, data, ttl, priority? }. name is the part left of the zone ('' = the zone itself).
 */
function recordBody(r) {
  const type = String(r.type || '').toUpperCase();
  if (!TYPES.includes(type)) throw new Error(`Record type must be one of ${TYPES.join(', ')}: "${r.type}"`);
  let name = String(r.name == null ? '' : r.name).trim().toLowerCase().replace(/\.$/, '');
  if (name === '@') name = '';
  if (name && !/^(\*|[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/.test(name)) {
    throw new Error(`Not a valid record name: "${r.name}". Use the part before the domain, e.g. "www", or leave it empty for the domain itself.`);
  }
  let data = String(r.data == null ? '' : r.data).trim();
  if (!data || /[\r\n]/.test(data) || data.length > 4096) throw new Error('Enter the record value (one line)');
  if (type === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(data)) throw new Error(`An A record needs an IPv4 address: "${data}"`);
  if (type === 'AAAA' && !/^[0-9a-f:.]+$/i.test(data)) throw new Error(`An AAAA record needs an IPv6 address: "${data}"`);
  if (type === 'CNAME' && !name) throw new Error('A CNAME cannot be set on the domain itself; use an A record there.');
  if (type === 'TXT') data = txt(data);
  const ttl = r.ttl == null ? 300 : Number(r.ttl);
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400 * 7) throw new Error(`TTL must be a whole number of seconds from 60 to 604800: "${r.ttl}"`);
  const body = { name, type, data, ttl };
  if (type === 'MX' || type === 'SRV') {
    const priority = r.priority == null ? 10 : Number(r.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) throw new Error(`Priority must be 0-65535: "${r.priority}"`);
    body.priority = priority;
  }
  return body;
}

/** The zone a hostname belongs to (longest match), and the record name inside it. null if none. */
function zoneFor(host, zones) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  const zone = zones
    .map((z) => String(z).toLowerCase())
    .filter((z) => h === z || h.endsWith('.' + z))
    .sort((a, b) => b.length - a.length)[0];
  return zone ? { zone, name: h === zone ? '' : h.slice(0, -zone.length - 1) } : null;
}

module.exports = ({ key }) => {
  async function request(method, path, body) {
    const k = key();
    if (!k) throw new Error('No Vultr API key is saved. Add one in Settings → Vultr DNS.');
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${k}`, Accept: 'application/json', 'User-Agent': 'vps-manager', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`Could not reach Vultr: ${e.message}`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (res.ok) return data;
    const detail = (data && data.error) || text.slice(0, 200);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `Vultr rejected the API key. Check it in Settings → Vultr DNS, and that this PC's public IP address is allowed under Account → API → Access Control in the Vultr portal (the usual cause). Vultr said: ${detail || res.status}`
      );
    }
    if (res.status === 404) throw new Error(`Vultr could not find that domain or record. (${detail || 404})`);
    throw new Error(`Vultr API error ${res.status}: ${detail}`);
  }

  async function paged(path, field) {
    const out = [];
    let cursor = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const data = await request('GET', `${path}?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      out.push(...((data && data[field]) || []));
      cursor = (data && data.meta && data.meta.links && data.meta.links.next) || '';
      if (!cursor) break;
    }
    return out;
  }

  const zonePath = (zone) => {
    const z = String(zone).trim().toLowerCase();
    if (!ZONE.test(z)) throw new Error(`Not a valid domain name: "${zone}"`);
    return `/domains/${z}`;
  };
  const recordPath = (zone, id) => {
    if (!RECORD_ID.test(String(id))) throw new Error(`Not a valid record id: "${id}"`);
    return `${zonePath(zone)}/records/${id}`;
  };

  const checkId = (id) => {
    if (!RECORD_ID.test(String(id))) throw new Error(`Not a valid Vultr id: "${id}"`);
    return String(id);
  };
  const instancePath = (id) => `/instances/${checkId(id)}`;

  return {
    NAMESERVERS,
    hasKey: () => !!key(),
    /** DNS zones on the account: [{ domain, date_created, dns_sec }]. Read-only. */
    listZones: () => paged('/domains', 'domains'),
    /** Records of one zone: [{ id, type, name, data, priority, ttl }]. Read-only. */
    listRecords: (zone) => paged(`${zonePath(zone)}/records`, 'records'),
    /** Create an empty zone. Changes the account, so callers go through the review gate. */
    createZone: (zone) => request('POST', '/domains', { domain: zonePath(zone).slice('/domains/'.length), dns_sec: 'disabled' }),
    createRecord: (zone, record) => request('POST', `${zonePath(zone)}/records`, recordBody(record)),
    /** Update a record in place. Vultr keeps the record's type; only name, data, ttl and priority change. */
    updateRecord: (zone, id, record) => {
      const { type, ...rest } = recordBody(record);
      return request('PATCH', recordPath(zone, id), rest);
    },
    deleteRecord: (zone, id) => request('DELETE', recordPath(zone, id)),

    // ---- instances (read-only) ----
    listInstances: () => paged('/instances', 'instances'),
    instance: (id) => request('GET', instancePath(id)).then((d) => d.instance),
    /** Daily traffic for about the last month: { 'YYYY-MM-DD': { incoming_bytes, outgoing_bytes } }. */
    bandwidth: (id) => request('GET', `${instancePath(id)}/bandwidth`).then((d) => d.bandwidth || {}),
    ipv4: (id) => request('GET', `${instancePath(id)}/ipv4`).then((d) => d.ipv4s || []),
    ipv6: (id) => request('GET', `${instancePath(id)}/ipv6`).then((d) => d.ipv6s || []),
    neighbors: (id) => request('GET', `${instancePath(id)}/neighbors`).then((d) => d.neighbors || []),
    backupSchedule: (id) => request('GET', `${instancePath(id)}/backup-schedule`).then((d) => d.backup_schedule || null),
    backups: (id) => request('GET', `/backups?instance_id=${encodeURIComponent(checkId(id))}&per_page=100`).then((d) => d.backups || []),
    snapshots: () => paged('/snapshots', 'snapshots'),
    plans: () => paged('/plans', 'plans'),
    regions: () => paged('/regions', 'regions'),
    firewallGroup: (id) => request('GET', `/firewalls/${checkId(id)}`).then((d) => d.firewall_group),
    firewallRules: (id) => paged(`/firewalls/${checkId(id)}/rules`, 'firewall_rules'),
    account: () => request('GET', '/account').then((d) => d.account),
    pendingCharges: () => request('GET', '/billing/pending-charges').then((d) => d.pending_charges || []),
  };
};

module.exports.recordBody = recordBody;
module.exports.zoneFor = zoneFor;
module.exports.TYPES = TYPES;
module.exports.NAMESERVERS = NAMESERVERS;
