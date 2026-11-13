'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { Ssh, ops, newOp } = require('../src/main/ssh');

/** An Ssh whose "server" just records the command lines it is asked to execute. */
function fakeSsh() {
  const ssh = new Ssh();
  const ran = [];
  ssh.info = { host: 'h', username: 'deploy', isRoot: false };
  ssh.client = {
    exec(line, cb) {
      ran.push(line);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.end = () => setImmediate(() => stream.emit('close', 0));
      cb(null, stream);
    },
  };
  return { ssh, ran };
}

test('a change outside a reviewed operation is refused and never reaches the server', async () => {
  const { ssh, ran } = fakeSsh();
  await assert.rejects(ssh.exec('rm -rf /srv/app', { sudo: true }), /without being reviewed/);
  await assert.rejects(ssh.writeFile('/etc/x', 'data'), /without being reviewed/);
  assert.deepStrictEqual(ran, []);
});

test('reads run without review', async () => {
  const { ssh, ran } = fakeSsh();
  await ssh.exec('docker ps', { read: true });
  assert.strictEqual(ran.length, 1);
});

test('plan mode records changes (with stdin) but only runs reads', async () => {
  const { ssh, ran } = fakeSsh();
  const op = newOp();
  await ops.run(op, async () => {
    await ssh.exec('cat /etc/thing', { read: true });
    await ssh.run('systemctl restart nginx', { sudo: true, what: 'Restart nginx' });
    await ssh.writeFile('/etc/x', 'hello');
  });
  assert.strictEqual(ran.length, 1);
  assert.match(ran[0], /cat \/etc\/thing/);
  assert.deepStrictEqual(op.steps.map((s) => [s.what, s.asRoot, s.input]), [['Restart nginx', true, null], ['Write /etc/x', true, 'hello']]);
  assert.strictEqual(op.steps[0].cmd, 'systemctl restart nginx');
});

test('apply mode runs exactly the approved steps', async () => {
  const { ssh, ran } = fakeSsh();
  const op = newOp();
  const action = () => ssh.run('systemctl restart nginx', { sudo: true });
  await ops.run(op, action);
  op.mode = 'apply';
  await ops.run(op, action);
  assert.deepStrictEqual(ran, [`sudo -n bash -c 'systemctl restart nginx'`]);
});

test('apply mode refuses a command, stdin or extra step that was not approved', async () => {
  for (const [planned, actual] of [
    [() => ['echo a', {}], () => ['echo b', {}]],
    [() => ['cat > f', { input: 'approved' }], () => ['cat > f', { input: 'different' }]],
    [() => ['echo a', {}], () => ['echo a', { sudo: true }]],
  ]) {
    const { ssh, ran } = fakeSsh();
    const op = newOp();
    await ops.run(op, () => ssh.exec(...planned()));
    op.mode = 'apply';
    await assert.rejects(ops.run(op, () => ssh.exec(...actual())), /changed between the review and the run/);
    assert.deepStrictEqual(ran, []);
  }
  const { ssh, ran } = fakeSsh();
  const op = newOp();
  await ops.run(op, () => ssh.exec('echo one'));
  op.mode = 'apply';
  await ops.run(op, () => ssh.exec('echo one'));
  await assert.rejects(ops.run(op, () => ssh.exec('echo two')), /changed between/);
  assert.strictEqual(ran.length, 1);
});

test('memo gives the plan and the real run the same generated value', async () => {
  const { ssh } = fakeSsh();
  const op = newOp();
  let n = 0;
  const a = await ops.run(op, async () => ssh.memo('secret', () => ++n));
  op.mode = 'apply';
  const b = await ops.run(op, async () => ssh.memo('secret', () => ++n));
  assert.strictEqual(a, b);
});

test('concurrent operations do not see each other', async () => {
  const { ssh, ran } = fakeSsh();
  const op1 = newOp();
  const op2 = newOp();
  await Promise.all([ops.run(op1, () => ssh.exec('echo 1')), ops.run(op2, () => ssh.exec('echo 2'))]);
  assert.deepStrictEqual([op1.steps[0].cmd, op2.steps[0].cmd], ['echo 1', 'echo 2']);
  assert.deepStrictEqual(ran, []);
});

test('non-SSH steps (external) are planned, shown and only run once approved', async () => {
  const { ssh, ran } = fakeSsh();
  let calls = 0;
  const step = { what: 'Add key on GitHub', via: 'GitHub API', display: 'POST /repos/me/app/keys' };
  await assert.rejects(ssh.external(step, () => ++calls), /without being reviewed/);
  const op = newOp();
  const action = async () => {
    await ssh.exec('ssh-keygen', { sudo: true });
    return ssh.external(step, () => ++calls);
  };
  await ops.run(op, action);
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(op.steps.map((s) => [s.cmd, s.via]), [['ssh-keygen', undefined], ['POST /repos/me/app/keys', 'GitHub API']]);
  op.mode = 'apply';
  assert.strictEqual(await ops.run(op, action), 1);
  assert.strictEqual(ran.length, 1);

  // an external step cannot be swapped for an SSH command, or changed, after approval
  const op2 = newOp();
  await ops.run(op2, () => ssh.external(step, () => ++calls));
  op2.mode = 'apply';
  await assert.rejects(ops.run(op2, () => ssh.exec('POST /repos/me/app/keys')), /changed between/);
  const op3 = newOp();
  await ops.run(op3, () => ssh.external(step, () => ++calls));
  op3.mode = 'apply';
  await assert.rejects(ops.run(op3, () => ssh.external({ ...step, display: 'POST /repos/other/repo/keys' }, () => ++calls)), /changed between/);
  assert.strictEqual(calls, 1);
});
