# C 盘安全清理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Windows 用户提供一个只扫描预定义缓存目录、必须确认后才清理的 C 盘安全清理页面。

**Architecture:** 后端 `diskCleaner` 模块拥有全部白名单和文件系统能力，客户端只能提交类别 ID。Socket.io 只做适配和异常归一化，Vue 独立页面负责容量展示、选择和确认，不接受任意路径输入。

**Tech Stack:** Node.js 20+ (`node:test`, `fs/promises`, `fs.statfs`)、Socket.io 4、Vue 3、Vue Router 4、Tailwind CSS 4、TypeScript

---

## File Map

- Create `server/utils/diskCleaner.js`: safe category definitions, strict path checks, scanning, cleaning, and drive-space lookup.
- Create `server/utils/diskCleaner.test.js`: temporary-directory tests for every deletion boundary and error path.
- Modify `server/index.js`: resolve Electron userData when available and expose scan/clean Socket events.
- Create `client/src/views/disk-cleaner/index.vue`: scan, selection, confirmation, cleanup result, and unsupported-platform states.
- Modify `client/src/router/index.ts`: lazy route for `/disk-cleaner`.
- Modify `client/src/views/dashboard/index.vue`: disk-cleaner navigation entry.

### Task 1: Safe Category and Path Boundary Primitives

**Files:**
- Create: `server/utils/diskCleaner.test.js`
- Create: `server/utils/diskCleaner.js`

- [ ] **Step 1: Write failing tests for category construction and strict child paths**

Create `server/utils/diskCleaner.test.js` with Node's built-in test runner. The first tests must assert:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
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
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test server/utils/diskCleaner.test.js`

Expected: FAIL with `Cannot find module './diskCleaner'`.

- [ ] **Step 3: Implement category construction and path checks**

Create `server/utils/diskCleaner.js` with:

```js
const fs = require('fs');
const os = require('os');
const path = require('path');

const CATEGORY_META = Object.freeze({
  'user-temp': { name: '用户临时文件', description: '应用和安装程序产生的临时缓存' },
  'npm-cache': { name: 'npm 缓存', description: 'npm 下载的软件包缓存，可按需重新下载' },
  'pnpm-cache': { name: 'pnpm 缓存', description: 'pnpm 本地软件包存储缓存' },
  'yarn-cache': { name: 'Yarn 缓存', description: 'Yarn 下载的软件包缓存' },
  'devmaster-cache': { name: 'DevMaster 缓存', description: 'DevMaster 界面运行产生的缓存' },
});

const uniqueWindowsPaths = (paths) => {
  const seen = new Set();
  return paths
    .filter(Boolean)
    .map((value) => path.win32.resolve(String(value)))
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

function getSafeCategories(environment = {}) {
  const platform = environment.platform || process.platform;
  if (platform !== 'win32') throw new Error('磁盘安全清理仅支持 Windows');

  const localAppData = environment.localAppData || process.env.LOCALAPPDATA || '';
  const tempDir = environment.tempDir || os.tmpdir();
  const userData = environment.userData || '';
  if (!path.win32.isAbsolute(localAppData) || !path.win32.isAbsolute(tempDir)) {
    throw new Error('无法解析 Windows 用户缓存目录');
  }

  const definitions = [
    ['user-temp', [tempDir, path.win32.join(localAppData, 'Temp')]],
    ['npm-cache', [path.win32.join(localAppData, 'npm-cache')]],
    ['pnpm-cache', [path.win32.join(localAppData, 'pnpm', 'store'), path.win32.join(localAppData, 'pnpm-store')]],
    ['yarn-cache', [path.win32.join(localAppData, 'Yarn', 'Cache')]],
    ['devmaster-cache', userData ? ['Cache', 'Code Cache', 'GPUCache'].map((name) => path.win32.join(userData, name)) : []],
  ];

  return definitions.map(([id, paths]) => ({ id, ...CATEGORY_META[id], paths: uniqueWindowsPaths(paths) }));
}

function isPathInsideRoot(candidate, root) {
  if (!path.win32.isAbsolute(candidate) || !path.win32.isAbsolute(root)) return false;
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate));
  return relative !== '' && !relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative);
}

module.exports = { getSafeCategories, isPathInsideRoot };
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test server/utils/diskCleaner.test.js`

Expected: 3 tests PASS.

- [ ] **Step 5: Commit the primitives**

```bash
git add server/utils/diskCleaner.js server/utils/diskCleaner.test.js
git commit -m "feat: define safe disk cleanup paths"
```

### Task 2: Read-Only Scan and Drive Capacity

**Files:**
- Modify: `server/utils/diskCleaner.test.js`
- Modify: `server/utils/diskCleaner.js`

- [ ] **Step 1: Add failing scan tests using an isolated temporary directory**

Append tests that create `scan-root`, write files of known sizes, create a nested directory, and attempt to create a directory symlink. Call the wished-for API with injected categories so the test never reads real caches:

```js
const fsp = require('fs/promises');
const os = require('os');
const { scanSafeCategories, getDriveSpace } = require('./diskCleaner');

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

test('getDriveSpace maps statfs values into total, free, and used bytes', async () => {
  const drive = await getDriveSpace('C:\\', {
    statfs: async () => ({ bsize: 4, blocks: 100, bfree: 30, bavail: 25 }),
  });
  assert.deepEqual(drive, { drive: 'C:\\', totalBytes: 400, freeBytes: 100, usedBytes: 300 });
});
```

- [ ] **Step 2: Run scan tests and verify RED**

Run: `node --test server/utils/diskCleaner.test.js`

Expected: FAIL because `scanSafeCategories` and `getDriveSpace` are not exported functions.

- [ ] **Step 3: Implement an iterative, non-following scanner and capacity lookup**

Add `scanRoot(root, io)` that uses a stack, `lstat`, and `readdir({ withFileTypes: true })`. It must:

```js
async function scanRoot(root, io) {
  const result = { fileCount: 0, sizeBytes: 0, skippedCount: 0, errors: [] };
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await io.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        result.skippedCount += 1;
        result.errors.push({ path: current, code: error.code || 'UNKNOWN' });
      }
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (!isNativePathInsideRoot(candidate, root)) {
        result.skippedCount += 1;
        continue;
      }
      try {
        const stats = await io.lstat(candidate);
        if (stats.isSymbolicLink()) {
          result.skippedCount += 1;
        } else if (stats.isDirectory()) {
          stack.push(candidate);
        } else if (stats.isFile()) {
          result.fileCount += 1;
          result.sizeBytes += stats.size;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          result.skippedCount += 1;
          result.errors.push({ path: candidate, code: error.code || 'UNKNOWN' });
        }
      }
    }
  }
  return result;
}
```

Because real Windows roots use `path.win32` while temporary test directories use the host path API, add a private `isNativePathInsideRoot` based on `path.relative`; retain exported `isPathInsideRoot` for validating declared Windows roots. Implement `scanSafeCategories({ platform, categories, environment, io = fsp })`; reject non-Windows, use provided categories only for test injection, and call `getSafeCategories(environment)` whenever `categories` is absent. Aggregate each root and return `{ platform, categories, totals, durationMs }`. Limit serialized errors to the first 20 per category while retaining `skippedCount`.

Implement:

```js
async function getDriveSpace(drive = 'C:\\', io = fs.promises) {
  const stats = await io.statfs(drive);
  const totalBytes = Number(stats.bsize) * Number(stats.blocks);
  const freeBytes = Number(stats.bsize) * Number(stats.bavail);
  return { drive, totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}
```

Export `scanSafeCategories` and `getDriveSpace`.

- [ ] **Step 4: Run scan tests and verify GREEN**

Run: `node --test server/utils/diskCleaner.test.js`

Expected: all tests PASS; no real user cache is touched.

- [ ] **Step 5: Commit read-only scanning**

```bash
git add server/utils/diskCleaner.js server/utils/diskCleaner.test.js
git commit -m "feat: scan safe cache categories"
```

### Task 3: Guarded Cleanup

**Files:**
- Modify: `server/utils/diskCleaner.test.js`
- Modify: `server/utils/diskCleaner.js`

- [ ] **Step 1: Add failing cleanup tests**

Append tests for valid cleanup, unknown IDs, root preservation, symlink skipping, and partial errors. The primary behavior test is:

```js
const { cleanSafeCategories } = require('./diskCleaner');

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
  await assert.rejects(() => cleanSafeCategories([], { platform: 'win32', categories }), /至少选择一个/);
  await assert.rejects(() => cleanSafeCategories(['unknown'], { platform: 'win32', categories }), /未知的清理类别/);
});
```

For error continuation, inject an `io.unlink` wrapper that throws `{ code: 'EBUSY' }` for one named file and delegates all other methods. Assert `failedCount === 1` and that later files are still removed.

- [ ] **Step 2: Run cleanup tests and verify RED**

Run: `node --test server/utils/diskCleaner.test.js`

Expected: FAIL because `cleanSafeCategories` is not defined.

- [ ] **Step 3: Implement cleanup without recursive `rm`**

Implement a post-order `cleanRoot` traversal that calls `lstat` before every action, skips symbolic links/junctions, verifies every candidate remains a strict descendant, unlinks ordinary files, and removes empty child directories with `rmdir`. Never call `rm(root, { recursive: true })` and never call `rmdir` on the root.

Return these exact shapes:

```js
// per category
{ id, name, releasedBytes, deletedFiles, skippedCount, failedCount, errors }

// total
{ success: true, releasedBytes, deletedFiles, skippedCount, failedCount, categories }
```

Before traversing, normalize/deduplicate IDs and reject an empty selection or any ID absent from the current category map. As with scanning, injected `categories` exist only for isolated tests; when they are absent, regenerate the current whitelist with `getSafeCategories(environment)` inside `cleanSafeCategories`. Treat `ENOENT` as a skip caused by concurrent change; treat all other operation errors as failures and continue. Count released bytes from `lstat.size` only after `unlink` succeeds.

- [ ] **Step 4: Run cleanup tests and all server utility tests**

Run: `node --test server/utils/diskCleaner.test.js`

Expected: all disk-cleaner tests PASS.

Run: `node --test server/utils/*.test.js`

Expected: all existing and new utility tests PASS.

- [ ] **Step 5: Commit guarded cleanup**

```bash
git add server/utils/diskCleaner.js server/utils/diskCleaner.test.js
git commit -m "feat: safely clean selected cache categories"
```

### Task 4: Socket.io Integration

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add the disk cleaner dependency and runtime environment resolver**

Near the utility imports add:

```js
const diskCleaner = require('./utils/diskCleaner');
```

Add a helper near other server helpers:

```js
const getDiskCleanerEnvironment = () => {
  let userData = '';
  try {
    const electron = require('electron');
    if (electron?.app && typeof electron.app.getPath === 'function') {
      userData = electron.app.getPath('userData');
    }
  } catch (_) {}

  return {
    platform: process.platform,
    localAppData: process.env.LOCALAPPDATA || '',
    tempDir: os.tmpdir(),
    userData,
  };
};
```

- [ ] **Step 2: Register scan and clean callbacks inside `io.on('connection')`**

Add handlers before the Node version events:

```js
  socket.on('disk-cleaner:scan', async (_payload = {}, callback = () => {}) => {
    try {
      const environment = getDiskCleanerEnvironment();
      const [scan, driveResult] = await Promise.all([
        diskCleaner.scanSafeCategories({ environment, platform: environment.platform }),
        diskCleaner.getDriveSpace('C:\\')
          .then((drive) => ({ drive, driveError: '' }))
          .catch((error) => ({ drive: null, driveError: error.message || '无法读取 C 盘容量' })),
      ]);
      callback({ success: true, ...scan, ...driveResult });
    } catch (error) {
      callback({ success: false, error: error.message || '扫描失败' });
    }
  });

  socket.on('disk-cleaner:clean', async ({ categoryIds } = {}, callback = () => {}) => {
    try {
      const environment = getDiskCleanerEnvironment();
      const result = await diskCleaner.cleanSafeCategories(categoryIds, {
        environment,
        platform: environment.platform,
      });
      callback(result);
    } catch (error) {
      callback({ success: false, error: error.message || '清理失败' });
    }
  });
```

- [ ] **Step 3: Verify server syntax and utility behavior**

Run: `node --check server/index.js`

Expected: exit 0 with no output.

Run: `node --test server/utils/*.test.js`

Expected: all tests PASS.

- [ ] **Step 4: Commit Socket integration**

```bash
git add server/index.js
git commit -m "feat: expose disk cleaner socket events"
```

### Task 5: Disk Cleaner Page and Navigation

**Files:**
- Create: `client/src/views/disk-cleaner/index.vue`
- Modify: `client/src/router/index.ts`
- Modify: `client/src/views/dashboard/index.vue`

- [ ] **Step 1: Add the lazy route and Dashboard entry**

In `client/src/router/index.ts`, register:

```ts
{
  path: '/disk-cleaner',
  name: 'DiskCleaner',
  component: () => import('../views/disk-cleaner/index.vue')
}
```

In the Dashboard top action group, add a compact button before “周报”:

```vue
<button
  type="button"
  class="flex items-center gap-2 rounded border border-emerald-700 bg-emerald-950/50 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-900/60"
  title="扫描并清理安全缓存"
  @click="$router.push('/disk-cleaner')"
>
  <svg aria-hidden="true" viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>
  磁盘清理
</button>
```

The project has no icon library, so reuse a small inline icon consistent with its current components rather than adding a dependency solely for one icon.

- [ ] **Step 2: Create the page state and Socket request helper**

Create `client/src/views/disk-cleaner/index.vue` with typed interfaces for `DriveSpace`, `ScanCategory`, `ScanResponse`, and `CleanResponse`. In `<script setup lang="ts">`, import `computed`, `onUnmounted`, `ref`, `useRouter`, `socket`, and `confirm`.

Use this timeout wrapper so disconnects cannot leave the UI busy forever:

```ts
const request = <T>(event: string, payload: unknown, timeoutMs = 120_000) =>
  new Promise<T>((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response: T) => {
      if (error) reject(new Error('请求超时，请检查本地服务后重试'));
      else resolve(response);
    });
  });
```

Maintain `isScanning`, `isCleaning`, `scanResult`, `cleanResult`, `selectedIds`, `requestGeneration`, and `mounted`. Increment the generation for every operation and ignore callbacks when the component is unmounted or a newer request exists.

Implement `formatBytes` with units `B/KB/MB/GB/TB`, one decimal place, and `0 B` for invalid values. Derive `selectedBytes`, `selectedCount`, and `usedPercent` with computed values.

- [ ] **Step 3: Implement scan and confirmed cleanup actions**

The scan action must clear stale cleanup results, call `disk-cleaner:scan`, select all categories whose `sizeBytes > 0`, and show errors through `window.$toast?.error(message, 5000)`.

The cleanup action must:

```ts
const approved = await confirm(
  `将清理 ${selectedCount.value} 类缓存，预计释放 ${formatBytes(selectedBytes.value)}。\n\n缓存可重新生成，但清理过程中请勿关闭应用。`,
  '确认清理缓存',
  { confirmText: '立即清理', cancelText: '取消', type: 'warning' }
);
if (!approved) return;
```

Then call `disk-cleaner:clean` with `{ categoryIds: [...selectedIds.value] }`. On full success, show the released size; when `failedCount > 0`, show a warning with the failure count. Always perform a fresh scan after a successful cleanup so the list and drive capacity cannot stay stale.

- [ ] **Step 4: Build the complete responsive page**

The template must contain these stable sections:

1. Sticky top bar with icon-only back button (tooltip `返回项目面板`), literal title `C 盘安全清理`, and scan button.
2. Unframed capacity band showing total, used, free, and a fixed-height progress bar. If `drive` is null, show `C 盘容量暂不可用` plus `driveError`.
3. Restrained safety notice: `仅处理当前用户的临时文件和开发工具缓存，不扫描个人文件、项目源码或 Windows 系统目录。`
4. Initial state with a scan command, not a marketing hero.
5. Category list using one card per cache category, checkbox, name, description, size, file count, paths in wrapping monospace text, and skipped/error count.
6. Sticky bottom action bar only when results exist, with selection summary and `立即清理` button.
7. Result summary with actual released bytes, deleted file count, skipped count, and failure count.
8. Unsupported/error state using the server's response text and disabling cleanup.

Use neutral gray surfaces, emerald only for healthy/free-space actions, amber for warnings, and red only for failures. Keep card radii at `rounded-lg` or smaller and ensure long Windows paths use `break-all`.

- [ ] **Step 5: Build the frontend and correct all compile errors**

Run: `npm run build --prefix client`

Expected: Vite build succeeds with exit 0 and emits `client/dist` assets.

- [ ] **Step 6: Commit the UI**

```bash
git add client/src/router/index.ts client/src/views/dashboard/index.vue client/src/views/disk-cleaner/index.vue
git commit -m "feat: add safe disk cleaner page"
```

### Task 6: End-to-End Verification and Review

**Files:**
- Modify only files implicated by verification failures.

- [ ] **Step 1: Run all automated checks from a clean command invocation**

Run:

```bash
node --test server/utils/*.test.js
node --check server/index.js
npm run build --prefix client
git diff --check
```

Expected: every command exits 0; no test failures, syntax errors, TypeScript errors, or whitespace errors.

- [ ] **Step 2: Start development services without cleaning real data**

Run: `npm run dev`

Expected: backend listens on port 2117 and frontend on its Vite port. Open the reported frontend URL, navigate from Dashboard to `/disk-cleaner`, and run only the read-only scan.

Verify visually at desktop and narrow viewport widths:

- No overlapping header actions or clipped paths.
- Loading state does not resize controls.
- Capacity and category totals are readable.
- Categories with zero bytes cannot produce a misleading cleanup action.
- Leaving and returning to the page does not update stale state.

Do not click the final cleanup confirmation during automated/manual verification against the user's real cache directories.

- [ ] **Step 3: Exercise deletion only through the automated temporary-directory tests**

Run: `node --test --test-name-pattern="cleanSafeCategories" server/utils/diskCleaner.test.js`

Expected: cleanup tests PASS and temporary sandboxes are removed by test teardown.

- [ ] **Step 4: Review the final diff for the security invariants**

Run: `git diff HEAD~4 -- server/utils/diskCleaner.js server/index.js client/src/views/disk-cleaner/index.vue`

Confirm all of the following in the diff:

- The client sends category IDs only.
- The server regenerates categories on every cleanup request.
- No API accepts an arbitrary cleanup path.
- No recursive removal targets a category root.
- Symbolic links and junctions are skipped.
- Windows, Program Files, personal folders, and project folders never appear as cleanup targets.

- [ ] **Step 5: Request code review**

Use the `superpowers:requesting-code-review` skill. Resolve any correctness or safety findings, then repeat Step 1 before reporting completion.
