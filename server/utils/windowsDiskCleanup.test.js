const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { openWindowsDiskCleanup } = require('./windowsDiskCleanup');

test('opens Windows Disk Cleanup with a fixed C drive command', async () => {
  const calls = [];
  const child = new EventEmitter();
  const resultPromise = openWindowsDiskCleanup({
    platform: 'win32',
    spawnImpl: (...args) => {
      calls.push(args);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });

  const result = await resultPromise;

  assert.deepEqual(calls, [['cleanmgr.exe', ['/d', 'C:'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }]]);
  assert.deepEqual(result, { success: true });
});

test('rejects Windows Disk Cleanup launcher on non-Windows platforms', async () => {
  await assert.rejects(
    () => openWindowsDiskCleanup({ platform: 'linux', spawnImpl: () => { throw new Error('must not spawn'); } }),
    /仅支持 Windows/
  );
});

test('reports launcher errors without exposing arbitrary command input', async () => {
  const child = new EventEmitter();
  const resultPromise = openWindowsDiskCleanup({
    platform: 'win32',
    spawnImpl: () => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })));
      return child;
    },
  });

  await assert.rejects(resultPromise, (error) => error.code === 'ENOENT');
});
