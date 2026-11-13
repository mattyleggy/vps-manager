import { h, api, act, button, badge, icon, pageHead, table, load, timeAgo } from '../ui.js';

// Repositories: every git checkout on the server and the known vulnerabilities in the
// dependency versions its lockfiles pin (OSV.dev). The scan is cached in the main process;
// "Scan again" re-reads the server.

const SEV = ['critical', 'high', 'moderate', 'low', 'unknown'];
const SEV_KIND = { critical: 'bad', high: 'bad', moderate: 'warn', low: 'info', unknown: '' };
const SEV_LABEL = { critical: 'Critical', high: 'High', moderate: 'Moderate', low: 'Low', unknown: 'Unrated' };

const link = (text, url) => h('button', { type: 'button', class: 'link', title: url, onclick: () => api('open:external', url).catch(() => {}) }, text);

/** "git@github.com:me/app.git" / "https://github.com/me/app" -> "me/app"; other origins as given. */
function repoName(r) {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/i.exec(r.origin || '');
  return m ? m[1] : r.origin || r.path.split('/').pop();
}
const githubUrl = (r) => {
  const m = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/i.exec(r.origin || '');
  return m ? `https://github.com/${m[1]}` : null;
};

function stat(label, value, sub, kind) {
  return h('div', { class: 'card stat' }, h('div', { class: 'label' }, label), h('div', { class: `value ${kind ? `text-${kind}` : ''}` }, value), sub && h('div', { class: 'sub' }, sub));
}

function findingRow(f) {
  return h(
    'tr',
    null,
    h('td', null, badge(f.score != null ? `${SEV_LABEL[f.severity]} ${f.score.toFixed(1)}` : SEV_LABEL[f.severity], SEV_KIND[f.severity])),
    h('td', null, h('div', { class: 'mono' }, f.package), h('div', { class: 'muted' }, f.ecosystem)),
    h('td', { class: 'mono' }, f.version),
    h('td', { class: 'mono' }, f.fixed.length ? f.fixed.join(', ') : h('span', { class: 'muted' }, 'no fix yet')),
    h(
      'td',
      null,
      h('div', null, link(f.id, `https://osv.dev/vulnerability/${encodeURIComponent(f.id)}`), f.aliases.filter((a) => /^CVE-/.test(a)).slice(0, 2).map((a) => h('span', { class: 'muted mono' }, ` · ${a}`))),
      f.summary && h('div', { class: 'muted' }, f.summary)
    ),
    h('td', { class: 'mono muted' }, f.files.join(', '))
  );
}

/** The expanded part of a repository's row: where it lives, what was checked, and every finding. */
function repoDetail(r) {
  const meta = h(
    'div',
    { class: 'row muted' },
    h('span', { class: 'mono' }, r.path),
    r.branch && h('span', null, `· ${r.branch}`),
    r.commit && h('span', { class: 'mono', title: r.subject }, `· ${r.commit.slice(0, 7)}`),
    r.committed && h('span', null, `· committed ${timeAgo(r.committed)}`),
    r.dirty > 0 && badge(`${r.dirty} uncommitted change${r.dirty === 1 ? '' : 's'}`, 'warn')
  );
  const files = r.lockfiles.length
    ? h(
        'div',
        { class: 'row muted section-gap' },
        'Checked: ',
        r.lockfiles.map((l) => h('span', { class: 'mono', title: l.error || '' }, `${l.file} (${l.error ? 'unreadable' : `${l.packages} ${l.ecosystem}`})`))
      )
    : h('div', { class: 'muted section-gap' }, 'No supported lockfile in this repository, so its dependencies could not be checked.');
  return [meta, files, r.findings.length > 0 && table(['Severity', 'Package', 'Installed', 'Fixed in', 'Advisory', 'Lockfile'], r.findings.map(findingRow), '')];
}

/** One summary row per repository (counts by severity), plus a hidden row that expands to the findings. */
function repoRows(r, onRescan, expanded = false) {
  const gh = githubUrl(r);
  const worst = SEV.find((s) => r.counts[s]);
  const detail = h('tr', { class: `repo-detail${expanded ? '' : ' hidden'}` }, h('td', { colspan: SEV.length + 5 }, repoDetail(r)));
  const chev = h('button', { type: 'button', class: 'repo-toggle', 'aria-expanded': String(expanded), 'aria-label': `Show details for ${repoName(r)}` }, icon('chevron', 14));
  const toggle = () => {
    const open = detail.classList.toggle('hidden') === false;
    chev.setAttribute('aria-expanded', String(open));
  };
  const status = r.findings.length ? null : r.lockfiles.length ? badge('No known issues', 'ok') : badge('No lockfiles');
  const row = h(
    'tr',
    {
      class: 'repo-row',
      'data-severity': worst || 'none',
      onclick: (e) => {
        if (e.target.closest('button.link, .btn')) return;
        toggle();
      },
    },
    h('td', { class: 'repo-chev' }, chev),
    h('td', null, h('div', null, gh ? link(repoName(r), gh) : repoName(r)), h('div', { class: 'muted mono' }, r.path)),
    SEV.map((s) => h('td', { class: 'num' }, r.counts[s] ? badge(String(r.counts[s]), SEV_KIND[s]) : h('span', { class: 'muted' }, '0'))),
    h('td', null, r.project && badge(`deploy: ${r.project}`, 'info'), ' ', status),
    h(
      'td',
      { class: 'nowrap' },
      r.checkedAt
        ? [h('div', null, new Date(r.checkedAt * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })), h('div', { class: 'muted' }, timeAgo(r.checkedAt))]
        : h('span', { class: 'muted' }, '—')
    ),
    h('td', { class: 'actions' }, button('Rescan', (b) => onRescan(r, b, [row, detail], !detail.classList.contains('hidden')), 'small ghost'))
  );
  return [row, detail];
}

function stats(d) {
  const total = Object.fromEntries(SEV.map((s) => [s, d.repos.reduce((n, r) => n + r.counts[s], 0)]));
  const vulnerable = d.repos.filter((r) => r.findings.length).length;
  const packages = d.repos.reduce((n, r) => n + r.packages, 0);
  return h(
    'div',
    { class: 'grid' },
    stat('Repositories', String(d.repos.length), `${vulnerable} with known vulnerabilities`),
    stat('Critical / high', `${total.critical} / ${total.high}`, 'advisories affecting pinned versions', total.critical + total.high ? 'bad' : 'ok'),
    stat('Moderate / low', `${total.moderate} / ${total.low + total.unknown}`, total.unknown ? `${total.unknown} without a rating` : ''),
    stat('Packages checked', packages.toLocaleString(), `scanned ${timeAgo(d.scannedAt)} · OSV.dev`)
  );
}

export function render(root, ctx) {
  const scan = (refresh) =>
    load(root, async () => {
      const d = await api('security:repos', { refresh });
      // Worst first, then by name.
      const order = (r) => {
        const i = SEV.findIndex((s) => r.counts[s]);
        return i < 0 ? (r.lockfiles.length ? 10 : 11) : i;
      };
      const repos = [...d.repos].sort((a, b) => order(a) - order(b) || repoName(a).localeCompare(repoName(b)));
      let grid = stats(d);
      // Scan one checkout again and swap its rows in place (keeping it open if it was).
      const rescan = (r, b, rows, open) =>
        act(b, async () => {
          const { repo, osvError } = await api('security:repo', { path: r.path });
          if (osvError) throw new Error(osvError);
          d.repos[d.repos.indexOf(r)] = repo;
          const fresh = repoRows(repo, rescan, open);
          rows[0].replaceWith(fresh[0]);
          rows[1].replaceWith(fresh[1]);
          const g = stats(d);
          grid.replaceWith(g);
          grid = g;
        }, `Rescanned ${repoName(r)}`);
      return [
        d.osvError && h('div', { class: 'error-box' }, `${d.osvError}. The repositories below are listed without vulnerability results.`),
        d.truncated && h('div', { class: 'warn-box' }, 'Only the first 20,000 packages were checked; some lockfiles were left out.'),
        grid,
        repos.length
          ? h('div', { class: 'section' }, table(['', 'Repository', ...SEV.map((x) => SEV_LABEL[x]), '', 'Last checked', ''], repos.flatMap((r) => repoRows(r, rescan)), ''))
          : h('div', { class: 'info-box section' }, 'No git checkouts found under /opt, /srv, /var/www, /home, /root or the deploy project folders.'),
        h(
          'div',
          { class: 'info-box section' },
          'Only package names and versions are sent to OSV.dev; nothing about the server or the repositories. Versions come from lockfiles, so a dependency with no lockfile (or only a range in requirements.txt) is not checked, and what is running in a container may differ from the checkout if it has not been rebuilt.'
        ),
      ];
    });
  const again = button('Scan again', (b) => {
    root.replaceChildren(head);
    act(b, () => scan(true));
  });
  const head = pageHead('Repositories', again);
  root.append(head);
  scan(false);
}
