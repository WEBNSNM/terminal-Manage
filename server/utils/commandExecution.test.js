const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveCommandExecution } = require('./commandExecution');

test('resolves npm command to the target node version cli when available', () => {
  const result = resolveCommandExecution({
    command: 'npm run local',
    projectPath: 'D:\\demo',
    targetNodeVersion: '12.22.12',
    platform: 'win32',
    nodeVersionsApi: {
      getVersionDir: (version) => `E:\\software\\nvm\\v${version}`,
      getNodeBin: (versionDir) => `${versionDir}\\node.exe`,
      getRunnerCliJs: (versionDir, runner) => `${versionDir}\\node_modules\\${runner}\\bin\\npm-cli.js`,
    },
  });

  assert.deepEqual(result, {
    mode: 'direct',
    command: 'E:\\software\\nvm\\v12.22.12\\node.exe',
    args: [
      'E:\\software\\nvm\\v12.22.12\\node_modules\\npm\\bin\\npm-cli.js',
      'run',
      'local',
    ],
    shell: false,
  });
});

test('falls back to shell mode for non-package-manager commands', () => {
  const result = resolveCommandExecution({
    command: 'node -v',
    projectPath: 'D:\\demo',
    targetNodeVersion: '12.22.12',
    platform: 'win32',
    nodeVersionsApi: {
      getVersionDir: () => 'E:\\software\\nvm\\v12.22.12',
      getNodeBin: () => 'E:\\software\\nvm\\v12.22.12\\node.exe',
      getRunnerCliJs: () => null,
    },
  });

  assert.deepEqual(result, {
    mode: 'shell',
    command: 'node -v',
    args: [],
    shell: true,
  });
});

test('falls back to shell mode for complex chained npm commands', () => {
  const result = resolveCommandExecution({
    command: 'npm run local && echo ok',
    projectPath: 'D:\\demo',
    targetNodeVersion: '12.22.12',
    platform: 'win32',
    nodeVersionsApi: {
      getVersionDir: () => 'E:\\software\\nvm\\v12.22.12',
      getNodeBin: () => 'E:\\software\\nvm\\v12.22.12\\node.exe',
      getRunnerCliJs: () => 'E:\\software\\nvm\\v12.22.12\\node_modules\\npm\\bin\\npm-cli.js',
    },
  });

  assert.deepEqual(result, {
    mode: 'shell',
    command: 'npm run local && echo ok',
    args: [],
    shell: true,
  });
});
