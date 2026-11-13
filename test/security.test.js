'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const createOsv = require('../src/main/osv');
const { cvss3Score, severityOf, dedupe } = createOsv;
const { withFindings, reposScript, REPOS_SCRIPT, UPDATES_SCRIPT } = require('../src/main/remote/security');

const PY = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)']).status === 0);

test('CVSS v3 base scores match the specification', () => {
  assert.strictEqual(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
  assert.strictEqual(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H'), 10);
  assert.strictEqual(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
  assert.strictEqual(cvss3Score('CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:L'), 1.8);
  assert.strictEqual(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N'), 0);
  assert.strictEqual(cvss3Score('garbage'), null);
});

test('severity prefers the advisory label, else the CVSS score', () => {
  assert.strictEqual(severityOf({ database_specific: { severity: 'MODERATE' } }).severity, 'moderate');
  assert.strictEqual(severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }).severity, 'critical');
  assert.strictEqual(severityOf({}).severity, 'unknown');
});

test('aliases of the same advisory are reported once, keeping the GHSA', () => {
  const base = { ecosystem: 'PyPI', package: 'django', version: '4.0' };
  const out = dedupe([
    { ...base, id: 'PYSEC-2022-1', aliases: ['CVE-2022-1'] },
    { ...base, id: 'GHSA-xxxx', aliases: ['CVE-2022-1'] },
    { ...base, id: 'GHSA-yyyy', aliases: ['CVE-2022-2'] },
  ]);
  assert.deepStrictEqual(out.map((f) => f.id).sort(), ['GHSA-xxxx', 'GHSA-yyyy']);
});

test('OSV client batches queries and reads advisory details once', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push([url, opts.method]);
    const json = (b) => ({ ok: true, json: async () => b });
    if (url.endsWith('/querybatch')) {
      const qs = JSON.parse(opts.body).queries;
      return json({ results: qs.map((q) => (q.package.name === 'lodash' ? { vulns: [{ id: 'GHSA-1', modified: 'm1' }] } : {})) });
    }
    return json({
      id: 'GHSA-1',
      summary: 'Prototype pollution',
      aliases: ['CVE-2020-8203'],
      database_specific: { severity: 'HIGH' },
      affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.19' }] }] }],
    });
  };
  const osv = createOsv({ fetchImpl: fake });
  const pkgs = [
    { ecosystem: 'npm', name: 'lodash', version: '4.17.15' },
    { ecosystem: 'npm', name: 'lodash', version: '4.17.15' },
    { ecosystem: 'npm', name: 'left-pad', version: '1.3.0' },
  ];
  const hits = await osv.check(pkgs);
  assert.strictEqual(calls.filter((c) => c[0].endsWith('/querybatch')).length, 1);
  const f = hits.get('npm\0lodash\x004.17.15');
  assert.strictEqual(f.length, 1);
  assert.deepStrictEqual([f[0].id, f[0].severity, f[0].fixed], ['GHSA-1', 'high', ['4.17.19']]);
  assert.ok(!hits.has('npm\0left-pad\x001.3.0'));
  await osv.check(pkgs);
  assert.strictEqual(calls.filter((c) => c[0].includes('/vulns/')).length, 1, 'details are cached by modified date');
});

test('findings are joined to repos, worst first, with counts', () => {
  const scan = {
    repos: [
      { path: '/opt/apps/a', lockfiles: [{ file: 'package-lock.json', ecosystem: 'npm', packages: [['lodash', '4.17.15'], ['ok', '1.0.0']] }, { file: 'web/yarn.lock', ecosystem: 'npm', packages: [['lodash', '4.17.15']] }] },
      { path: '/srv/b', lockfiles: [] },
    ],
  };
  const hits = new Map([
    ['npm\0lodash\x004.17.15', [
      { id: 'GHSA-low', aliases: [], severity: 'low', package: 'lodash', version: '4.17.15', ecosystem: 'npm', fixed: [] },
      { id: 'GHSA-crit', aliases: [], severity: 'critical', package: 'lodash', version: '4.17.15', ecosystem: 'npm', fixed: ['4.17.21'] },
    ]],
  ]);
  const r = withFindings(scan, hits);
  const a = r.repos[0];
  assert.deepStrictEqual(a.findings.map((f) => f.id), ['GHSA-crit', 'GHSA-low']);
  assert.deepStrictEqual(a.findings[0].files, ['package-lock.json', 'web/yarn.lock']);
  assert.strictEqual(a.counts.critical, 1);
  assert.strictEqual(a.packages, 3);
  assert.strictEqual(a.lockfiles[0].packages, 2, 'package lists are reduced to a count');
  assert.strictEqual(r.repos[1].findings.length, 0);
});

test('server scripts are valid Python', { skip: !PY && 'python not installed' }, () => {
  for (const [name, src] of [['repos', REPOS_SCRIPT], ['updates', UPDATES_SCRIPT]]) {
    const r = spawnSync(PY, ['-c', 'import sys; compile(sys.stdin.read(), "s", "exec")'], { input: src });
    assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
  }
  assert.ok(UPDATES_SCRIPT.includes("'$' '{Package}"), 'dpkg-query format reaches Python intact');
});

test('lockfile parsers read every supported format', { skip: !PY && 'python not installed' }, () => {
  const lib = REPOS_SCRIPT.split('\nrepos = []')[0];
  const samples = {
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'me' }, 'node_modules/lodash': { version: '4.17.15' }, 'node_modules/a/node_modules/@scope/b': { version: '1.0.0' }, 'node_modules/local': { link: true } } }),
    'yarn.lock': '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.1.2"\n  resolved "x"\n\nlodash@^4:\n  version "4.17.15"\n',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\npackages:\n\n  '@babel/core@7.1.2':\n    resolution: {}\n\n  lodash@4.17.15:\n    resolution: {}\n\nsnapshots:\n\n  react-dom@18.2.0(react@18.2.0):\n    dependencies: {}\n",
    'composer.lock': JSON.stringify({ packages: [{ name: 'laravel/framework', version: 'v10.0.1' }, { name: 'x/y', version: 'dev-main' }], 'packages-dev': [{ name: 'phpunit/phpunit', version: '10.1.0' }] }),
    'Pipfile.lock': JSON.stringify({ default: { django: { version: '==4.0' } }, develop: {} }),
    'poetry.lock': '[[package]]\nname = "requests"\nversion = "2.25.0"\n\n[package.dependencies]\nidna = "*"\n',
    'Cargo.lock': '[[package]]\nname = "me"\nversion = "0.1.0"\n\n[[package]]\nname = "serde"\nversion = "1.0.1"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
    'Gemfile.lock': 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.0.1)\n      actionpack (= 7.0.1)\n    nokogiri (1.13.1-x86_64-linux)\n\nPLATFORMS\n  ruby\n',
    'go.mod': 'module x\n\ngo 1.21\n\nrequire golang.org/x/net v0.1.0\n\nrequire (\n\tgithub.com/a/b v1.2.3 // indirect\n)\n',
    'requirements.txt': 'flask==2.0.1\nrequests>=2\nuvicorn[standard]==0.20.0 ; python_version > "3"\n',
  };
  const code = `${lib}\nimport sys\nsamples = json.loads(sys.stdin.read())\nprint(json.dumps({k: sorted(parse(k, v)) for k, v in samples.items()}))`;
  const r = spawnSync(PY, ['-I', '-c', code], { input: JSON.stringify(samples) });
  assert.strictEqual(r.status, 0, String(r.stderr));
  const got = JSON.parse(r.stdout);
  assert.deepStrictEqual(got['package-lock.json'], [['@scope/b', '1.0.0'], ['lodash', '4.17.15']]);
  assert.deepStrictEqual(got['yarn.lock'], [['@babel/core', '7.1.2'], ['lodash', '4.17.15']]);
  assert.deepStrictEqual(got['pnpm-lock.yaml'], [['@babel/core', '7.1.2'], ['lodash', '4.17.15'], ['react-dom', '18.2.0']]);
  assert.deepStrictEqual(got['composer.lock'], [['laravel/framework', '10.0.1'], ['phpunit/phpunit', '10.1.0']]);
  assert.deepStrictEqual(got['Pipfile.lock'], [['django', '4.0']]);
  assert.deepStrictEqual(got['poetry.lock'], [['requests', '2.25.0']]);
  assert.deepStrictEqual(got['Cargo.lock'], [['serde', '1.0.1']]);
  assert.deepStrictEqual(got['Gemfile.lock'], [['nokogiri', '1.13.1'], ['rails', '7.0.1']]);
  assert.deepStrictEqual(got['go.mod'], [['github.com/a/b', 'v1.2.3'], ['golang.org/x/net', 'v0.1.0']]);
  assert.deepStrictEqual(got['requirements.txt'], [['flask', '2.0.1'], ['uvicorn', '0.20.0']]);
});

test('origin URLs lose any embedded credentials', { skip: !PY && 'python not installed' }, () => {
  const lib = REPOS_SCRIPT.split('\nrepos = []')[0];
  const r = spawnSync(PY, ['-I', '-c', `${lib}\nprint(json.dumps([redact('https://x-access-token:ghp_abc@github.com/me/app.git'), redact('git@github.com:me/app.git')]))`]);
  assert.deepStrictEqual(JSON.parse(r.stdout), ['https://github.com/me/app.git', 'git@github.com:me/app.git']);
});

test('a single-repo scan reads only that checkout, and refuses a folder that is not one', { skip: !PY && 'python not installed' }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "repo 'x-"));
  try {
    const run = (p) => JSON.parse(spawnSync(PY, ['-I', '-'], { input: reposScript(p) }).stdout);
    assert.match(run(dir).error, /no longer a git checkout/);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/lodash': { version: '4.17.15' } } }));
    const r = run(dir);
    assert.strictEqual(r.repos.length, 1);
    assert.deepStrictEqual(r.repos[0].lockfiles[0].packages, [['lodash', '4.17.15']]);
    assert.strictEqual(reposScript(), REPOS_SCRIPT);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
