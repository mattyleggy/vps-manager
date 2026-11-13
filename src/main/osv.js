'use strict';
// Known vulnerabilities for pinned dependencies, from OSV.dev (https://osv.dev): a free,
// key-less database that merges GitHub advisories, PyPI, Go, RustSec, RubyGems and others.
// Only ecosystem + package name + version are sent; nothing about the server or the repos.

const API = 'https://api.osv.dev/v1';
const BATCH = 1000; // OSV's limit per querybatch call
const DETAIL_CONCURRENCY = 8;
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'unknown'];

// ---- CVSS v3.x base score (for advisories that carry only a vector, e.g. Go and RustSec) ----
const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
};
const roundUp = (n) => {
  const i = Math.round(n * 100000);
  return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
};
function cvss3Score(vector) {
  const m = Object.fromEntries(
    String(vector)
      .split('/')
      .slice(1)
      .map((p) => p.split(':'))
  );
  if (!/^CVSS:3/.test(vector) || !m.AV || !m.AC || !m.PR || !m.UI || !m.S || !m.C || !m.I || !m.A) return null;
  const changed = m.S === 'C';
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const iss = 1 - (1 - W.CIA[m.C]) * (1 - W.CIA[m.I]) * (1 - W.CIA[m.A]);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploit = 8.22 * W.AV[m.AV] * W.AC[m.AC] * pr * W.UI[m.UI];
  if ([impact, exploit].some((x) => Number.isNaN(x))) return null;
  if (impact <= 0) return 0;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploit) : impact + exploit, 10));
}
const scoreToSeverity = (s) => (s == null ? 'unknown' : s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'moderate' : s > 0 ? 'low' : 'unknown');

/** { severity: 'critical'|'high'|'moderate'|'low'|'unknown', score } for an OSV record. */
function severityOf(v) {
  let score = null;
  for (const s of v.severity || []) {
    const sc = /^CVSS_V3/.test(s.type) ? cvss3Score(s.score) : null;
    if (sc != null && (score == null || sc > score)) score = sc;
  }
  const label = String((v.database_specific && v.database_specific.severity) || '').toLowerCase();
  const named = { critical: 'critical', high: 'high', moderate: 'moderate', medium: 'moderate', low: 'low' }[label];
  return { severity: named || scoreToSeverity(score), score };
}

/** Versions that fix `pkg` in this record (from its affected ranges). */
function fixedVersions(v, ecosystem, name) {
  const out = new Set();
  for (const a of v.affected || []) {
    if (!a.package || a.package.ecosystem !== ecosystem || a.package.name.toLowerCase() !== name.toLowerCase()) continue;
    for (const r of a.ranges || []) for (const e of r.events || []) if (e.fixed) out.add(e.fixed);
  }
  return [...out];
}

/**
 * Advisory ids for the same flaw often come back twice (a GHSA and its PYSEC/GO alias).
 * Keep one per package, preferring the GHSA (it has the severity).
 */
function dedupe(findings) {
  const kept = [];
  for (const f of findings.sort((a, b) => (b.id.startsWith('GHSA') ? 1 : 0) - (a.id.startsWith('GHSA') ? 1 : 0))) {
    const same = kept.find((k) => k.ecosystem === f.ecosystem && k.package === f.package && k.version === f.version && (k.aliases.includes(f.id) || f.aliases.includes(k.id) || k.aliases.some((x) => f.aliases.includes(x))));
    if (!same) kept.push(f);
  }
  return kept;
}

module.exports = ({ fetchImpl = (...a) => fetch(...a) } = {}) => {
  const details = new Map(); // id -> { modified, record }

  async function call(path, body) {
    const res = await fetchImpl(API + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`OSV.dev answered ${res.status} for ${path.split('?')[0]}`);
    return res.json();
  }

  async function record(id, modified) {
    const c = details.get(id);
    if (c && c.modified === modified) return c.record;
    const r = await call(`/vulns/${encodeURIComponent(id)}`);
    details.set(id, { modified, record: r });
    return r;
  }

  /**
   * packages: [{ ecosystem, name, version }] (duplicates are fine).
   * Resolves Map key `${ecosystem}\0${name}\0${version}` -> [finding].
   */
  async function check(packages) {
    const uniq = new Map();
    for (const p of packages) uniq.set(`${p.ecosystem}\0${p.name}\0${p.version}`, p);
    const list = [...uniq.values()];
    const hits = new Map(); // key -> [{ id, modified }]
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const r = await call('/querybatch', { queries: chunk.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version })) });
      (r.results || []).forEach((res, j) => {
        if (res && res.vulns && res.vulns.length) {
          const p = chunk[j];
          hits.set(`${p.ecosystem}\0${p.name}\0${p.version}`, res.vulns);
        }
      });
    }

    const ids = new Map();
    for (const vs of hits.values()) for (const v of vs) ids.set(v.id, v.modified);
    const queue = [...ids];
    const records = new Map();
    await Promise.all(
      Array.from({ length: Math.min(DETAIL_CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const [id, modified] = queue.shift();
          try {
            records.set(id, await record(id, modified));
          } catch {
            records.set(id, { id, summary: '(details could not be loaded from OSV.dev)' });
          }
        }
      })
    );

    const out = new Map();
    for (const [key, vs] of hits) {
      const p = uniq.get(key);
      const findings = vs.map(({ id }) => {
        const v = records.get(id) || { id };
        if (v.withdrawn) return null;
        const { severity, score } = severityOf(v);
        return {
          id,
          aliases: v.aliases || [],
          summary: v.summary || (v.details ? String(v.details).split('\n')[0].slice(0, 200) : ''),
          severity,
          score,
          ecosystem: p.ecosystem,
          package: p.name,
          version: p.version,
          fixed: fixedVersions(v, p.ecosystem, p.name),
          published: v.published || null,
        };
      });
      out.set(key, dedupe(findings.filter(Boolean)));
    }
    return out;
  }

  return { check };
};

module.exports.cvss3Score = cvss3Score;
module.exports.severityOf = severityOf;
module.exports.dedupe = dedupe;
module.exports.SEVERITY_ORDER = SEVERITY_ORDER;
