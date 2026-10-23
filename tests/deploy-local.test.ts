import assert from 'node:assert/strict';
import test from 'node:test';
import { deployLocal, launchPid, type DeployIO } from '../scripts/deploy-local.js';

function fixture() {
  const calls: string[] = [], lines: string[] = [];
  const pids = new Map([['claude',101],['codex',102],['agy',103]]);
  let polls = 0;
  const io: DeployIO = {
    uid: 501, port: '8787',
    command: (command,args) => {
      calls.push(`${command} ${args.join(' ')}`);
      if (command === 'launchctl' && args[0] === 'list') {
        if (args.length === 1) return 'PID Status Label\n101 0 com.swarma.bridge.claude\n102 0 com.swarma.bridge.codex\n103 0 com.swarma.bridge.agy\n- 0 com.swarma.bridge.stopped\n104 0 com.other.app\n';
        return `{\n "PID" = ${pids.get(args[1]!.split('.').at(-1)!)};\n}`;
      }
      return '';
    },
    signal: pid => { calls.push(`signal ${pid}`); },
    sleep: async ms => {
      calls.push(`sleep ${ms}`);
      if (++polls === 2) pids.set('claude',201);
      if (polls === 3) { pids.set('codex',202); pids.set('agy',203); }
    },
    status: async () => { calls.push('status'); return [{name:'worker-claude',running:[{}]}]; },
    healthy: async url => { calls.push(`health ${url}`); return true; },
    log: line => { lines.push(line); },
  };
  return {io,calls,lines,pids};
}

test('dry-run shows current bridge PIDs and service restart and performs only list reads', async () => {
  const x = fixture(); await deployLocal(['--dry-run'],x.io);
  assert.equal(x.calls.length,4);
  assert.ok(x.calls.every(c => c.startsWith('launchctl list')));
  for (const [provider,pid] of x.pids) assert.ok(x.lines.some(l => l.includes(`bridge.${provider} (PID ${pid})`)));
  assert.ok(x.lines.some(l => l.includes('npm run build')));
  assert.ok(x.lines.some(l => l.includes('launchctl kickstart -k gui/501/com.swarma.service')));
});

test('deploy builds first, drains all bridges, waits for all new PIDs, then restarts and checks service', async () => {
  const x = fixture(); await deployLocal([],x.io);
  assert.equal(x.calls[0],'npm run build');
  assert.equal(x.calls.filter(c => c.startsWith('signal')).length,3);
  assert.ok(x.calls.indexOf('signal 103') < x.calls.indexOf('sleep 2000'));
  const restart = x.calls.indexOf('launchctl kickstart -k gui/501/com.swarma.service');
  assert.ok(restart > x.calls.lastIndexOf('launchctl list com.swarma.bridge.agy'));
  assert.equal(x.calls.at(-1),'health http://127.0.0.1:8787/.well-known/oauth-authorization-server');
  assert.ok(x.lines.some(l => l.includes('1 running task(s)')));
  assert.ok(x.lines.some(l => l.includes('PID 101 -> 201')));
  assert.ok(x.lines.some(l => l.includes('PID 103 -> 203')));
});

test('--only and --no-service restrict both dry-run and execution', async () => {
  for (const dry of [true,false]) {
    const x = fixture(); await deployLocal(['--only','codex','--no-service',...(dry ? ['--dry-run'] : [])],x.io);
    assert.ok(!x.calls.some(c => c.includes('kickstart') || c.startsWith('health')));
    assert.ok(!x.calls.some(c => c.includes('bridge.claude') || c.includes('bridge.agy')));
    assert.deepEqual(x.calls.filter(c => c.startsWith('signal')),dry ? [] : ['signal 102']);
  }
});

test('build failure and invalid flags never signal or restart anything', async () => {
  const x = fixture(); x.io.command = () => { throw new Error('build failed'); };
  await assert.rejects(deployLocal([],x.io),/build failed/);
  assert.deepEqual(x.calls,[]);
  const y = fixture(); await assert.rejects(deployLocal(['--only','other'],y.io),/Usage:/);
  assert.deepEqual(y.calls,[]);
});

test('PID disappearance and missing status wait safely; no health 200 fails with a bounded wait', async () => {
  const x = fixture(); let sleeps = 0;
  x.io.sleep = async () => { if (++sleeps === 1) x.pids.delete('codex'); else x.pids.set('codex',202); };
  x.io.status = async () => { throw new Error('unavailable'); };
  x.io.healthy = async () => false;
  await assert.rejects(deployLocal(['--only','codex'],x.io),/did not return HTTP 200/);
  assert.ok(x.lines.some(l => l.includes('waiting for launchd')));
  assert.ok(x.lines.some(l => l.includes('PID 102 -> 202')));
  assert.equal(sleeps,32);
});

test('a PID change before signaling stops the deploy before service restart', async () => {
  const x = fixture(), command = x.io.command; let reads = 0;
  x.io.command = (cmd,args,timeout) => {
    if (args[1] === 'com.swarma.bridge.codex' && ++reads === 2) x.pids.set('codex',202);
    return command(cmd,args,timeout);
  };
  await assert.rejects(deployLocal(['--only','codex'],x.io),/changed PID before drain/);
  assert.ok(!x.calls.some(c => c.startsWith('signal') || c.includes('kickstart')));
});

test('launchctl dictionary PID parsing does not confuse status or missing PIDs', () => {
  assert.equal(launchPid('{ "PID" = 123; "LastExitStatus" = 9; }'),123);
  for (const text of ['', '{ "LastExitStatus" = 123; }', '{ "PID" = 0; }']) assert.equal(launchPid(text),undefined);
});
