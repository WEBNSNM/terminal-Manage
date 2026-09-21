const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getSafeCategories,
  isPathInsideRoot,
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
