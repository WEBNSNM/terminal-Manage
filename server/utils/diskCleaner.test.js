const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
  cleanSafeCategories,
  getSafeCategories,
  getDriveSpace,
  isPathInsideRoot,
  scanSafeCategories,
} = require('./diskCleaner');

test('getSafeCategories returns only declared Windows cache roots and deduplicates temp', () => {
  const categories = getSafeCategories({
    platform: 'win32',
    tempDir: 'C:\\Users\\dev\\AppData\\Local\\Temp',
    localAppData: 'C:\\Users\\dev\\AppData\\Local',
    userData: 'C:\\Users\\dev\\AppData\\Roaming\\terminalManage',
  });

  assert.deepEqual(categories.map(({ id, paths }) => ({ id, paths })), [
    { id: 'user-temp', paths: ['C:\\Users\\dev\\AppData\\Local\\Temp'] },
    { id: 'npm-cache', paths: ['C:\\Users\\dev\\AppData\\Local\\npm-cache'] },
    {
      id: 'pnpm-cache',
      paths: [
        'C:\\Users\\dev\\AppData\\Local\\pnpm\\store',
        'C:\\Users\\dev\\AppData\\Local\\pnpm-store',
      ],
    },
    { id: 'yarn-cache', paths: ['C:\\Users\\dev\\AppData\\Local\\Yarn\\Cache'] },
    {
      id: 'devmaster-cache',
      paths: [
        'C:\\Users\\dev\\AppData\\Roaming\\terminalManage\\Cache',
        'C:\\Users\\dev\\AppData\\Roaming\\terminalManage\\Code Cache',
        'C:\\Users\\dev\\AppData\\Roaming\\terminalManage\\GPUCache',
      ],
    },
  ]);
});

test('getSafeCategories rejects non-Windows platforms', () => {
  assert.throws(
    () => getSafeCategories({ platform: 'darwin' }),
    /仅支持 Windows/
  );
});

test('isPathInsideRoot accepts only strict descendants using Windows semantics', () => {
  const root = 'C:\\Users\\dev\\AppData\\Local\\Temp';
  assert.equal(isPathInsideRoot(`${root}\\file.tmp`, root), true);
  assert.equal(isPathInsideRoot(root.toLowerCase(), root), false);
  assert.equal(isPathInsideRoot(`${root}-backup\\file.tmp`, root), false);
  assert.equal(isPathInsideRoot(`${root}\\..\\Documents\\note.txt`, root), false);
  assert.equal(isPathInsideRoot('D:\\Temp\\file.tmp', root), false);
});

test('scanSafeCategories counts regular files and does not follow symbolic links', async (t) => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk-cleaner-scan-'));
  t.after(() => fsp.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'cache');
  const outside = path.join(sandbox, 'outside');
  await fsp.mkdir(path.join(root, 'nested'), { recursive: true });
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(root, 'a.tmp'), Buffer.alloc(4));
  await fsp.writeFile(path.join(root, 'nested', 'b.tmp'), Buffer.alloc(7));
  await fsp.writeFile(path.join(outside, 'keep.txt'), Buffer.alloc(100));

  let symlinkCreated = false;
  try {
    await fsp.symlink(outside, path.join(root, 'outside-link'), 'junction');
    symlinkCreated = true;
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }

  const result = await scanSafeCategories({
    platform: 'win32',
    categories: [{ id: 'test-cache', name: 'Test', description: 'Test cache', paths: [root] }],
  });

  assert.equal(result.categories[0].fileCount, 2);
  assert.equal(result.categories[0].sizeBytes, 11);
  assert.equal(result.totals.fileCount, 2);
  if (symlinkCreated) assert.equal(result.categories[0].skippedCount, 1);
});

test('scanSafeCategories rejects non-Windows platforms before touching files', async () => {
  await assert.rejects(
    () => scanSafeCategories({ platform: 'darwin', categories: [] }),
    /仅支持 Windows/
  );
});

test('getDriveSpace maps statfs values into total, free, and used bytes', async () => {
  const drive = await getDriveSpace('C:\\', {
    statfs: async () => ({ bsize: 4, blocks: 100, bfree: 30, bavail: 25 }),
  });
  assert.deepEqual(drive, {
    drive: 'C:\\',
    totalBytes: 400,
    freeBytes: 100,
    usedBytes: 300,
  });
});

test('cleanSafeCategories removes selected cache contents but preserves roots and unselected data', async (t) => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk-cleaner-clean-'));
  t.after(() => fsp.rm(sandbox, { recursive: true, force: true }));
  const selectedRoot = path.join(sandbox, 'selected');
  const unselectedRoot = path.join(sandbox, 'unselected');
  await fsp.mkdir(path.join(selectedRoot, 'nested'), { recursive: true });
  await fsp.mkdir(unselectedRoot);
  await fsp.writeFile(path.join(selectedRoot, 'nested', 'remove.bin'), Buffer.alloc(9));
  await fsp.writeFile(path.join(unselectedRoot, 'keep.bin'), Buffer.alloc(5));
  const categories = [
    { id: 'selected', name: 'Selected', description: '', paths: [selectedRoot] },
    { id: 'unselected', name: 'Unselected', description: '', paths: [unselectedRoot] },
  ];

  const result = await cleanSafeCategories(['selected'], { platform: 'win32', categories });

  assert.equal(result.releasedBytes, 9);
  assert.equal(result.deletedFiles, 1);
  assert.equal((await fsp.readdir(selectedRoot)).length, 0);
  assert.equal((await fsp.stat(selectedRoot)).isDirectory(), true);
  assert.equal((await fsp.stat(path.join(unselectedRoot, 'keep.bin'))).size, 5);
});

test('cleanSafeCategories rejects unknown and empty category selections', async () => {
  const categories = [{ id: 'known', name: 'Known', description: '', paths: ['C:\\Temp'] }];
  await assert.rejects(
    () => cleanSafeCategories([], { platform: 'win32', categories }),
    /至少选择一个/
  );
  await assert.rejects(
    () => cleanSafeCategories(['unknown'], { platform: 'win32', categories }),
    /未知的清理类别/
  );
});

test('cleanSafeCategories skips symbolic links and leaves their targets untouched', async (t) => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk-cleaner-link-'));
  t.after(() => fsp.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'cache');
  const outside = path.join(sandbox, 'outside');
  await fsp.mkdir(root);
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'keep.bin'), Buffer.alloc(6));

  try {
    await fsp.symlink(outside, path.join(root, 'outside-link'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Junction creation is unavailable');
    throw error;
  }

  const result = await cleanSafeCategories(['cache'], {
    platform: 'win32',
    categories: [{ id: 'cache', name: 'Cache', description: '', paths: [root] }],
  });

  assert.equal(result.skippedCount, 1);
  assert.equal((await fsp.stat(path.join(outside, 'keep.bin'))).size, 6);
  assert.equal((await fsp.lstat(path.join(root, 'outside-link'))).isSymbolicLink(), true);
});

test('cleanSafeCategories continues after a file deletion failure', async (t) => {
  const sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'disk-cleaner-error-'));
  t.after(() => fsp.rm(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'cache');
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(root, 'busy.bin'), Buffer.alloc(3));
  await fsp.writeFile(path.join(root, 'remove.bin'), Buffer.alloc(7));
  const io = {
    readdir: (...args) => fsp.readdir(...args),
    lstat: (...args) => fsp.lstat(...args),
    rmdir: (...args) => fsp.rmdir(...args),
    unlink: async (target) => {
      if (path.basename(target) === 'busy.bin') {
        const error = new Error('busy');
        error.code = 'EBUSY';
        throw error;
      }
      return fsp.unlink(target);
    },
  };

  const result = await cleanSafeCategories(['cache'], {
    platform: 'win32',
    categories: [{ id: 'cache', name: 'Cache', description: '', paths: [root] }],
    io,
  });

  assert.equal(result.deletedFiles, 1);
  assert.equal(result.releasedBytes, 7);
  assert.equal(result.failedCount, 1);
  assert.equal((await fsp.stat(path.join(root, 'busy.bin'))).size, 3);
  await assert.rejects(() => fsp.stat(path.join(root, 'remove.bin')), { code: 'ENOENT' });
});
