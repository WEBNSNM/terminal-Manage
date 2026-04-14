const DEFAULT_NODE_VERSIONS_API = require('./nodeVersions');

const RUNNER_ALIASES = {
  npm: 'npm',
  'npm.cmd': 'npm',
  'npm.exe': 'npm',
  pnpm: 'pnpm',
  'pnpm.cmd': 'pnpm',
  'pnpm.exe': 'pnpm',
  yarn: 'yarn',
  'yarn.cmd': 'yarn',
  'yarn.exe': 'yarn',
};

const SHELL_CONTROL_CHARS = new Set(['&', '|', ';', '<', '>', '(', ')', '`']);

const createShellFallback = (command) => ({
  mode: 'shell',
  command,
  args: [],
  shell: true,
});

function tokenizeSimpleCommand(command) {
  const source = String(command || '').trim();
  if (!source) return [];

  const tokens = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (quote) {
      if (char === '\\') {
        const nextChar = source[index + 1];
        if (nextChar === quote || nextChar === '\\') {
          current += nextChar;
          index += 1;
          continue;
        }
      }

      if (char === quote) {
        quote = null;
        continue;
      }

      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    if (SHELL_CONTROL_CHARS.has(char)) {
      return null;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function normalizeRunnerToken(token) {
  const normalized = String(token || '').trim().toLowerCase();
  if (!normalized || /[\\/]/.test(normalized)) {
    return null;
  }
  return RUNNER_ALIASES[normalized] || null;
}

function resolveCommandExecution({
  command,
  targetNodeVersion,
  nodeVersionsApi = DEFAULT_NODE_VERSIONS_API,
}) {
  const normalizedCommand = String(command || '').trim();
  const fallback = createShellFallback(normalizedCommand);

  if (!normalizedCommand || !targetNodeVersion) {
    return fallback;
  }

  const tokens = tokenizeSimpleCommand(normalizedCommand);
  if (!tokens || tokens.length === 0) {
    return fallback;
  }

  const runner = normalizeRunnerToken(tokens[0]);
  if (!runner) {
    return fallback;
  }

  const versionDir = nodeVersionsApi.getVersionDir?.(targetNodeVersion);
  if (!versionDir) {
    return fallback;
  }

  const nodeBin = nodeVersionsApi.getNodeBin?.(versionDir);
  const cliJs = nodeVersionsApi.getRunnerCliJs?.(versionDir, runner);
  if (!nodeBin || !cliJs) {
    return fallback;
  }

  return {
    mode: 'direct',
    command: nodeBin,
    args: [cliJs, ...tokens.slice(1)],
    shell: false,
  };
}

module.exports = {
  resolveCommandExecution,
};
