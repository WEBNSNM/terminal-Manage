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
  try {
    const rootStats = await io.lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      result.skippedCount += 1;
      return result;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      result.skippedCount += 1;
      result.errors.push(toErrorSummary(root, error));
    }
    return result;
  }

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

async function cleanRoot(root, io) {
  const result = {
    releasedBytes: 0,
    deletedFiles: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: [],
  };

  try {
    const rootStats = await io.lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      result.skippedCount += 1;
      return result;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      result.failedCount += 1;
      result.errors.push(toErrorSummary(root, error));
    }
    return result;
  }

  const stack = [{ target: root, removeDirectory: false, visited: false }];
  while (stack.length > 0) {
    const frame = stack.pop();
    const { target } = frame;

    if (frame.visited) {
      try {
        await io.rmdir(target);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) {
          result.failedCount += 1;
          result.errors.push(toErrorSummary(target, error));
        }
      }
      continue;
    }

    const isRoot = path.resolve(target) === path.resolve(root);
    if (!isRoot && !isNativePathInsideRoot(target, root)) {
      result.skippedCount += 1;
      continue;
    }

    let stats;
    try {
      stats = await io.lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') result.skippedCount += 1;
      else {
        result.failedCount += 1;
        result.errors.push(toErrorSummary(target, error));
      }
      continue;
    }

    if (stats.isSymbolicLink()) {
      result.skippedCount += 1;
      continue;
    }

    if (stats.isFile()) {
      try {
        await io.unlink(target);
        result.deletedFiles += 1;
        result.releasedBytes += stats.size;
      } catch (error) {
        if (error.code === 'ENOENT') result.skippedCount += 1;
        else {
          result.failedCount += 1;
          result.errors.push(toErrorSummary(target, error));
        }
      }
      continue;
    }

    if (!stats.isDirectory()) {
      result.skippedCount += 1;
      continue;
    }

    let entries;
    try {
      entries = await io.readdir(target, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') result.skippedCount += 1;
      else {
        result.failedCount += 1;
        result.errors.push(toErrorSummary(target, error));
      }
      continue;
    }

    if (frame.removeDirectory) stack.push({ target, removeDirectory: true, visited: true });
    for (const entry of entries) {
      stack.push({
        target: path.join(target, entry.name),
        removeDirectory: true,
        visited: false,
      });
    }
  }

  result.errors = result.errors.slice(0, 20);
  return result;
}

async function cleanSafeCategories(categoryIds, options = {}) {
  const platform = options.platform || options.environment?.platform || process.platform;
  if (platform !== 'win32') throw new Error('磁盘安全清理仅支持 Windows');

  const selectedIds = [...new Set(
    Array.isArray(categoryIds)
      ? categoryIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
  )];
  if (selectedIds.length === 0) throw new Error('请至少选择一个清理类别');

  const categories = options.categories || getSafeCategories(options.environment);
  const categoriesById = new Map(categories.map((category) => [category.id, category]));
  const unknownId = selectedIds.find((id) => !categoriesById.has(id));
  if (unknownId) throw new Error(`未知的清理类别: ${unknownId}`);

  const io = options.io || fs.promises;
  const cleanedCategories = [];
  const totals = {
    releasedBytes: 0,
    deletedFiles: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  for (const id of selectedIds) {
    const category = categoriesById.get(id);
    const categoryResult = {
      id,
      name: category.name,
      releasedBytes: 0,
      deletedFiles: 0,
      skippedCount: 0,
      failedCount: 0,
      errors: [],
    };

    for (const root of category.paths) {
      const rootResult = await cleanRoot(root, io);
      categoryResult.releasedBytes += rootResult.releasedBytes;
      categoryResult.deletedFiles += rootResult.deletedFiles;
      categoryResult.skippedCount += rootResult.skippedCount;
      categoryResult.failedCount += rootResult.failedCount;
      categoryResult.errors.push(...rootResult.errors);
    }

    categoryResult.errors = categoryResult.errors.slice(0, 20);
    totals.releasedBytes += categoryResult.releasedBytes;
    totals.deletedFiles += categoryResult.deletedFiles;
    totals.skippedCount += categoryResult.skippedCount;
    totals.failedCount += categoryResult.failedCount;
    cleanedCategories.push(categoryResult);
  }

  return { success: true, ...totals, categories: cleanedCategories };
}

module.exports = {
  cleanSafeCategories,
  getSafeCategories,
  getDriveSpace,
  isPathInsideRoot,
  scanSafeCategories,
};
