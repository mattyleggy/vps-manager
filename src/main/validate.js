'use strict';

const RULES = {
  siteName: [/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, 'Site name may only contain letters, numbers, dots, dashes and underscores'],
  domain: [/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i, 'Not a valid domain name'],
  email: [/^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/, 'Not a valid email address'],
  dockerId: [/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'Invalid container name'],
  projectName: [/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/, 'Project name may only contain letters, numbers, dashes and underscores'],
  repo: [/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'Repository must look like owner/name'],
  branch: [/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/, 'Invalid branch name'],
  urlPath: [/^\/[A-Za-z0-9._\/~-]*$/, 'Path must start with / and contain only letters, numbers and . _ ~ - /'],
  aptPackage: [/^[a-z0-9][a-z0-9+.-]{0,99}(:[a-z0-9]+)?$/, 'Not a valid package name'],
  owner: [/^[a-z_][a-z0-9_-]{0,31}(:[a-z_][a-z0-9_-]{0,31})?$/, 'Owner must be a Linux user, or user:group'],
  absPath: [/^\/[A-Za-z0-9._\/@+-]*$/, 'Path must be absolute and contain no spaces or special characters'],
};

/** Returns the value, or throws a user-facing error. */
function check(kind, value) {
  const [re, msg] = RULES[kind];
  const v = String(value == null ? '' : value).trim();
  if (!re.test(v) || v.includes('..')) throw new Error(`${msg}: "${v}"`);
  return v;
}

function port(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`Invalid port: "${value}"`);
  return n;
}

module.exports = { check, port };
