'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createGithub = require('../src/main/github');

function withFetch(status, body) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return calls;
}

test('adds a read-only deploy key with the saved token', async () => {
  const calls = withFetch(201, { id: 7 });
  const gh = createGithub({ token: () => 'tok' });
  await gh.addDeployKey('me/app', 'title', 'ssh-ed25519 AAAA comment\n');
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/me/app/keys');
  assert.strictEqual(calls[0].opts.method, 'POST');
  assert.strictEqual(calls[0].opts.headers.Authorization, 'Bearer tok');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { title: 'title', key: 'ssh-ed25519 AAAA comment', read_only: true });
});

test('refuses to call GitHub without a token or with a malformed repo', async () => {
  const calls = withFetch(200, []);
  await assert.rejects(createGithub({ token: () => '' }).listDeployKeys('me/app'), /No GitHub token is saved/);
  await assert.rejects(createGithub({ token: () => 'tok' }).listDeployKeys('me/app/../../user'), /owner\/name/);
  assert.strictEqual(calls.length, 0);
});

test('explains the common failures in plain words', async () => {
  const gh = createGithub({ token: () => 'tok' });
  withFetch(401, { message: 'Bad credentials' });
  await assert.rejects(gh.listDeployKeys('me/app'), /rejected the token/);
  withFetch(404, { message: 'Not Found' });
  await assert.rejects(gh.listDeployKeys('me/app'), /cannot manage deploy keys on me\/app[^]*Administration/);
  withFetch(422, { message: 'Validation Failed', errors: [{ message: 'key is already in use' }] });
  await assert.rejects(gh.addDeployKey('me/app', 't', 'ssh-ed25519 AAAA'), /already a deploy key on another repository/);
  withFetch(500, 'oops');
  await assert.rejects(gh.listDeployKeys('me/app'), /GitHub API error 500/);
});

test('key comparison ignores the comment', () => {
  assert.strictEqual(createGithub.keyBody('ssh-ed25519 AAAA deploy-app\n'), createGithub.keyBody('ssh-ed25519 AAAA'));
  assert.notStrictEqual(createGithub.keyBody('ssh-ed25519 AAAA'), createGithub.keyBody('ssh-ed25519 BBBB'));
});

test('webhook calls: create, update in place, and a permission error that names Webhooks', async () => {
  const gh = createGithub({ token: () => 'tok' });
  const hook = { active: true, events: ['push'], config: { url: 'https://d.example.com/hooks/github', content_type: 'json', secret: 's', insecure_ssl: '0' } };
  let calls = withFetch(201, { id: 5 });
  await gh.createHook('me/app', hook);
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/me/app/hooks');
  assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { name: 'web', ...hook });
  calls = withFetch(200, { id: 5 });
  await gh.updateHook('me/app', 5, hook);
  assert.deepStrictEqual([calls[0].opts.method, calls[0].url], ['PATCH', 'https://api.github.com/repos/me/app/hooks/5']);
  withFetch(404, { message: 'Not Found' });
  await assert.rejects(gh.listHooks('me/app'), /cannot manage webhooks on me\/app[^]*Webhooks: Read and write/);
});

test('repository list: with a token it pages through /user/repos, private repos included', async () => {
  const urls = [];
  const page = (n, count) => Array.from({ length: count }, (_, i) => ({ full_name: `me/r${n}-${i}`, private: i === 0, default_branch: 'main', pushed_at: '2026-11-01T00:00:00Z', description: null }));
  global.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify(/page=1$/.test(url) ? page(1, 100) : page(2, 3)), { status: 200 });
  };
  const r = await createGithub({ token: () => 'tok', sshIdentity: () => assert.fail('SSH must not be used when a token exists') }).listRepos();
  assert.deepStrictEqual(urls, ['https://api.github.com/user/repos?per_page=100&sort=pushed&page=1', 'https://api.github.com/user/repos?per_page=100&sort=pushed&page=2']);
  assert.deepStrictEqual([r.source, r.publicOnly, r.truncated, r.repos.length], ['token', false, false, 103]);
  assert.deepStrictEqual(r.repos[0], { full_name: 'me/r1-0', private: true, default_branch: 'main', pushed_at: '2026-11-01T00:00:00Z', description: '', archived: false });
});

test('repository list: without a token it names the account through the SSH key and lists public repos only', async () => {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), auth: opts.headers.Authorization });
    return new Response(JSON.stringify([{ full_name: 'octo/site', private: false, default_branch: 'master' }]), { status: 200 });
  };
  const r = await createGithub({ token: () => '', sshIdentity: async () => ({ login: 'octo', deployKeyFor: null }) }).listRepos();
  assert.deepStrictEqual(calls, [{ url: 'https://api.github.com/users/octo/repos?per_page=100&sort=pushed&page=1', auth: undefined }]);
  assert.deepStrictEqual([r.source, r.user, r.publicOnly, r.repos[0].full_name], ['ssh', 'octo', true, 'octo/site']);
});

test('repository list: no token and an unrecognised key is a clear error, with no API call', async () => {
  const calls = withFetch(200, []);
  for (const sshIdentity of [async () => null, () => { throw new Error('no key'); }, undefined]) {
    await assert.rejects(createGithub({ token: () => '', sshIdentity }).listRepos(), /Add a token in Settings/);
  }
  assert.strictEqual(calls.length, 0);
});

test('GitHub SSH greeting parser', () => {
  const { parseGreeting, GITHUB_HOST_KEYS } = require('../src/main/github-ssh');
  assert.deepStrictEqual(parseGreeting("Hi octo-cat! You've successfully authenticated, but GitHub does not provide shell access."), { login: 'octo-cat', deployKeyFor: null });
  assert.deepStrictEqual(parseGreeting("Hi octo/my.repo! You've successfully authenticated"), { login: 'octo', deployKeyFor: 'octo/my.repo' });
  assert.strictEqual(parseGreeting('git@github.com: Permission denied (publickey).'), null);
  assert.strictEqual(parseGreeting('Hi ../../etc! x'), null);
  assert.strictEqual(GITHUB_HOST_KEYS.size, 3);
});
