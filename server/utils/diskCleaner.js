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
    cleanupAdvice: '可重新生成；建议在应用空闲时清理',
  },
  'edge-cache': {
    name: 'Microsoft Edge 缓存',
    description: 'Edge 浏览器网页缓存，不包含书签、密码或历史记录',
    cleanupAdvice: '建议先关闭 Edge；无法删除的占用文件会自动跳过',
  },
  'chrome-cache': {
    name: 'Google Chrome 缓存',
    description: 'Chrome 浏览器网页缓存，不包含书签、密码或历史记录',
    cleanupAdvice: '建议先关闭 Chrome；无法删除的占用文件会自动跳过',
  },
  'tencent-report': {
    name: 'Tencent 数据目录（只读）',
    description: '包含聊天记录、图片、文件等混合数据，只统计不删除',
    cleanupAdvice: '请在对应软件设置中清理或手动确认具体内容',
  },
  'qq-report': {
    name: 'QQ 数据目录（只读）',
    description: '可能包含聊天记录、图片和文件，只统计不删除',
    cleanupAdvice: '请在 QQ 设置中清理，不要直接删除目录',
  },
  'roxybrowser-report': {
    name: 'RoxyBrowser 数据目录（只读）',
    description: '可能包含浏览器配置、Cookie 和用户资料，只统计不删除',
    cleanupAdvice: '请使用软件自身的配置或卸载功能处理',
  },
  'program-files-report': {
    name: 'Program Files（只读）',
    description: '已安装软件占用，只能通过 Windows 应用管理卸载',
    cleanupAdvice: '请通过 Windows 设置中的已安装应用卸载，不要直接删除文件夹',
  },
  'program-files-x86-report': {
    name: 'Program Files (x86)（只读）',
    description: '32 位软件占用，只能通过 Windows 应用管理卸载',
    cleanupAdvice: '请通过 Windows 设置中的已安装应用卸载，不要直接删除文件夹',
  },
  'program-data-report': {
    name: 'ProgramData（只读）',
    description: '软件共享数据和安装缓存，只统计不删除',
    cleanupAdvice: '请使用对应软件设置或卸载程序处理',
  },
  'vscode-cache': {
    name: 'VS Code 缓存',
    description: 'VS Code 编辑器界面和扩展运行缓存，不包含工作区源码',
    cleanupAdvice: '建议先关闭 VS Code；扩展缓存会在需要时重新生成',
  },
  'cursor-cache': {
    name: 'Cursor 缓存',
    description: 'Cursor 编辑器界面、索引和日志缓存，不包含工作区源码',
    cleanupAdvice: '建议先关闭 Cursor；缓存会在需要时重新生成',
  },
  'tencent-cache': {
    name: 'Tencent 明确缓存',
    description: '仅包含 Tencent 根目录下明确命名的缓存、临时和日志目录',
    cleanupAdvice: '建议先关闭腾讯应用；聊天记录和用户文件目录不会加入清理',
  },
  'qq-cache': {
    name: 'QQ 明确缓存',
    description: '仅包含 QQ 根目录下明确命名的缓存、临时和日志目录',
    cleanupAdvice: '建议先关闭 QQ；聊天数据库和接收文件不会加入清理',
  },
  'wechat-cache': {
    name: '微信明确缓存',
    description: '仅包含微信目录下明确命名的缓存、临时和日志目录',
    cleanupAdvice: '建议先关闭微信；消息数据库、聊天文件和图片不会加入清理',
  },
  'discord-cache': {
    name: 'Discord 缓存',
    description: 'Discord 客户端界面缓存，不包含账号配置目录',
    cleanupAdvice: '建议先关闭 Discord；无法删除的占用文件会自动跳过',
  },
  'teams-cache': {
    name: 'Microsoft Teams 缓存',
    description: 'Teams 客户端界面缓存，不包含聊天数据库',
    cleanupAdvice: '建议先关闭 Teams；无法删除的占用文件会自动跳过',
  },
});

for (const [categoryId, category] of Object.entries(CATEGORY_META)) {
  if (!category.cleanupAdvice) category.cleanupAdvice = '可直接清理；内容可重新生成';
  category.safeToClean = !categoryId.endsWith('-report');
  if (categoryId.endsWith('-report')) category.mode = 'report-only';
  else category.mode = 'cleanable';
}

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
  const appData = environment.appData || process.env.APPDATA || '';
  const programFiles = environment.programFiles || process.env.ProgramW6432 || process.env.ProgramFiles || '';
  const programFilesX86 = environment.programFilesX86 || process.env['ProgramFiles(x86)'] || '';
  const programData = environment.programData || process.env.ProgramData || '';
  const tempDir = environment.tempDir || os.tmpdir();
  const userData = environment.userData || '';
  if (!path.win32.isAbsolute(localAppData) || !path.win32.isAbsolute(tempDir)) {
    throw new Error('无法解析 Windows 用户缓存目录');
  }

  const browserProfiles = environment.browserProfiles || {};
  const communicationCacheChildren = environment.communicationCacheChildren || {};
  const allowedCommunicationCacheNames = new Set(['Cache', 'Temp', 'Logs', 'Crash', 'CrashDumps']);
  const communicationPaths = (appName) => {
    if (!path.win32.isAbsolute(appData)) return [];
    let childNames = communicationCacheChildren[appName];
    if (!Array.isArray(childNames)) {
      try {
        childNames = fs.readdirSync(path.win32.join(appData, appName), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (_) {
        childNames = [];
      }
    }
    return childNames
      .filter((name) => allowedCommunicationCacheNames.has(name))
      .map((name) => path.win32.join(appData, appName, name));
  };
  const discoverProfiles = (browser) => {
    if (Array.isArray(browserProfiles[browser])) return browserProfiles[browser];
    const root = browser === 'edge'
      ? path.win32.join(localAppData, 'Microsoft', 'Edge', 'User Data')
      : path.win32.join(localAppData, 'Google', 'Chrome', 'User Data');
    try {
      return fs.readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
        .map((entry) => entry.name);
    } catch (_) {
      return ['Default'];
    }
  };
  const browserCachePaths = (browser, profiles) => profiles.flatMap((profile) => {
    const root = browser === 'edge'
      ? path.win32.join(localAppData, 'Microsoft', 'Edge', 'User Data', profile)
      : path.win32.join(localAppData, 'Google', 'Chrome', 'User Data', profile);
    return ['Cache', 'Code Cache', 'GPUCache'].map((name) => path.win32.join(root, name));
  });

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
    ['edge-cache', browserCachePaths('edge', discoverProfiles('edge'))],
    ['chrome-cache', browserCachePaths('chrome', discoverProfiles('chrome'))],
    ['vscode-cache', path.win32.isAbsolute(appData)
      ? ['Cache', 'Code Cache', 'GPUCache', 'CachedData', 'logs'].map((name) => path.win32.join(appData, 'Code', name))
      : []],
    ['cursor-cache', path.win32.isAbsolute(appData)
      ? ['Cache', 'Code Cache', 'GPUCache', 'CachedData', 'logs'].map((name) => path.win32.join(appData, 'Cursor', name))
      : []],
    ['discord-cache', path.win32.isAbsolute(appData)
      ? ['Cache', 'Code Cache', 'GPUCache'].map((name) => path.win32.join(appData, 'discord', name))
      : []],
    ['teams-cache', path.win32.isAbsolute(appData)
      ? ['Cache', 'Code Cache', 'GPUCache'].map((name) => path.win32.join(appData, 'Microsoft', 'Teams', name))
      : []],
    ['tencent-cache', communicationPaths('Tencent')],
    ['qq-cache', communicationPaths('QQ')],
    ['wechat-cache', communicationPaths(path.win32.join('Tencent', 'WeChat'))],
    ['tencent-report', appData ? [path.win32.join(appData, 'Tencent')] : []],
    ['qq-report', appData ? [path.win32.join(appData, 'QQ')] : []],
    ['roxybrowser-report', appData ? [path.win32.join(appData, 'RoxyBrowser')] : []],
    ['program-files-report', programFiles ? [programFiles] : []],
    ['program-files-x86-report', programFilesX86 ? [programFilesX86] : []],
    ['program-data-report', programData ? [programData] : []],
  ];

  return definitions.map(([id, paths]) => ({
    id,
    ...CATEGORY_META[id],
    mode: CATEGORY_META[id].mode,
    safeToClean: CATEGORY_META[id].safeToClean,
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
  const result = { exists: false, fileCount: 0, sizeBytes: 0, skippedCount: 0, errors: [] };
  try {
    const rootStats = await io.lstat(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      result.skippedCount += 1;
      return result;
    }
    result.exists = true;
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
      mode: category.mode || 'cleanable',
      safeToClean: category.safeToClean !== false,
      paths: [],
      fileCount: 0,
      sizeBytes: 0,
      skippedCount: 0,
      errors: [],
    };

    for (const root of category.paths) {
      const rootResult = await scanRoot(root, io);
      if (rootResult.exists) categoryResult.paths.push(root);
      categoryResult.fileCount += rootResult.fileCount;
      categoryResult.sizeBytes += rootResult.sizeBytes;
      categoryResult.skippedCount += rootResult.skippedCount;
      categoryResult.errors.push(...rootResult.errors);
    }

    categoryResult.errors = categoryResult.errors.slice(0, 20);
    if (categoryResult.paths.length === 0) continue;
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
  const reportOnlyId = selectedIds.find((id) => categoriesById.get(id).safeToClean === false || categoriesById.get(id).mode === 'report-only');
  if (reportOnlyId) throw new Error(`只读分析类别不可清理: ${reportOnlyId}`);

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
