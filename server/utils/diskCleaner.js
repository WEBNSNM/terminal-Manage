const fs = require('fs');
const os = require('os');
const path = require('path');

const CATEGORY_META = Object.freeze({
  'user-temp': {
    name: '用户临时文件',
    description: '应用和安装程序产生的临时缓存',
  },
  'npm-cache': {
    name: 'npm 缓存',
    description: 'npm 下载的软件包缓存，可按需重新下载',
  },
  'pnpm-cache': {
    name: 'pnpm 缓存',
    description: 'pnpm 本地软件包存储缓存',
  },
  'yarn-cache': {
    name: 'Yarn 缓存',
    description: 'Yarn 下载的软件包缓存',
  },
  'devmaster-cache': {
    name: 'DevMaster 缓存',
    description: 'DevMaster 界面运行产生的缓存',
  },
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
    ['pnpm-cache', [
      path.win32.join(localAppData, 'pnpm', 'store'),
      path.win32.join(localAppData, 'pnpm-store'),
    ]],
    ['yarn-cache', [path.win32.join(localAppData, 'Yarn', 'Cache')]],
    ['devmaster-cache', userData
      ? ['Cache', 'Code Cache', 'GPUCache'].map((name) => path.win32.join(userData, name))
      : []],
  ];

  return definitions.map(([id, paths]) => ({
    id,
    ...CATEGORY_META[id],
    paths: uniqueWindowsPaths(paths),
  }));
}

function isPathInsideRoot(candidate, root) {
  if (!path.win32.isAbsolute(candidate) || !path.win32.isAbsolute(root)) return false;
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith('..\\')
    && !path.win32.isAbsolute(relative);
}

function isNativePathInsideRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

const toErrorSummary = (targetPath, error) => ({
  path: targetPath,
  code: error?.code || 'UNKNOWN',
});

async function scanRoot(root, io) {
  const result = { fileCount: 0, sizeBytes: 0, skippedCount: 0, errors: [] };
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = await io.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        result.skippedCount += 1;
        result.errors.push(toErrorSummary(current, error));
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
        } else {
          result.skippedCount += 1;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          result.skippedCount += 1;
          result.errors.push(toErrorSummary(candidate, error));
        }
      }
    }
  }

  return result;
}

async function scanSafeCategories(options = {}) {
  const platform = options.platform || options.environment?.platform || process.platform;
  if (platform !== 'win32') throw new Error('磁盘安全清理仅支持 Windows');

  const categories = options.categories || getSafeCategories(options.environment);
  const io = options.io || fs.promises;
  const startedAt = Date.now();
  const scannedCategories = [];
  const totals = { fileCount: 0, sizeBytes: 0, skippedCount: 0 };

  for (const category of categories) {
    const categoryResult = {
      ...category,
      fileCount: 0,
      sizeBytes: 0,
      skippedCount: 0,
      errors: [],
    };

    for (const root of category.paths) {
      const rootResult = await scanRoot(root, io);
      categoryResult.fileCount += rootResult.fileCount;
      categoryResult.sizeBytes += rootResult.sizeBytes;
      categoryResult.skippedCount += rootResult.skippedCount;
      categoryResult.errors.push(...rootResult.errors);
    }

    categoryResult.errors = categoryResult.errors.slice(0, 20);
    totals.fileCount += categoryResult.fileCount;
    totals.sizeBytes += categoryResult.sizeBytes;
    totals.skippedCount += categoryResult.skippedCount;
    scannedCategories.push(categoryResult);
  }

  return {
    platform,
    categories: scannedCategories,
    totals,
    durationMs: Date.now() - startedAt,
  };
}

async function getDriveSpace(drive = 'C:\\', io = fs.promises) {
  const stats = await io.statfs(drive);
  const totalBytes = Number(stats.bsize) * Number(stats.blocks);
  const freeBytes = Number(stats.bsize) * Number(stats.bavail);
  return {
    drive,
    totalBytes,
    freeBytes,
    usedBytes: Math.max(0, totalBytes - freeBytes),
  };
}

module.exports = {
  getSafeCategories,
  getDriveSpace,
  isPathInsideRoot,
  scanSafeCategories,
};
