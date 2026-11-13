'use strict';
// Minimal nginx config parser: enough to pull domains, upstreams and certificates
// out of a site file for display. It never rewrites configs - edits are done on the raw text.

function tokenize(src) {
  const t = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '#') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '{' || c === '}' || c === ';') {
      t.push(c);
      i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < n) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      t.push({ w: s });
      i = j + 1;
    } else {
      let j = i;
      let s = '';
      while (j < n && !/[\s{};]/.test(src[j])) {
        if (src[j] === '\\' && j + 1 < n) {
          s += src[j] + src[j + 1];
          j += 2;
        } else if (src[j] === '$' && src[j + 1] === '{') {
          const end = src.indexOf('}', j);
          const stop = end === -1 ? n : end + 1;
          s += src.slice(j, stop);
          j = stop;
        } else {
          s += src[j++];
        }
      }
      t.push({ w: s });
      i = j;
    }
  }
  return t;
}

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  function block() {
    const out = [];
    let cur = [];
    while (p < toks.length) {
      const t = toks[p++];
      if (t === ';') {
        if (cur.length) out.push({ name: cur[0], args: cur.slice(1) });
        cur = [];
      } else if (t === '{') {
        out.push({ name: cur[0] || '', args: cur.slice(1), children: block() });
        cur = [];
      } else if (t === '}') {
        break;
      } else {
        cur.push(t.w);
      }
    }
    // Tolerate a missing final ';' (half-edited file) rather than dropping the directive.
    if (cur.length) out.push({ name: cur[0], args: cur.slice(1) });
    return out;
  }
  return block();
}

function walk(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.children) walk(n.children, fn);
  }
}

const uniq = (a) => [...new Set(a)];

function summarize(src) {
  let tree;
  try {
    tree = parse(src);
  } catch {
    tree = [];
  }
  const servers = [];
  walk(tree, (node) => {
    if (node.name !== 'server' || !node.children) return;
    const s = { names: [], listens: [], ssl: false, certs: [], roots: [], proxies: [], redirect: null };
    for (const d of node.children) {
      if (d.name === 'server_name') s.names.push(...d.args);
      else if (d.name === 'listen') {
        s.listens.push(d.args[0]);
        if (d.args.includes('ssl') || /(^|:)443$/.test(d.args[0] || '')) s.ssl = true;
      } else if (d.name === 'return' && /^30[1278]$/.test(d.args[0] || '')) s.redirect = d.args[1] || null;
    }
    walk(node.children, (d) => {
      if (d.children) return;
      if (d.name === 'ssl_certificate') s.certs.push(d.args[0]);
      else if (d.name === 'root') s.roots.push(d.args[0]);
      else if (/^(proxy|fastcgi|uwsgi|grpc)_pass$/.test(d.name)) s.proxies.push(d.args[0]);
    });
    servers.push(s);
  });
  return {
    servers,
    domains: uniq(servers.flatMap((s) => s.names).filter((n) => n && n !== '_' && n !== 'localhost' && !n.startsWith('~'))),
    targets: uniq(servers.flatMap((s) => (s.proxies.length ? s.proxies : s.roots))),
    certs: uniq(servers.flatMap((s) => s.certs)),
    ssl: servers.some((s) => s.ssl),
  };
}

module.exports = { parse, summarize };
