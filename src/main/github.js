'use strict';
// The small part of the GitHub REST API the app uses: a repository's deploy keys.
// Talks only to api.github.com, with the token the user saved in Settings.

const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** "ssh-ed25519 AAAA... comment" -> "ssh-ed25519 AAAA..." (GitHub stores keys without the comment). */
const keyBody = (key) => String(key).trim().split(/\s+/).slice(0, 2).join(' ');

const MAX_REPO_PAGES = 5; // 100 per page

const repoSummary = (r) => ({
  full_name: r.full_name,
  private: !!r.private,
  default_branch: r.default_branch,
  pushed_at: r.pushed_at,
  description: r.description || '',
  archived: !!r.archived,
});

module.exports = ({ token, sshIdentity }) => {
  async function request(method, path, body, { tokenOptional = false } = {}) {
    const t = token();
    if (!t && !tokenOptional) throw new Error('No GitHub token is saved. Add one in Settings → GitHub.');
    let res;
    try {
      res = await fetch(API + path, {
        method,
        headers: {
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'vps-manager',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new Error(`Could not reach GitHub: ${e.message}`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    if (res.ok) return data;
    const detail = [data && data.message, ...((data && data.errors) || []).map((e) => e.message)].filter(Boolean).join('; ');
    const repo = (/^\/repos\/([^/]+\/[^/]+)/.exec(path) || [])[1] || 'the repository';
    if (res.status === 401) throw new Error('GitHub rejected the token. Check it in Settings → GitHub (it may have expired).');
    if (res.status === 403 || res.status === 404) {
      const [thing, permission] = /\/hooks(\/|$|\?)/.test(path) ? ['webhooks', 'Webhooks'] : ['deploy keys', 'Administration'];
      throw new Error(`The GitHub token cannot manage ${thing} on ${repo}. It needs access to that repository with the "${permission}: Read and write" permission (or the repository name is wrong). GitHub said: ${detail || res.status}`);
    }
    if (res.status === 422 && /already in use/i.test(detail)) {
      throw new Error(`GitHub refused the key: it is already a deploy key on another repository. Each repository needs its own key. (${detail})`);
    }
    throw new Error(`GitHub API error ${res.status}: ${detail || text.slice(0, 200)}`);
  }

  const repoPath = (repo) => {
    if (!REPO.test(repo)) throw new Error(`Repository must look like owner/name: "${repo}"`);
    return `/repos/${repo}`;
  };

  return {
    keyBody,
    hasToken: () => !!token(),
    /**
     * The connected user's repositories, most recently pushed first. Read-only.
     *  - With a token: everything the token can see, private repos included.
     *  - Without one: GitHub's SSH endpoint cannot list repositories, but it does name the
     *    account an SSH key belongs to, so the account's PUBLIC repositories are listed.
     * Resolves { source: 'token' | 'ssh', user, publicOnly, truncated, repos: [...] }.
     */
    async listRepos() {
      if (token()) {
        const repos = [];
        let page = 1;
        for (; page <= MAX_REPO_PAGES; page++) {
          const batch = await request('GET', `/user/repos?per_page=100&sort=pushed&page=${page}`);
          repos.push(...batch.map(repoSummary));
          if (batch.length < 100) break;
        }
        return { source: 'token', user: null, publicOnly: false, truncated: page > MAX_REPO_PAGES, repos };
      }
      const who = sshIdentity ? await (async () => sshIdentity())().catch(() => null) : null;
      if (!who || !who.login) {
        throw new Error('No GitHub token is saved, and GitHub did not recognise your SSH key as belonging to an account. Add a token in Settings → GitHub to list your repositories.');
      }
      const repos = [];
      let page = 1;
      for (; page <= MAX_REPO_PAGES; page++) {
        const batch = await request('GET', `/users/${encodeURIComponent(who.login)}/repos?per_page=100&sort=pushed&page=${page}`, null, { tokenOptional: true });
        repos.push(...batch.map(repoSummary));
        if (batch.length < 100) break;
      }
      return { source: 'ssh', user: who.login, publicOnly: true, truncated: page > MAX_REPO_PAGES, repos };
    },
    /** The repository's default branch. Read-only; needs no token for a public repository. */
    async defaultBranch(repo) {
      const path = repoPath(repo);
      let data = null;
      try {
        data = await request('GET', path, null, { tokenOptional: true });
      } catch {
        /* explained below */
      }
      if (!data || !data.default_branch) {
        throw new Error(`Could not look up the default branch of ${repo} on GitHub (a private repository the saved token cannot read, or a wrong name). Enter the branch yourself.`);
      }
      return String(data.default_branch);
    },
    /** Deploy keys currently on the repo: [{ id, title, key, read_only }]. Read-only call. */
    listDeployKeys: async (repo) => request('GET', `${repoPath(repo)}/keys?per_page=100`),
    /** Add a read-only deploy key. This changes the repository, so callers go through the review gate. */
    addDeployKey: async (repo, title, key) => request('POST', `${repoPath(repo)}/keys`, { title, key: String(key).trim(), read_only: true }),
    /** Webhooks on the repo: [{ id, active, events, config: { url, content_type } }]. Read-only call. */
    listHooks: async (repo) => request('GET', `${repoPath(repo)}/hooks?per_page=100`),
    /** Create a webhook. hook = { active, events, config: { url, content_type, secret, insecure_ssl } }. Reviewed by callers. */
    createHook: async (repo, hook) => request('POST', `${repoPath(repo)}/hooks`, { name: 'web', ...hook }),
    /** Update an existing webhook in place (GitHub never returns the secret, so this is how it is re-sent). */
    updateHook: async (repo, id, hook) => request('PATCH', `${repoPath(repo)}/hooks/${Number(id)}`, hook),
  };
};

module.exports.keyBody = keyBody;
