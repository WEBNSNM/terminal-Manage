const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const {
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
