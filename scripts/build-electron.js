const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const semver = require('semver');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));

const normalizeVersion = (raw) => {
  if (!raw) return '';
  let text = String(raw).trim();
  if (!text) return '';

  if (text.startsWith('refs/tags/')) text = text.slice('refs/tags/'.length);
  if (text.startsWith('v')) text = text.slice(1);

  if (semver.valid(text)) return text;
  const coerced = semver.coerce(text);
  return coerced ? coerced.version : '';
};

const detectBuildVersion = () => {
  const envCandidates = [
    process.env.APP_VERSION,
    process.env.GITHUB_REF_NAME,
    process.env.GITHUB_REF
  ];

  for (const candidate of envCandidates) {
    const version = normalizeVersion(candidate);
    if (version) return { version, source: 'env' };
  }

  try {
    const tag = execSync('git describe --tags --exact-match', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
    const version = normalizeVersion(tag);
    if (version) return { version, source: 'git-tag' };
  } catch (e) {}

  return { version: String(pkg.version || '0.0.0'), source: 'package.json' };
};

const { version, source } = detectBuildVersion();
const args = process.argv.slice(2);
args.push(`--config.extraMetadata.version=${version}`);

console.log(`[build-electron] version=${version} (${source})`);

if (String(process.env.BUILD_VERSION_DRY_RUN || '') === '1') {
  process.exit(0);
}

const run = (command, commandArgs, options = {}) =>
  spawnSync(command, commandArgs, {
    cwd: rootDir,
    stdio: 'inherit',
    env: process.env,
    shell: false,
    ...options
  });

// 优先直接用 Node 运行 electron-builder 的 JS CLI，避免 Windows 下 *.cmd spawn EINVAL。
let cliPath = '';
try {
  cliPath = require.resolve('electron-builder/out/cli/cli.js', { paths: [rootDir] });
} catch (e) {}

if (cliPath) {
  const jsCliResult = run(process.execPath, [cliPath, ...args]);
  if (!jsCliResult.error) {
    process.exit(jsCliResult.status ?? 1);
  }
  console.warn(`[build-electron] JS CLI failed to start: ${jsCliResult.error.message}, fallback to bin.`);
}

const builderBin = path.join(
  rootDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder'
);
const binResult = run(builderBin, args, {
  shell: process.platform === 'win32'
});

if (binResult.error) {
  console.error('[build-electron] failed:', binResult.error.message);
  process.exit(1);
}

process.exit(binResult.status ?? 1);
