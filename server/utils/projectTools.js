const fs = require('fs');
const path = require('path');

const WECHAT_DEVTOOLS_CONFIG_KEY = 'wechat_devtools_config';
const PROJECT_TAGS_BY_PATH_KEY = 'project_tags_by_path';

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

function normalizeWechatDevtoolsConfig(rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

  return {
    windowsPath: trimString(source.windowsPath),
    macosPath: trimString(source.macosPath),
  };
}

function normalizeProjectTagsByPath(rawConfig) {
  const source = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
    ? rawConfig
    : {};
  const result = {};

  Object.entries(source).forEach(([projectPath, value]) => {
    if (!projectPath || !value || typeof value !== 'object' || Array.isArray(value)) return;
    if (!Object.prototype.hasOwnProperty.call(value, 'isMiniProgram')) return;

    result[projectPath] = {
      isMiniProgram: value.isMiniProgram === true,
    };
  });

  return result;
}

function isMiniProgramTagged(projectTagsByPath, projectPath) {
  if (!projectPath) return false;
  const normalizedTags = normalizeProjectTagsByPath(projectTagsByPath);
  return normalizedTags[projectPath]?.isMiniProgram === true;
}

function getWechatCliCandidates(configuredPath, platform = process.platform) {
  const rawPath = trimString(configuredPath);
  if (!rawPath) return [];

  if (platform === 'win32') {
    const pathApi = path.win32;
    const lowerPath = rawPath.toLowerCase();

    if (lowerPath.endsWith('cli.bat')) {
      return [rawPath];
    }

    if (lowerPath.endsWith('.exe')) {
      return [
        pathApi.join(pathApi.dirname(rawPath), 'cli.bat'),
        rawPath,
      ];
    }

    return [pathApi.join(rawPath, 'cli.bat')];
  }

  if (platform === 'darwin') {
    const pathApi = path.posix;
    const lowerPath = rawPath.toLowerCase();

    if (lowerPath.endsWith('/cli')) {
      return [rawPath];
    }

    if (lowerPath.endsWith('.app')) {
      return [
        pathApi.join(rawPath, 'Contents', 'MacOS', 'cli'),
        pathApi.join(rawPath, 'Contents', 'Resources', 'app.nw', 'bin', 'cli'),
      ];
    }

    return [
      pathApi.join(rawPath, 'Contents', 'MacOS', 'cli'),
      pathApi.join(rawPath, 'Contents', 'Resources', 'app.nw', 'bin', 'cli'),
      pathApi.join(rawPath, 'cli'),
    ];
  }

  return [rawPath];
}

function getWechatLaunchCandidates(configuredPath, platform = process.platform) {
  const rawPath = trimString(configuredPath);
  if (!rawPath) return [];

  if (platform === 'win32') {
    const pathApi = path.win32;
    const lowerPath = rawPath.toLowerCase();

    if (lowerPath.endsWith('.exe') || lowerPath.endsWith('.bat') || lowerPath.endsWith('.cmd')) {
      return [rawPath];
    }

    return [
      pathApi.join(rawPath, '微信开发者工具.exe'),
      pathApi.join(rawPath, 'cli.bat'),
    ];
  }

  if (platform === 'darwin') {
    const lowerPath = rawPath.toLowerCase();

    if (lowerPath.endsWith('.app')) {
      return [rawPath];
    }

    const contentsIndex = rawPath.indexOf('/Contents/');
    if (contentsIndex > 0) {
      return [rawPath.slice(0, contentsIndex) + '.app', rawPath];
    }

    return [rawPath];
  }

  return [rawPath];
}

function getWechatLaunchSpec(targetPath, platform = process.platform) {
  const normalizedTarget = trimString(targetPath);
  if (!normalizedTarget) return null;

  if (platform === 'win32') {
    const lowerTarget = normalizedTarget.toLowerCase();
    if (lowerTarget.endsWith('.bat') || lowerTarget.endsWith('.cmd')) {
      return {
        command: 'cmd.exe',
        args: ['/d', '/s', '/c', `"${normalizedTarget}"`],
      };
    }
  }

  if (platform === 'darwin' && normalizedTarget.toLowerCase().endsWith('.app')) {
    return {
      command: 'open',
      args: [normalizedTarget],
    };
  }

  return {
    command: normalizedTarget,
    args: [],
  };
}

function resolveWechatCliPath(config, platform = process.platform, fileExists = fs.existsSync) {
  const normalizedConfig = normalizeWechatDevtoolsConfig(config);
  const configuredPath = platform === 'win32'
    ? normalizedConfig.windowsPath
    : platform === 'darwin'
      ? normalizedConfig.macosPath
      : '';

  if (!configuredPath) {
    const platformLabel = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : '当前平台';
    return {
      success: false,
      error: `请先在设置中配置 ${platformLabel} 微信开发者工具路径`,
      cliPath: '',
      configuredPath: '',
      candidates: [],
    };
  }

  const candidates = getWechatCliCandidates(configuredPath, platform);
  const cliPath = candidates.find((candidate) => {
    try {
      return !!fileExists(candidate);
    } catch {
      return false;
    }
  }) || '';

  if (!cliPath) {
    return {
      success: false,
      error: '未找到可用的微信开发者工具 CLI，请检查设置中的路径配置',
      cliPath: '',
      configuredPath,
      candidates,
    };
  }

  return {
    success: true,
    error: '',
    cliPath,
    configuredPath,
    candidates,
  };
}

function resolveWechatLaunchSpec(config, platform = process.platform, fileExists = fs.existsSync) {
  const normalizedConfig = normalizeWechatDevtoolsConfig(config);
  const configuredPath = platform === 'win32'
    ? normalizedConfig.windowsPath
    : platform === 'darwin'
      ? normalizedConfig.macosPath
      : '';

  if (!configuredPath) {
    const platformLabel = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : '当前平台';
    return {
      success: false,
      error: `请先在设置中配置 ${platformLabel} 微信开发者工具路径`,
      launchSpec: null,
      configuredPath: '',
      candidates: [],
    };
  }

  const candidates = getWechatLaunchCandidates(configuredPath, platform);
  const launchTarget = candidates.find((candidate) => {
    try {
      return !!fileExists(candidate);
    } catch {
      return false;
    }
  }) || '';

  if (!launchTarget) {
    return {
      success: false,
      error: '未找到可启动的微信开发者工具，请检查设置中的路径配置',
      launchSpec: null,
      configuredPath,
      candidates,
    };
  }

  return {
    success: true,
    error: '',
    launchSpec: getWechatLaunchSpec(launchTarget, platform),
    configuredPath,
    candidates,
  };
}

function getWeChatProjectConfigPath(projectPath) {
  return path.join(projectPath, 'project.config.json');
}

function hasWeChatProjectConfig(projectPath) {
  if (!projectPath) return false;
  return fs.existsSync(getWeChatProjectConfigPath(projectPath));
}

module.exports = {
  PROJECT_TAGS_BY_PATH_KEY,
  WECHAT_DEVTOOLS_CONFIG_KEY,
  getWechatCliCandidates,
  getWechatLaunchCandidates,
  getWechatLaunchSpec,
  getWeChatProjectConfigPath,
  hasWeChatProjectConfig,
  isMiniProgramTagged,
  normalizeProjectTagsByPath,
  normalizeWechatDevtoolsConfig,
  resolveWechatLaunchSpec,
  resolveWechatCliPath,
};
