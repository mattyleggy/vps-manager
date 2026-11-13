'use strict';
const { q } = require('../ssh');
const { check } = require('../validate');

const SEP = '@@VPSM@@';

const jsonLines = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));

const label = (labels, key) => {
  const m = new RegExp(`(?:^|,)${key.replace(/\./g, '\\.')}=([^,]*)`).exec(labels || '');
  return m ? m[1] : '';
};

const COMPOSE_ACTIONS = {
  rebuild: { args: 'up -d --build --remove-orphans', title: 'Rebuild' },
  pull: { args: 'pull', then: 'up -d --remove-orphans', title: 'Pull & recreate' },
  restart: { args: 'restart', title: 'Restart' },
  stop: { args: 'stop', title: 'Stop' },
  start: { args: 'up -d', title: 'Start' },
  logs: { args: 'logs --no-color --tail 300', title: 'Logs' },
};

module.exports = (ssh) => {
  async function composeProjects() {
    const r = await ssh.exec('docker compose ls -a --format json', { sudo: true, read: true });
    if (r.code !== 0) return [];
    try {
      return JSON.parse(r.stdout).map((p) => ({ name: p.Name, status: p.Status, configFiles: String(p.ConfigFiles || '').split(',').filter(Boolean) }));
    } catch {
      return [];
    }
  }

  return {
    async list() {
      const r = await ssh.exec(
        `command -v docker >/dev/null || exit 127
docker ps -a --no-trunc --format '{{json .}}' || exit 1
echo '${SEP}'
docker system df --format '{{json .}}' 2>/dev/null`,
        { sudo: true, read: true }
      );
      if (r.code === 127) return { installed: false, containers: [], projects: [], df: [] };
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'docker ps failed');
      const [ps, df] = r.stdout.split(SEP);
      const containers = jsonLines(ps).map((c) => ({
        id: c.ID.slice(0, 12),
        name: c.Names,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports,
        project: label(c.Labels, 'com.docker.compose.project'),
        service: label(c.Labels, 'com.docker.compose.service'),
      }));
      return { installed: true, containers, projects: await composeProjects(), df: jsonLines(df || '') };
    },

    async container({ name, action }) {
      check('dockerId', name);
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Unknown action');
      await ssh.run(`docker ${action} ${q(name)}`, { sudo: true, what: `${action[0].toUpperCase()}${action.slice(1)} the container ${name}` });
    },

    async logs({ name, tail = 300 }) {
      check('dockerId', name);
      const r = await ssh.exec(`docker logs --tail ${Number(tail) || 300} ${q(name)} 2>&1`, { sudo: true, read: true });
      return r.stdout;
    },

    /** Returns { title, cmd } for a streamed job. Config file paths come from the server, not the UI. */
    async composeCommand({ project, action }) {
      const act = COMPOSE_ACTIONS[action];
      if (!act) throw new Error('Unknown action');
      const p = (await composeProjects()).find((x) => x.name === project);
      if (!p || !p.configFiles.length) throw new Error(`Compose project "${project}" not found on the server`);
      const dir = p.configFiles[0].replace(/\/[^/]*$/, '') || '/';
      const base = `docker compose -p ${q(p.name)} ${p.configFiles.map((f) => `-f ${q(f)}`).join(' ')}`;
      const cmd = `cd ${q(dir)} && ${base} ${act.args}${act.then ? ` && ${base} ${act.then}` : ''} 2>&1`;
      return { title: `${act.title}: ${p.name}`, cmd, read: action === 'logs' };
    },

    pruneCommand: () => 'docker image prune -f && docker builder prune -f',

    /** Whole build cache, not just dangling layers: this is what actually fills the disk. */
    pruneBuildCommand: () => 'docker builder prune -af 2>&1 && echo && df -h /',
  };
};
