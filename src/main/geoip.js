'use strict';
// Country (and network) of client IPs seen in access logs, from ip-api.com's free batch API.
//
// The free tier is HTTP only, allows 15 batch requests a minute of up to 100 IPs each, and is
// for non-commercial use. Answers are cached on disk for CACHE_DAYS so a busy log is looked up
// once, and private / reserved addresses are never sent.

const fs = require('fs');
const path = require('path');
const net = require('net');

const API = 'http://ip-api.com/batch?fields=status,message,query,countryCode,country,city,isp,org,as,hosting,proxy';
const BATCH = 100;
const CACHE_DAYS = 30;
const MAX_CACHE = 20000;

/** Addresses that are not on the public internet, so a lookup would say nothing. */
function isPrivate(ip) {
  if (net.isIPv4(ip)) return /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|22[4-9]\.|2[3-5]\d\.)/.test(ip);
  if (net.isIPv6(ip)) return /^(::1?$|f[cd]|fe[89ab]|::ffff:(10|127|192\.168)\.)/i.test(ip);
  return true;
}

/** One ip-api answer -> what the app keeps. */
function shape(r) {
  if (!r || r.status !== 'success') return { cc: '', country: '', failed: true };
  return { cc: (r.countryCode || '').toLowerCase(), country: r.country || '', city: r.city || '', isp: r.isp || '', org: r.org || '', as: r.as || '', hosting: !!r.hosting, proxy: !!r.proxy };
}

module.exports = ({ file: fileOpt, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) => {
  // A path, or a function returning one (Electron's userData path is only known once the app starts).
  const file = () => (typeof fileOpt === 'function' ? fileOpt() : fileOpt);
  let cache = null; // ip -> { at, ...shape }
  let saveTimer = null;

  function load() {
    if (cache) return cache;
    cache = new Map();
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      const fresh = now() - CACHE_DAYS * 86400000;
      for (const [ip, v] of Object.entries(raw)) if (v && v.at > fresh) cache.set(ip, v);
    } catch {}
    return cache;
  }

  function saveSoon() {
    if (!file() || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        // Keep the newest entries only, so the file can't grow without bound.
        const entries = [...cache].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE);
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify(Object.fromEntries(entries)));
      } catch {}
    }, 2000);
    if (saveTimer.unref) saveTimer.unref();
  }

  let blockedUntil = 0; // rate limited: don't ask again before this

  return {
    isPrivate,
    /**
     * Look up a list of IPs. Returns { [ip]: { cc, country, city, isp, org, as, hosting, proxy } },
     * with { private: true } for internal addresses. IPs it could not look up (rate limit, offline)
     * are left out so the caller can ask again later.
     */
    async lookup(ips) {
      const c = load();
      const out = {};
      const want = [];
      for (const ip of new Set((ips || []).map(String))) {
        if (!net.isIP(ip)) continue;
        if (isPrivate(ip)) out[ip] = { private: true, cc: '', country: '' };
        else if (c.has(ip)) out[ip] = c.get(ip);
        else want.push(ip);
      }
      for (let i = 0; i < want.length && now() >= blockedUntil; i += BATCH) {
        const chunk = want.slice(i, i + BATCH);
        let res;
        try {
          res = await fetchImpl(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chunk), signal: AbortSignal.timeout(8000) });
        } catch {
          break; // offline: try again on the next call
        }
        if (res.status === 429 || res.headers?.get?.('x-rl') === '0') {
          const wait = Number(res.headers?.get?.('x-ttl')) || 60;
          blockedUntil = now() + wait * 1000;
        }
        if (!res.ok) break;
        const list = await res.json().catch(() => []);
        for (const r of Array.isArray(list) ? list : []) {
          if (!r || !r.query) continue;
          const v = { at: now(), ...shape(r) };
          c.set(r.query, v);
          out[r.query] = v;
        }
        saveSoon();
      }
      return out;
    },
  };
};

module.exports.isPrivate = isPrivate;
module.exports.shape = shape;
