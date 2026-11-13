'use strict';
const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { AsyncLocalStorage } = require('async_hooks');

/**
 * Review gate. Every command that is not flagged { read: true } is a change to the server
 * and may only run inside an "operation" the user has approved:
 *
 *   plan  - the action runs with reads executed for real, but each change is only recorded
 *   apply - after approval the action runs again; each change must match the recorded,
 *           approved step exactly (same command, same stdin) or it is refused
 *
 * A change attempted outside an operation is refused outright, so a forgotten flag fails
 * closed (asks too often / errors) rather than silently changing the server.
 */
const ops = new AsyncLocalStorage();
const newOp = () => ({ mode: 'plan', steps: [], next: 0, memo: {} });
const planning = () => {
  const op = ops.getStore();
  return !!op && op.mode === 'plan';
};

/** Quote a value for safe use as a single POSIX shell word. */
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\r(?!\n)/g;
const stripAnsi = (s) => s.replace(ANSI, '');

class HostKeyError extends Error {
  constructor(kind, fingerprint, known) {
    super(kind === 'unknown' ? 'Unknown host key' : 'Host key has CHANGED since it was last trusted');
    this.hostKey = { kind, fingerprint, known };
  }
}

class Ssh extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.info = null;
  }

  get connected() {
    return !!this.client;
  }

  /**
   * cfg: { host, port, username, authType: 'key'|'agent'|'password', keyPath, secret }
   * trust: { known, accept } - known = stored fingerprint, accept = fingerprint the user just approved.
   */
  connect(cfg, trust = {}) {
    this.disconnect();
    return new Promise((resolve, reject) => {
      const client = new Client();
      let hostKeyError = null;
      let fingerprint = null;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        client.end();
        reject(hostKeyError || err);
      };

      const opts = {
        host: cfg.host,
        port: Number(cfg.port) || 22,
        username: cfg.username || 'root',
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          if (trust.known) {
            if (trust.known === fingerprint) return true;
            if (trust.accept !== fingerprint) {
              hostKeyError = new HostKeyError('changed', fingerprint, trust.known);
              return false;
            }
            return true;
          }
          if (trust.accept === fingerprint) return true;
          hostKeyError = new HostKeyError('unknown', fingerprint, null);
          return false;
        },
      };

      try {
        if (cfg.authType === 'password') {
          opts.password = cfg.secret || '';
        } else if (cfg.authType === 'agent') {
          opts.agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
        } else {
          if (!cfg.keyPath) throw new Error('No private key file selected');
          opts.privateKey = fs.readFileSync(cfg.keyPath);
          if (cfg.secret) opts.passphrase = cfg.secret;
        }
      } catch (e) {
        return reject(e);
      }

      client.on('ready', () => {
        settled = true;
        this.client = client;
        this.info = { host: opts.host, port: opts.port, username: opts.username, isRoot: opts.username === 'root', fingerprint };
        resolve(this.info);
      });
      client.on('error', fail);
      client.on('close', () => {
        if (this.client === client) {
          this.client = null;
          this.info = null;
          this.emit('closed');
        }
        fail(new Error('Connection closed'));
      });

      try {
        client.connect(opts);
      } catch (e) {
        fail(e);
      }
    });
  }

  disconnect() {
    if (this.client) {
      const c = this.client;
      this.client = null;
      this.info = null;
      c.end();
      this.emit('closed');
    }
  }

  wrap(cmd, sudo) {
    const inner = `bash -c ${q(cmd)}`;
    return sudo && !this.info.isRoot ? `sudo -n ${inner}` : inner;
  }

  /**
   * Run a command. opts: { sudo, input, onData, timeout }.
   * Resolves { code, stdout, stderr } - never rejects on a non-zero exit.
   */
  exec(cmd, opts = {}) {
    let report = null; // set for an approved step when the operation wants progress (op.onStep)
    let tap = null; // set for an approved step when the operation wants its output (op.onOutput)
    if (!opts.read) {
      if (!this.client) return Promise.reject(new Error('Not connected to the server'));
      const op = ops.getStore();
      const step = {
        what: opts.what || '',
        cmd: cmd.trim(),
        asRoot: !!opts.sudo || this.info.isRoot,
        input: opts.input != null ? String(opts.input) : null,
      };
      if (!op) return Promise.reject(new Error('Internal error: a change was attempted without being reviewed. Nothing was run.'));
      if (op.mode === 'plan') {
        op.steps.push(step);
        return Promise.resolve({ code: 0, stdout: '', stderr: '' });
      }
      const approved = op.steps[op.next++];
      if (!approved || approved.cmd !== step.cmd || approved.input !== step.input || approved.asRoot !== step.asRoot || approved.via) {
        return Promise.reject(
          new Error('The server changed between the review and the run, so the remaining steps were not run. Start the action again to review an updated plan.')
        );
      }
      if (op.onStep) {
        const index = op.next - 1;
        report = (state, code) => op.onStep(index, state, code);
        report('run');
      }
      if (op.onOutput) {
        tap = op.onOutput;
        const lines = step.cmd.split('\n');
        tap(`$ ${step.what && lines.length > 1 ? `${step.what} (${lines.length}-line script)` : lines[0]}\n`);
      }
    }
    const done = new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected to the server'));
      this.client.exec(this.wrap(cmd, opts.sudo), (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let timer = null;
        let done = false;
        const dOut = new StringDecoder('utf8');
        const dErr = new StringDecoder('utf8');
        if (opts.timeout) {
          timer = setTimeout(() => {
            done = true;
            stream.close();
            reject(new Error('Command timed out'));
          }, opts.timeout);
        }
        stream.on('data', (d) => {
          const s = dOut.write(d);
          stdout += s;
          if (opts.onData) opts.onData(stripAnsi(s));
          if (tap) tap(stripAnsi(s));
        });
        stream.stderr.on('data', (d) => {
          const s = dErr.write(d);
          stderr += s;
          if (opts.onData) opts.onData(stripAnsi(s));
          if (tap) tap(stripAnsi(s));
        });
        stream.on('close', (code) => {
          if (done) return;
          clearTimeout(timer);
          if (tap && code !== 0) tap(`\n[exit code ${code == null ? '?' : code}]\n`);
          resolve({ code: code == null ? -1 : code, stdout, stderr });
        });
        stream.end(opts.input != null ? opts.input : undefined);
      });
    });
    if (!report) return done;
    return done.then(
      (r) => {
        report(r.code === 0 ? 'ok' : 'fail', r.code);
        return r;
      },
      (e) => {
        report('fail');
        throw e;
      }
    );
  }

  /** Like exec but throws (with the command's own error output) on a non-zero exit. */
  async run(cmd, opts = {}) {
    const r = await this.exec(cmd, opts);
    if (r.code !== 0) {
      let msg = stripAnsi(r.stderr || r.stdout).trim() || `Command failed with exit code ${r.code}`;
      if (/sudo: a password is required/.test(msg)) {
        msg = `User "${this.info && this.info.username}" needs passwordless sudo for this (or connect as root).`;
      }
      const e = new Error(msg);
      e.code = r.code;
      throw e;
    }
    return r.stdout;
  }

  /** Run a python3 script on the server (sent over stdin) and parse its JSON output. */
  async python(script, opts = {}) {
    const out = await this.run('python3 -', { ...opts, read: true, input: script, timeout: opts.timeout || 60000 });
    return JSON.parse(out);
  }

  /**
   * A change that is not an SSH command (for example a GitHub API call). It goes through the
   * same gate: recorded and shown during planning, and run only as an approved step.
   * display is the exact text shown in the review dialog; via names where it runs.
   */
  async external({ what, display, via }, fn) {
    const op = ops.getStore();
    const step = { what, cmd: display, via, asRoot: false, input: null };
    if (!op) throw new Error('Internal error: a change was attempted without being reviewed. Nothing was run.');
    if (op.mode === 'plan') {
      op.steps.push(step);
      return undefined;
    }
    const approved = op.steps[op.next++];
    if (!approved || approved.cmd !== step.cmd || approved.via !== step.via) {
      throw new Error('The plan changed between the review and the run, so the remaining steps were not run. Start the action again to review an updated plan.');
    }
    if (op.onOutput) op.onOutput(`> ${what || via} (${via})\n`);
    if (!op.onStep) return fn();
    const index = op.next - 1;
    op.onStep(index, 'run');
    try {
      const result = await fn();
      op.onStep(index, 'ok');
      return result;
    } catch (e) {
      op.onStep(index, 'fail');
      throw e;
    }
  }

  /** A value that must be identical in the reviewed plan and the real run (e.g. a generated secret). */
  memo(key, make) {
    const op = ops.getStore();
    if (!op) return make();
    if (!(key in op.memo)) op.memo[key] = make();
    return op.memo[key];
  }

  /**
   * An interactive login shell on a pseudo-terminal, for the terminal panel. This is the user
   * typing at the server themselves, so it is deliberately outside the review gate.
   * Resolves the ssh2 channel (a duplex stream with setWindow(rows, cols, height, width)).
   */
  shell({ cols = 80, rows = 24 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Not connected to the server'));
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
  }

  /** Write a file as root via stdin (no temp files, no SFTP). */
  async writeFile(path, content, { mode = '644', what } = {}) {
    await this.run(`umask 077; cat > ${q(path + '.tmp')} && chmod ${mode} ${q(path + '.tmp')} && mv -f ${q(path + '.tmp')} ${q(path)}`, {
      sudo: true,
      input: content,
      what: what || `Write ${path}`,
    });
  }
}

module.exports = { Ssh, q, stripAnsi, HostKeyError, ops, newOp, planning };
