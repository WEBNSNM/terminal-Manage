/**
 * Node 版本管理工具模块
 * 用于检测项目所需的 Node 版本，并通过修改 PATH 实现进程级版本切换
 * 支持 nvm-windows (Windows) 和 nvm (macOS/Linux)
 *
 * 目录结构差异:
 *   Windows (nvm-windows): NVM_HOME/v18.17.0/node.exe
 *   macOS   (nvm):         NVM_DIR/versions/node/v18.17.0/bin/node
 */
const fs = require('fs');
const path = require('path');
const semver = require('semver');

const isWin = process.platform === 'win32';

/**
 * 获取 NVM 根目录
 * Windows: NVM_HOME > %APPDATA%\nvm
 * macOS:   NVM_DIR  > ~/.nvm
 */
function getNvmHome() {
  if (isWin) {
    if (process.env.NVM_HOME && fs.existsSync(process.env.NVM_HOME)) {
      return process.env.NVM_HOME;
    }
    const fallback = path.join(process.env.APPDATA || '', 'nvm');
    if (fs.existsSync(fallback)) return fallback;
  } else {
    if (process.env.NVM_DIR && fs.existsSync(process.env.NVM_DIR)) {
      return process.env.NVM_DIR;
    }
    const fallback = path.join(process.env.HOME || '', '.nvm');
    if (fs.existsSync(fallback)) return fallback;
  }
  return null;
}

/**
 * 获取版本目录的基础路径
 * Windows: NVM_HOME          (版本直接在根目录下: NVM_HOME/v18.17.0/)
 * macOS:   NVM_DIR/versions/node (版本在子目录下: NVM_DIR/versions/node/v18.17.0/)
 */
function getVersionsBase() {
  const nvmHome = getNvmHome();
  if (!nvmHome) return null;
  if (isWin) return nvmHome;
  const versionsDir = path.join(nvmHome, 'versions', 'node');
  if (fs.existsSync(versionsDir)) return versionsDir;
  return null;
}

/**
 * 获取指定版本目录中 node 可执行文件路径
 * Windows: versionDir/node.exe
 * macOS:   versionDir/bin/node
 */
function getNodeBin(versionDir) {
  if (isWin) return path.join(versionDir, 'node.exe');
  return path.join(versionDir, 'bin', 'node');
}

/**
 * 获取指定版本目录中可加入 PATH 的 bin 目录
 * Windows: versionDir (node.exe 直接在版本目录下)
 * macOS:   versionDir/bin
 */
function getBinDir(versionDir) {
  if (isWin) return versionDir;
  return path.join(versionDir, 'bin');
}

/**
 * 扫描所有已安装的 Node 版本
 * @returns {string[]} 已安装的版本号数组（降序），如 ['22.0.0', '20.11.0', '18.17.0']
 */
function getInstalledVersions() {
  const base = getVersionsBase();
  if (!base) return [];

  try {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    const versions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirName = entry.name;
      const cleaned = dirName.replace(/^v/, '');
      if (!semver.valid(cleaned)) continue;
      // 确认目录下有 node 可执行文件
      const versionDir = path.join(base, dirName);
      if (fs.existsSync(getNodeBin(versionDir))) {
        versions.push(cleaned);
      }
    }
    return versions.sort((a, b) => semver.rcompare(a, b));
  } catch (e) {
    console.error('[nodeVersions] 扫描已安装版本失败:', e.message);
    return [];
  }
}

/**
 * 从项目目录检测所需的 Node 版本
 * 优先级：.nvmrc > .node-version > package.json engines.node
 * @param {string} projectPath 项目根目录
 * @returns {{ raw: string, source: string } | null}
 */
function detectProjectNodeVersion(projectPath) {
  // 1. 检查 .nvmrc
  const nvmrcPath = path.join(projectPath, '.nvmrc');
  if (fs.existsSync(nvmrcPath)) {
    try {
      const content = fs.readFileSync(nvmrcPath, 'utf-8').trim();
      if (content) return { raw: content, source: '.nvmrc' };
    } catch (e) { /* 忽略 */ }
  }

  // 2. 检查 .node-version
  const nodeVersionPath = path.join(projectPath, '.node-version');
  if (fs.existsSync(nodeVersionPath)) {
    try {
      const content = fs.readFileSync(nodeVersionPath, 'utf-8').trim();
      if (content) return { raw: content, source: '.node-version' };
    } catch (e) { /* 忽略 */ }
  }

  // 3. 检查 package.json engines.node
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.engines && pkg.engines.node) {
        return { raw: pkg.engines.node, source: 'package.json engines.node' };
      }
    } catch (e) { /* 忽略 */ }
  }

  return null;
}

/**
 * 将版本需求字符串匹配到最佳已安装版本
 * 支持格式：精确版本(18.17.0)、范围(>=18、20.x)、lts/*
 * @param {string} rawVersion 原始版本需求
 * @returns {{ version: string, exact: boolean } | null}
 */
function resolveNodeVersion(rawVersion) {
  if (!rawVersion) return null;

  const installed = getInstalledVersions();
  if (installed.length === 0) return null;

  let cleaned = rawVersion.trim();

  // 处理 lts/* 或 lts/hydrogen 等特殊格式 → 取最新已安装
  if (/^lts\//i.test(cleaned)) {
    return { version: installed[0], exact: false };
  }

  // 移除前缀 v
  cleaned = cleaned.replace(/^v/, '');

  // 精确版本匹配
  if (semver.valid(cleaned)) {
    const found = installed.find(v => v === cleaned);
    if (found) return { version: found, exact: true };
    const major = semver.major(cleaned);
    const fallback = installed.find(v => semver.major(v) === major);
    if (fallback) return { version: fallback, exact: false };
    return null;
  }

  // 范围匹配（>=18, 20.x, ^18.0.0 等）
  const range = semver.validRange(cleaned);
  if (range) {
    const matched = semver.maxSatisfying(installed, range);
    if (matched) return { version: matched, exact: false };
  }

  // 简单数字匹配（如 "18" → 18.x）
  if (/^\d+$/.test(cleaned)) {
    const major = parseInt(cleaned, 10);
    const matched = installed.find(v => semver.major(v) === major);
    if (matched) return { version: matched, exact: false };
  }

  return null;
}

/**
 * 获取指定版本的目录路径
 * @param {string} version 版本号（如 '12.22.12'）
 * @returns {string|null} 版本目录绝对路径
 */
function getVersionDir(version) {
  const base = getVersionsBase();
  if (!base || !version) return null;

  // 尝试 v12.22.12 和 12.22.12 两种目录名
  let versionDir = path.join(base, `v${version}`);
  if (fs.existsSync(versionDir)) return versionDir;
  versionDir = path.join(base, version);
  if (fs.existsSync(versionDir)) return versionDir;
  return null;
}

/**
 * 获取指定版本中 runner 对应的 cli.js 入口路径
 * @param {string} versionDir 版本目录
 * @param {string} runner npm/pnpm/yarn
 * @returns {string|null} cli.js 的绝对路径，不存在则返回 null
 */
function getRunnerCliJs(versionDir, runner) {
  // node_modules 在不同平台的位置
  // Windows: versionDir/node_modules/npm/bin/npm-cli.js
  // macOS:   versionDir/lib/node_modules/npm/bin/npm-cli.js
  const modulesBase = isWin
    ? path.join(versionDir, 'node_modules')
    : path.join(versionDir, 'lib', 'node_modules');

  const cliPaths = {
    npm:  path.join(modulesBase, 'npm', 'bin', 'npm-cli.js'),
    pnpm: path.join(modulesBase, 'pnpm', 'bin', 'pnpm.cjs'),
    yarn: path.join(modulesBase, 'yarn', 'bin', 'yarn.js'),
  };

  const cliJs = cliPaths[runner];
  if (cliJs && fs.existsSync(cliJs)) return cliJs;
  return null;
}

/**
 * 构建包含指定 Node 版本 PATH 的环境变量对象
 * @param {string} version 目标 Node 版本号（如 '18.17.0'）
 * @returns {object} 修改后的 env 对象
 */
function buildEnvWithNodeVersion(version) {
  const env = { ...process.env, FORCE_COLOR: '1' };
  const versionDir = getVersionDir(version);
  if (!versionDir) return env;

  // 目标版本的 bin 目录（要加入 PATH 的路径）
  const targetBinDir = getBinDir(versionDir);

  // 需要从 PATH 中替换掉的路径
  const replacePaths = new Set();

  if (isWin) {
    // Windows: 替换 NVM_SYMLINK（如 C:\Program Files\nodejs）
    const nvmSymlink = process.env.NVM_SYMLINK || '';
    if (nvmSymlink) replacePaths.add(nvmSymlink);
  } else {
    // macOS/Linux: 替换当前活跃版本的 bin 目录
    // nvm 的当前版本通过 NVM_BIN 环境变量暴露，或在 PATH 中形如 ~/.nvm/versions/node/vX.X.X/bin
    const nvmBin = process.env.NVM_BIN || '';
    if (nvmBin) replacePaths.add(nvmBin);
    // 也匹配 NVM_DIR/versions/node/vXXX/bin 格式的路径
    const nvmHome = getNvmHome();
    if (nvmHome) {
      const versionsPrefix = path.join(nvmHome, 'versions', 'node');
      // 下面循环中会用 startsWith 匹配
      replacePaths.add(versionsPrefix);
    }
  }

  const currentPath = env.Path || env.PATH || env.path || '';
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);

  const normalizeForCompare = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
  const replaceNorms = new Set([...replacePaths].map(normalizeForCompare));

  let replaced = false;
  const newEntries = [];
  const seen = new Set();

  for (const entry of pathEntries) {
    const entryNorm = normalizeForCompare(entry);
    if (seen.has(entryNorm)) continue;
    seen.add(entryNorm);

    // 精确匹配（如 NVM_SYMLINK, NVM_BIN）
    let shouldReplace = replaceNorms.has(entryNorm);

    // macOS: 前缀匹配 ~/.nvm/versions/node/vXXX/bin
    if (!shouldReplace && !isWin) {
      for (const rp of replaceNorms) {
        if (entryNorm.startsWith(rp)) {
          shouldReplace = true;
          break;
        }
      }
    }

    if (shouldReplace) {
      if (!replaced) {
        newEntries.push(targetBinDir);
        replaced = true;
      }
      // 跳过原条目
    } else {
      newEntries.push(entry);
    }
  }

  if (!replaced) {
    newEntries.unshift(targetBinDir);
  }

  const newPath = newEntries.join(path.delimiter);
  env.PATH = newPath;
  if (isWin) env.Path = newPath;

  console.log(`[Node切换] 使用 Node v${version} (${targetBinDir})`);
  console.log(`[Node切换] 命中替换: ${replaced}`);
  return env;
}

module.exports = {
  getNvmHome,
  getInstalledVersions,
  detectProjectNodeVersion,
  resolveNodeVersion,
  getVersionDir,
  getNodeBin,
  getRunnerCliJs,
  buildEnvWithNodeVersion
};
