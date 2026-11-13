'use strict';
// "Who does GitHub think this SSH key belongs to?" - the same check as `ssh -T git@github.com`.
//
// GitHub's SSH endpoint only speaks git, so a key cannot list repositories. What it can do is
// name the account: GitHub greets an account key with "Hi <login>!" (and a deploy key with
// "Hi <owner>/<repo>!"). That login is then enough to list the account's public repositories.

const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');

// GitHub's published SSH host key fingerprints
// (https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).
// Anything else answering as github.com is refused before the key is offered.
const GITHUB_HOST_KEYS = new Set([
  'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU', // Ed25519
  'SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM', // ECDSA
  'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s', // RSA
]);

/** "Hi octocat! You've successfully authenticated..." -> { login: 'octocat', deployKeyFor: null } */
function parseGreeting(text) {
  const m = /Hi ([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(\/[A-Za-z0-9_.-]+)?!/.exec(String(text));
  if (!m) return null;
  return { login: m[1], deployKeyFor: m[2] ? m[1] + m[2] : null };
}

/**
 * auth: { authType: 'key' | 'agent', keyPath, passphrase }.
 * Resolves { login, deployKeyFor } or null when GitHub does not recognise the key.
 */
function whoami(auth, { timeout = 12000 } = {}) {
  return new Promise((resolve) => {
    const client = new Client();
    let text = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client.end();
      resolve(parseGreeting(text));
    };
    const timer = setTimeout(finish, timeout);

    const opts = {
      host: 'github.com',
      port: 22,
      username: 'git',
      readyTimeout: timeout,
      hostVerifier: (key) => GITHUB_HOST_KEYS.has('SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')),
    };
    try {
      if (auth.authType === 'agent') {
        opts.agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
      } else {
        if (!auth.keyPath) return finish();
        opts.privateKey = fs.readFileSync(auth.keyPath);
        if (auth.passphrase) opts.passphrase = auth.passphrase;
      }
    } catch {
      return finish();
    }

    client.on('ready', () => {
      // A shell without a terminal, like `ssh -T`: GitHub prints its greeting and hangs up.
      client.shell(false, (err, stream) => {
        if (err) return finish();
        const add = (d) => (text += d.toString('utf8'));
        stream.on('data', add);
        stream.stderr.on('data', add);
        stream.on('close', finish);
      });
    });
    client.on('error', finish);
    client.on('close', finish);
    try {
      client.connect(opts);
    } catch {
      finish();
    }
  });
}

module.exports = { whoami, parseGreeting, GITHUB_HOST_KEYS };
