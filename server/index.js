const express = require('express');
const http = require('http');
const net = require('net');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');

const monitor = require('./utils/monitor');
const nodeVersions = require('./utils/nodeVersions');

// 配置文件存在用户目录下，防止误删
const CONFIG_PATH = path.join(os.homedir(), '.terminalManage-config.json');
const app = express();
app.use(cors());

const clientDistPath = path.join(__dirname, '../client/dist');

if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ✅ 1. 启动监控循环
monitor.startLoop(io);

// 存储运行中的子进程: Map<taskKey, ChildProcess>
const processes = new Map();
const TUNNEL_CONFIG_KEY = 'ai_tunnel_config';
const TUNNEL_GATEWAY_PORT = 26324;
const DEFAULT_TUNNEL_HOST = '127.0.0.1';

let tunnelGatewayServer = null;
let cloudflaredProcess = null;
let pendingCloudflaredAutoStartProjectPath = '';
const tunnelGatewayState = {
  port: TUNNEL_GATEWAY_PORT,
  running: false,
  lastError: '',
  activeTarget: null
};

// --- 工具函数 ---
const killProcessTree = (child, taskKey) => {
  if (!child || !child.pid) return;
  console.log(`💀 [KILL] 正在终止: ${taskKey} (PID: ${child.pid})`);
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${child.pid} /f /t`, (err) => {
         if (err && !err.message.includes('not found')) console.error(err.message);
      });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch (e) { console.error(e); }
};

// 辅助函数：读取所有配置
const readConfigFile = () => {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch (e) {
    console.error('读取配置失败', e);
  }
  return {}; // 如果文件不存在或出错，返回空对象
};

// 辅助函数：写入配置
const writeConfigFile = (data) => {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('写入配置失败', e);
  }
};

const normalizeTunnelConfig = (rawConfig) => {
  const source = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const projectPorts =
    source.projectPorts && typeof source.projectPorts === 'object'
      ? source.projectPorts
      : {};

  return {
    token: typeof source.token === 'string' ? source.token : '',
    publicDomain: typeof source.publicDomain === 'string' ? source.publicDomain : '',
    autoSwitchOnRun: source.autoSwitchOnRun !== false,
    projectPorts,
    activeProjectPath: typeof source.activeProjectPath === 'string' ? source.activeProjectPath : ''
  };
};

const readTunnelConfig = () => {
  const allConfig = readConfigFile();
  return normalizeTunnelConfig(allConfig[TUNNEL_CONFIG_KEY]);
};

const writeTunnelConfig = (nextConfig) => {
  const allConfig = readConfigFile();
  allConfig[TUNNEL_CONFIG_KEY] = normalizeTunnelConfig(nextConfig);
  writeConfigFile(allConfig);
};

const getTunnelStatePayload = () => ({
  gatewayPort: tunnelGatewayState.port,
  gatewayRunning: tunnelGatewayState.running,
  gatewayError: tunnelGatewayState.lastError,
  activeTarget: tunnelGatewayState.activeTarget,
  cloudflaredRunning: !!cloudflaredProcess,
  cloudflaredPid: cloudflaredProcess?.pid || null,
  pendingCloudflaredAutoStartProjectPath
});

const broadcastTunnelState = () => {
  io.emit('tunnel:state', getTunnelStatePayload());
};

const setPendingCloudflaredAutoStart = (projectPath = '') => {
  pendingCloudflaredAutoStartProjectPath = projectPath || '';
  broadcastTunnelState();
};

const clearPendingCloudflaredAutoStart = (projectPath = '') => {
  if (!pendingCloudflaredAutoStartProjectPath) return;
  if (
    !projectPath ||
    pendingCloudflaredAutoStartProjectPath.toLowerCase() === String(projectPath).toLowerCase()
  ) {
    pendingCloudflaredAutoStartProjectPath = '';
    broadcastTunnelState();
  }
};

const isValidPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;

const readTextFileIfExists = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch (e) {}
  return '';
};

const getPortFromMatches = (text, patterns) => {
  if (!text) return null;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const candidate = Number(match[1]);
    if (isValidPort(candidate)) return candidate;
  }
  return null;
};

const getPortFromScript = (script = '') => {
  return getPortFromMatches(script, [
    /--port(?:=|\s+)(\d{2,5})/i,
    /(?:^|\s)-p\s+(\d{2,5})(?:\s|$)/i,
    /\bPORT=(\d{2,5})\b/i,
    /\bset\s+PORT=(\d{2,5})\b/i
  ]);
};

const stripAnsi = (text = '') => String(text).replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');

const getModeFromScriptCommand = (command = '') => {
  const match = String(command || '').match(/--mode(?:=|\s+)([a-z0-9_-]+)/i);
  return match?.[1] || '';
};

const detectPortFromEnvFiles = (projectPath, modeHint = '') => {
  const mode = String(modeHint || '').trim();
  const envFiles = mode
    ? [
        `.env.${mode}.local`,
        `.env.${mode}`,
        '.env.local',
        '.env'
      ]
    : ['.env.development.local', '.env.development', '.env.local', '.env'];

  for (const file of envFiles) {
    const content = readTextFileIfExists(path.join(projectPath, file));
    const port = getPortFromMatches(content, [
      /^\s*(?:export\s+)?VITE_PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m,
      /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d{2,5})["']?\s*$/m
    ]);
    if (isValidPort(port)) {
      return { port, source: file };
    }
  }
  return null;
};

const extractRuntimePortFromOutput = (output) => {
  const text = stripAnsi(output);
  // 只匹配前端开发服务器常见输出，避免并行脚本里的后端端口误触发
  const candidate = getPortFromMatches(text, [
    /\bLocal:\s*https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+):(\d{2,5})/i,
    /\bNetwork:\s*https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[a-z0-9.-]+):(\d{2,5})/i
  ]);
  if (!isValidPort(candidate)) return null;
  if (Number(candidate) === TUNNEL_GATEWAY_PORT) return null;
  return Number(candidate);
};

const detectProjectAppPort = (
  projectPath,
  knownScripts = null,
  activeScriptName = '',
  options = {}
) => {
  const allowDefaultFallback = options.allowDefaultFallback !== false;
  const includeEnvPort = options.includeEnvPort !== false;
  const scripts = knownScripts || {};
  const pkgPath = path.join(projectPath, 'package.json');
  let pkg = null;
  if (Object.keys(scripts).length === 0) {
    try {
      if (fs.existsSync(pkgPath)) {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      }
    } catch (e) {}
  } else if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) {}
  }

  const scriptMap = Object.keys(scripts).length > 0 ? scripts : (pkg?.scripts || {});
  const modeFromScript = (() => {
    const candidates = [
      activeScriptName,
      'dev',
      'start',
      'serve',
      'test',
      'preview'
    ].filter(Boolean);
    for (const name of candidates) {
      const cmd = scriptMap[name] || '';
      const mode = getModeFromScriptCommand(cmd);
      if (mode) return mode;
    }
    return '';
  })();
  const firstScriptPort = ['dev', 'start', 'serve', 'preview']
    .map((key) => getPortFromScript(scriptMap[key] || ''))
    .find((v) => isValidPort(v));
  if (isValidPort(firstScriptPort)) {
    return { port: firstScriptPort, source: 'script' };
  }

  const viteConfigFiles = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];
  for (const file of viteConfigFiles) {
    const fullPath = path.join(projectPath, file);
    const content = readTextFileIfExists(fullPath);
    const port = getPortFromMatches(content, [
      /server\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/m,
      /\bport\s*:\s*(\d{2,5})/m
    ]);
    if (isValidPort(port)) {
      return { port, source: file };
    }
  }

  const vueConfig = readTextFileIfExists(path.join(projectPath, 'vue.config.js'));
  const vuePort = getPortFromMatches(vueConfig, [
    /devServer\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/m
  ]);
  if (isValidPort(vuePort)) {
    return { port: vuePort, source: 'vue.config.js' };
  }

  const webpackFiles = ['webpack.config.js', 'webpack.dev.js', 'webpack.dev.conf.js'];
  for (const file of webpackFiles) {
    const content = readTextFileIfExists(path.join(projectPath, file));
    const port = getPortFromMatches(content, [
      /devServer\s*:\s*\{[\s\S]*?\bport\s*:\s*(\d{2,5})/m
    ]);
    if (isValidPort(port)) {
      return { port, source: file };
    }
  }

  const angularJson = readTextFileIfExists(path.join(projectPath, 'angular.json'));
  const angularPort = getPortFromMatches(angularJson, [
    /"port"\s*:\s*(\d{2,5})/m
  ]);
  if (isValidPort(angularPort)) {
    return { port: angularPort, source: 'angular.json' };
  }

  if (includeEnvPort) {
    const envPort = detectPortFromEnvFiles(projectPath, modeFromScript);
    if (isValidPort(envPort?.port)) {
      return envPort;
    }
  }

  if (!allowDefaultFallback) {
    return null;
  }

  const devScript = scriptMap.dev || '';
  const startScript = scriptMap.start || '';
  const mergedScripts = `${devScript}\n${startScript}`.toLowerCase();
  const allDeps = {
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {})
  };

  if (mergedScripts.includes('ng serve') || allDeps['@angular/cli']) {
    return { port: 4200, source: 'default:angular' };
  }
  if (mergedScripts.includes('vite') || allDeps.vite) {
    return { port: 5173, source: 'default:vite' };
  }
  if (mergedScripts.includes('vue-cli-service serve') || allDeps['@vue/cli-service']) {
    return { port: 8080, source: 'default:vue-cli' };
  }
  if (mergedScripts.includes('react-scripts start') || allDeps['react-scripts']) {
    return { port: 3000, source: 'default:react' };
  }
  if (mergedScripts.includes('next dev') || allDeps.next) {
    return { port: 3000, source: 'default:next' };
  }
  if (mergedScripts.includes('nuxt dev') || allDeps.nuxt || allDeps['nuxi']) {
    return { port: 3000, source: 'default:nuxt' };
  }
  if (mergedScripts.includes('webpack serve')) {
    return { port: 8080, source: 'default:webpack' };
  }
  if (mergedScripts.includes('flask run')) {
    return { port: 5000, source: 'default:flask' };
  }

  return { port: 3000, source: 'default:common' };
};

const resolveTunnelTargetPort = (
  projectPath,
  explicitPort,
  activeScriptName = '',
  options = {}
) => {
  const allowDefaultFallback = options.allowDefaultFallback !== false;
  const parsedExplicit = Number(explicitPort);
  if (isValidPort(parsedExplicit)) return parsedExplicit;

  const tunnelConfig = readTunnelConfig();
  const parsedSaved = Number(tunnelConfig.projectPorts?.[projectPath]);
  if (isValidPort(parsedSaved)) return parsedSaved;

  const autoDetected = detectProjectAppPort(projectPath, null, activeScriptName, {
    allowDefaultFallback
  });
  if (isValidPort(autoDetected?.port)) return autoDetected.port;
  return null;
};

const setTunnelActiveTarget = ({ projectPath, projectName, port }) => {
  const normalizedPort = Number(port);
  if (!isValidPort(normalizedPort)) {
    return { success: false, error: 'Target port must be between 1 and 65535.' };
  }

  const tunnelConfig = readTunnelConfig();
  writeTunnelConfig({
    ...tunnelConfig,
    activeProjectPath: projectPath || ''
  });

  tunnelGatewayState.activeTarget = {
    projectPath: projectPath || '',
    projectName: projectName || (projectPath ? path.basename(projectPath) : ''),
    host: DEFAULT_TUNNEL_HOST,
    port: normalizedPort,
    updatedAt: Date.now()
  };
  if (
    pendingCloudflaredAutoStartProjectPath &&
    String(pendingCloudflaredAutoStartProjectPath).toLowerCase() ===
      String(projectPath || '').toLowerCase()
  ) {
    pendingCloudflaredAutoStartProjectPath = '';
  }
  broadcastTunnelState();
  return { success: true, state: getTunnelStatePayload() };
};

const markTunnelPendingProject = ({ projectPath }) => {
  const tunnelConfig = readTunnelConfig();
  writeTunnelConfig({
    ...tunnelConfig,
    activeProjectPath: projectPath || ''
  });

  const currentPath = tunnelGatewayState.activeTarget?.projectPath || '';
  if (currentPath !== (projectPath || '')) {
    tunnelGatewayState.activeTarget = null;
  }
  broadcastTunnelState();
};

const clearTunnelActiveTarget = () => {
  const tunnelConfig = readTunnelConfig();
  writeTunnelConfig({
    ...tunnelConfig,
    activeProjectPath: ''
  });
  tunnelGatewayState.activeTarget = null;
  clearPendingCloudflaredAutoStart();
  broadcastTunnelState();
};

const writeUpgradeError = (socket, statusCode, message) => {
  if (!socket || socket.destroyed) return;
  socket.write(
    `HTTP/1.1 ${statusCode} Error\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      '\r\n' +
      message
  );
  socket.destroy();
};

const proxyGatewayHttpRequest = (req, res) => {
  const target = tunnelGatewayState.activeTarget;
  if (!target) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: false, error: 'No active tunnel target.' }));
    return;
  }

  const proxyReq = http.request(
    {
      hostname: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${target.host}:${target.port}`
      }
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (error) => {
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(
      JSON.stringify({
        success: false,
        error: `Proxy to ${target.host}:${target.port} failed`,
        detail: error.message
      })
    );
  });

  req.pipe(proxyReq);
};

const proxyGatewayUpgradeRequest = (req, socket, head) => {
  const target = tunnelGatewayState.activeTarget;
  if (!target) {
    writeUpgradeError(socket, 503, 'No active tunnel target.');
    return;
  }

  const upstream = net.connect(target.port, target.host, () => {
    const headers = { ...req.headers, host: `${target.host}:${target.port}` };
    let rawRequest = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;

    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          rawRequest += `${key}: ${item}\r\n`;
        });
      } else if (value !== undefined) {
        rawRequest += `${key}: ${value}\r\n`;
      }
    }
    rawRequest += '\r\n';

    upstream.write(rawRequest);
    if (head && head.length > 0) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on('error', (error) => {
    writeUpgradeError(socket, 502, `Proxy upgrade failed: ${error.message}`);
  });

  socket.on('error', () => {
    upstream.destroy();
  });
};

const startTunnelGatewayServer = () => {
  if (tunnelGatewayServer) return;

  tunnelGatewayServer = http.createServer(proxyGatewayHttpRequest);
  tunnelGatewayServer.on('upgrade', proxyGatewayUpgradeRequest);
  tunnelGatewayServer.on('error', (error) => {
    tunnelGatewayState.running = false;
    tunnelGatewayState.lastError = error.message;
    console.error('[TunnelGateway] error:', error.message);
    broadcastTunnelState();
  });

  tunnelGatewayServer.listen(tunnelGatewayState.port, DEFAULT_TUNNEL_HOST, () => {
    tunnelGatewayState.running = true;
    tunnelGatewayState.lastError = '';
    console.log(`[TunnelGateway] listening on ${DEFAULT_TUNNEL_HOST}:${tunnelGatewayState.port}`);
    broadcastTunnelState();
  });
};

const stopTunnelGatewayServer = () => {
  if (!tunnelGatewayServer) return;
  tunnelGatewayServer.close(() => {
    console.log('[TunnelGateway] closed');
  });
  tunnelGatewayServer = null;
  tunnelGatewayState.running = false;
  broadcastTunnelState();
};

const startCloudflared = (token) => {
  if (cloudflaredProcess) {
    return { success: false, error: 'cloudflared is already running', state: getTunnelStatePayload() };
  }

  const trimmedToken = (token || '').trim();
  if (!trimmedToken) {
    return { success: false, error: 'Cloudflare Tunnel token is empty' };
  }

  try {
    const child = spawn('cloudflared', ['tunnel', 'run', '--protocol', 'http2', '--token', trimmedToken], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    cloudflaredProcess = child;
    broadcastTunnelState();

    child.stdout.on('data', (chunk) => {
      io.emit('tunnel:cloudflared-log', { type: 'stdout', data: chunk.toString() });
    });
    child.stderr.on('data', (chunk) => {
      io.emit('tunnel:cloudflared-log', { type: 'stderr', data: chunk.toString() });
    });
    child.on('error', (error) => {
      io.emit('tunnel:cloudflared-log', { type: 'error', data: error.message });
    });
    child.on('close', (code) => {
      if (cloudflaredProcess === child) {
        cloudflaredProcess = null;
        io.emit('tunnel:cloudflared-log', { type: 'exit', data: `cloudflared exited with code ${code}` });
        broadcastTunnelState();
      }
    });

    return { success: true, state: getTunnelStatePayload() };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const stopCloudflared = () => {
  if (!cloudflaredProcess) {
    return { success: false, error: 'cloudflared is not running', state: getTunnelStatePayload() };
  }

  const current = cloudflaredProcess;
  cloudflaredProcess = null;
  killProcessTree(current, 'cloudflared');
  broadcastTunnelState();
  return { success: true, state: getTunnelStatePayload() };
};

const autoStartCloudflaredForProject = (projectName, projectPath) => {
  const tunnelConfig = readTunnelConfig();
  const token = (tunnelConfig.token || '').trim();
  if (!token) {
    io.emit('log', {
      name: projectName,
      data: '\n[Tunnel] cloudflared token is empty, skip auto start.\n'
    });
    return { success: false, error: 'token empty' };
  }

  if (cloudflaredProcess) {
    clearPendingCloudflaredAutoStart(projectPath);
    return { success: true, state: getTunnelStatePayload(), alreadyRunning: true };
  }

  const result = startCloudflared(token);
  if (result.success) {
    clearPendingCloudflaredAutoStart(projectPath);
    io.emit('log', {
      name: projectName,
      data: '\n[Tunnel] cloudflared started after tunnel target is ready.\n'
    });
  } else {
    io.emit('log', {
      name: projectName,
      data: `\n[Tunnel] Failed to start cloudflared: ${result.error || 'unknown error'}\n`
    });
  }
  return result;
};

const restoreTunnelTargetFromConfig = () => {
  const tunnelConfig = readTunnelConfig();
  if (!tunnelConfig.activeProjectPath) return;

  const restoredPort = resolveTunnelTargetPort(tunnelConfig.activeProjectPath);
  if (!isValidPort(restoredPort)) return;

  setTunnelActiveTarget({
    projectPath: tunnelConfig.activeProjectPath,
    projectName: path.basename(tunnelConfig.activeProjectPath),
    port: restoredPort
  });
};

const scanRecursively = (currentPath, depth = 0) => {
  if (depth > 4) return [];
  const folderName = path.basename(currentPath);
if (['node_modules', '.git', 'dist', 'build', '.idea', '.vscode', 'public', 'uni_modules', 'static'].includes(folderName)) {
    return [];
  }

  const pkgPath = path.join(currentPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      let runner = 'npm'; 
      if (fs.existsSync(path.join(currentPath, 'pnpm-lock.yaml'))) runner = 'pnpm';
      else if (fs.existsSync(path.join(currentPath, 'yarn.lock'))) runner = 'yarn';
      
      // 检测项目所需的 Node 版本
      const detected = nodeVersions.detectProjectNodeVersion(currentPath);
      const resolved = detected ? nodeVersions.resolveNodeVersion(detected.raw) : null;
      const appPortDetection = detectProjectAppPort(currentPath, pkg.scripts || {});

      return [{
        name: folderName,
        path: currentPath,
        runner: runner,
        scripts: pkg.scripts || {},
        detectedNodeVersion: detected,   // { raw, source } | null
        resolvedNodeVersion: resolved,    // { version, exact } | null
        detectedAppPort: appPortDetection?.port || null,
        detectedAppPortSource: appPortDetection?.source || ''
      }];
    } catch (e) { return []; }
  }

  let results = [];
  try {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results = results.concat(scanRecursively(path.join(currentPath, entry.name), depth + 1));
      }
    }
  } catch (err) {}
  return results;
};

const scanProjects = (dirPath) => {
  if (!fs.existsSync(dirPath)) return [];
  return scanRecursively(dirPath);
};

// --- Socket 逻辑 ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  socket.emit('tunnel:state', getTunnelStatePayload());

  socket.on('tunnel:get-state', (callback) => {
    if (typeof callback === 'function') callback(getTunnelStatePayload());
  });

  socket.on('tunnel:set-target', ({ projectPath, projectName, port } = {}, callback) => {
    const resolvedPort = resolveTunnelTargetPort(projectPath, port);
    if (!isValidPort(resolvedPort)) {
      return callback?.({
        success: false,
        error: 'No valid tunnel port found for this project.',
        state: getTunnelStatePayload()
      });
    }

    const result = setTunnelActiveTarget({
      projectPath,
      projectName,
      port: resolvedPort
    });
    callback?.(result);
  });

  socket.on('tunnel:clear-target', (callback) => {
    clearTunnelActiveTarget();
    callback?.({ success: true, state: getTunnelStatePayload() });
  });

  socket.on('tunnel:start', ({ token } = {}, callback) => {
    const tunnelConfig = readTunnelConfig();
    const effectiveToken = (token || tunnelConfig.token || '').trim();
    const result = startCloudflared(effectiveToken);
    if (result.success) clearPendingCloudflaredAutoStart();
    callback?.(result);
  });

  socket.on('tunnel:stop', (callback) => {
    const result = stopCloudflared();
    callback?.(result);
  });
// 1. 弹窗选择文件夹
  socket.on('open-folder-dialog', () => {
    console.log('正在唤起文件夹选择弹窗...');

    if (process.platform === 'win32') {
      // Windows: 用 Shell.Application COM 对象替代 WinForms，无需加载 .NET 程序集
      // 通过 GetForegroundWindow 获取当前前台窗口句柄，让弹窗置顶显示
      const psScript = `
Add-Type -Name Win32 -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();'
$hwnd = [Native.Win32]::GetForegroundWindow()
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder($hwnd, '请选择项目父目录', 0x51, '')
if ($folder) { $folder.Self.Path }
`;
      const encodedCommand = Buffer.from(psScript, 'utf16le').toString('base64');
      const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand]);

      child.stdout.on('data', (data) => {
        const selectedPath = data.toString().trim();
        if (selectedPath) {
          socket.emit('folder-selected', selectedPath);
          const projects = scanProjects(selectedPath);
          socket.emit('projects-loaded', enrichProjects(projects));
        }
      });
    } else {
      // macOS: 使用 osascript 原生弹窗
      const child = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "请选择项目父目录")']);

      child.stdout.on('data', (data) => {
        const selectedPath = data.toString().trim().replace(/\/$/, '');
        if (selectedPath) {
          socket.emit('folder-selected', selectedPath);
          const projects = scanProjects(selectedPath);
          socket.emit('projects-loaded', enrichProjects(projects));
        }
      });
    }
  });

  // 辅助函数：为项目列表补充运行状态和 Node 版本覆盖信息
  const enrichProjects = (projects) => {
    const config = readConfigFile();
    const overrides = config.node_version_overrides || {};
    const tunnelConfig = normalizeTunnelConfig(config[TUNNEL_CONFIG_KEY]);
    const manualProjectPorts = tunnelConfig.projectPorts || {};

    return projects.map(p => {
      // 同步运行状态
      const runningScripts = {};
      for (const [taskKey] of processes) {
        if (taskKey.startsWith(`${p.name}:`)) {
          runningScripts[taskKey.split(':')[1]] = true;
        }
      }

      // 合并 Node 版本覆盖
      const override = overrides[p.path] || null;
      let effectiveNodeVersion = null;
      let nodeVersionSource = 'system';

      if (override && override !== 'system') {
        // 手动指定了具体版本
        effectiveNodeVersion = override;
        nodeVersionSource = 'manual';
      } else if (override === 'system') {
        // 显式选择系统默认，忽略自动检测
        effectiveNodeVersion = null;
        nodeVersionSource = 'system';
      } else if (p.resolvedNodeVersion) {
        // 无覆盖，使用自动检测
        effectiveNodeVersion = p.resolvedNodeVersion.version;
        nodeVersionSource = 'auto';
      }

      const autoPortInfo = isValidPort(Number(p.detectedAppPort))
        ? { port: Number(p.detectedAppPort), source: p.detectedAppPortSource || 'detected' }
        : detectProjectAppPort(p.path, p.scripts || {});
      const manualPort = Number(manualProjectPorts[p.path]);
      const hasManualPort = isValidPort(manualPort);
      const effectiveTunnelPort = hasManualPort ? manualPort : autoPortInfo.port;
      const tunnelPortSource = hasManualPort ? 'manual' : 'auto';

      return {
        ...p,
        runningScripts,
        nodeVersionOverride: (override && override !== 'system') ? override : null,
        effectiveNodeVersion,
        nodeVersionSource,
        detectedAppPort: autoPortInfo.port || null,
        detectedAppPortSource: autoPortInfo.source || '',
        effectiveTunnelPort: isValidPort(effectiveTunnelPort) ? effectiveTunnelPort : null,
        tunnelPortSource
      };
    });
  };

  // 1. 扫描目录
  socket.on('scan-dir', (dirPath) => {
    const projects = scanProjects(dirPath);
    socket.emit('projects-loaded', enrichProjects(projects));
  });

  // 2. 启动任务 (核心修改：加入监控 + Node 版本切换)
  socket.on('start-task', ({ projectName, script, projectPath, runner, nodeVersion }) => {
    console.log(`📩 [start-task] 收到请求: ${projectName}:${script}, runner=${runner}, nodeVersion=${nodeVersion}`);
    const taskKey = `${projectName}:${script}`;
    if (processes.has(taskKey)) {
      console.warn(`⚠️ [start-task] 任务 ${taskKey} 已在运行中，忽略重复请求`);
      return;
    }

    const tunnelConfig = readTunnelConfig();
    const autoSwitchEnabled = !!(tunnelConfig.autoSwitchOnRun && projectPath);
    const hasManualTunnelPort = isValidPort(Number(tunnelConfig.projectPorts?.[projectPath]));
    const strongPortInfo = projectPath
      ? detectProjectAppPort(projectPath, null, script, {
          allowDefaultFallback: false,
          includeEnvPort: false
        })
      : null;
    const hasStrongDetectedPort = isValidPort(Number(strongPortInfo?.port));
    const allowRuntimeLogPortDetection =
      autoSwitchEnabled && !hasManualTunnelPort && !hasStrongDetectedPort;

    if (autoSwitchEnabled) {
      if (hasManualTunnelPort) {
        const manualPort = Number(tunnelConfig.projectPorts?.[projectPath]);
        setTunnelActiveTarget({
          projectPath,
          projectName,
          port: manualPort
        });
        autoStartCloudflaredForProject(projectName, projectPath);
      } else if (hasStrongDetectedPort) {
        setTunnelActiveTarget({
          projectPath,
          projectName,
          port: Number(strongPortInfo.port)
        });
        autoStartCloudflaredForProject(projectName, projectPath);
      } else {
        // 仅剩默认兜底时，不立即切换，等待启动日志识别真实端口
        markTunnelPendingProject({ projectPath });
        setPendingCloudflaredAutoStart(projectPath);
        if (cloudflaredProcess) {
          stopCloudflared();
          io.emit('log', {
            name: projectName,
            data: '\n[Tunnel] Port is unknown yet, cloudflared stopped and waiting for runtime port.\n'
          });
        }
        io.emit('log', {
          name: projectName,
          data: '\n[Tunnel] Waiting for runtime port from startup logs...\n'
        });
      }
    }

    const currentRunner = runner || 'npm';

    // 确定使用的 Node 版本和启动命令，整体包裹 try-catch 防止静默失败
    let targetNodeVersion = null;
    let customEnv = null; // null = 继承父进程环境（对 webpack HMR 更友好）
    let cmd = currentRunner;
    let spawnArgs = ['run', script];
    if (process.platform === 'win32') cmd = `${currentRunner}.cmd`;

    try {
      // 确定版本：手动指定 > 自动检测 > 系统默认
      if (nodeVersion && nodeVersion !== 'system') {
        targetNodeVersion = nodeVersion;
      } else if (!nodeVersion) {
        const detected = nodeVersions.detectProjectNodeVersion(projectPath);
        if (detected) {
          const resolved = nodeVersions.resolveNodeVersion(detected.raw);
          if (resolved) targetNodeVersion = resolved.version;
        }
      }

      if (targetNodeVersion) {
        // 仅在需要切换 Node 版本时才构建自定义 env（修改 PATH）
        customEnv = nodeVersions.buildEnvWithNodeVersion(targetNodeVersion);

        const versionDir = nodeVersions.getVersionDir(targetNodeVersion);
        if (versionDir) {
          const nodeExe = nodeVersions.getNodeBin(versionDir);
          const cliJs = nodeVersions.getRunnerCliJs(versionDir, currentRunner);

          if (cliJs) {
            cmd = nodeExe;
            spawnArgs = [cliJs, 'run', script];
          } else {
            cmd = process.platform === 'win32' ? `${currentRunner}.cmd` : currentRunner;
            console.warn(`[Node切换] ${currentRunner} cli.js 未在 ${versionDir} 中找到，回退到 PATH 解析`);
          }
        }
      }
    } catch (e) {
      // 版本检测或命令解析出错时，回退到默认行为
      console.error(`[Node切换] 版本处理异常，回退到系统默认:`, e.message);
      targetNodeVersion = null;
      customEnv = null;
      cmd = currentRunner;
      spawnArgs = ['run', script];
      if (process.platform === 'win32') cmd = `${currentRunner}.cmd`;
    }

    console.log(`🚀 启动任务: ${taskKey}${targetNodeVersion ? ` (Node v${targetNodeVersion})` : ' (系统默认)'}`);
    console.log(`   命令: ${cmd} ${spawnArgs.join(' ')}`);

    // 构建 spawn 选项
    // 不切换 Node 版本时不传 env，让子进程自然继承父进程环境
    // 避免 { ...process.env } 展开后丢失 Windows 大小写不敏感特性
    // 这对 webpack-dev-server 的 HMR WebSocket 正常工作很重要
    const spawnOpts = {
      cwd: projectPath,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: 'pipe'
    };
    if (customEnv) {
      spawnOpts.env = customEnv;
    }

    const child = spawn(cmd, spawnArgs, spawnOpts);

    processes.set(taskKey, child);
    
    if (child.pid) {
      // 注意：这里用 taskKey (如 VueAdmin:dev) 作为 ID
      monitor.addMonitor(taskKey, child.pid);
      console.log(`➕ 已添加监控: ${taskKey}, PID: ${child.pid}`);
    }

    io.emit('status-change', { name: projectName, script, running: true });

    let runtimeDetectedPort = null;
    let runtimePortFallbackTimer = null;
    if (allowRuntimeLogPortDetection) {
      runtimePortFallbackTimer = setTimeout(() => {
        if (runtimeDetectedPort) return;
        if (!processes.has(taskKey)) return;
        const fallbackPort = resolveTunnelTargetPort(projectPath, undefined, script, {
          allowDefaultFallback: true
        });
        if (!isValidPort(fallbackPort)) return;

        setTunnelActiveTarget({
          projectPath,
          projectName,
          port: fallbackPort
        });
        io.emit('log', {
          name: projectName,
          data: `\n[Tunnel] Runtime port not found in logs, fallback to port ${fallbackPort}.\n`
        });
        autoStartCloudflaredForProject(projectName, projectPath);
      }, 15000);
    }

    const logHandler = (data) => {
      const text = data.toString();
      io.emit('log', { name: projectName, data: text });

      if (!allowRuntimeLogPortDetection) return;
      // 已识别到前端端口后不再反复切换，避免目标在前后端端口间抖动
      if (runtimeDetectedPort) return;
      const detectedPort = extractRuntimePortFromOutput(text);
      if (!isValidPort(detectedPort)) return;
      runtimeDetectedPort = detectedPort;
      if (runtimePortFallbackTimer) {
        clearTimeout(runtimePortFallbackTimer);
        runtimePortFallbackTimer = null;
      }

      setTunnelActiveTarget({
        projectPath,
        projectName,
        port: detectedPort
      });
      autoStartCloudflaredForProject(projectName, projectPath);
    };
    child.stdout.on('data', logHandler);
    child.stderr.on('data', logHandler);
    child.on('error', (err) => {
       io.emit('log', { name: projectName, data: `❌ 启动失败: ${err.message}` });
    });

    child.on('close', (code) => {
      if (runtimePortFallbackTimer) {
        clearTimeout(runtimePortFallbackTimer);
        runtimePortFallbackTimer = null;
      }
      if (processes.has(taskKey)) {
          // ✅ 进程退出，移除监控
          monitor.removeMonitor(taskKey);
          processes.delete(taskKey);
          io.emit('status-change', { name: projectName, script, running: false });
          io.emit('log', { name: projectName, data: `\n[Exited with code ${code}]\n` });
      }
    });
  });

  // 3. 停止任务
  // --- 4. 停止任务 (修复版) ---
  socket.on('stop-task', (projectName) => {
    console.log(`🛑 [收到指令] 请求停止项目: ${projectName}`);
    
    // 1. 先把 Map 转成数组，防止在遍历时修改 Map 导致循环中断
    const allTasks = Array.from(processes.entries());
    let found = false;

    for (const [key, child] of allTasks) {
        // key 的格式是 "项目名:脚本名" (例如 "VueAdmin:dev")
        // 所以我们检查 key 是否以 "VueAdmin:" 开头
        if (key.startsWith(`${projectName}:`)) {
            found = true;
            const scriptName = key.split(':')[1];
            console.log(`   - 匹配到任务: ${key} (PID: ${child.pid})，正在终止...`);

            // 2. 移除监控
            try {
              monitor.removeMonitor(key);
            } catch (e) {
              console.error('   - 移除监控失败:', e.message);
            }
            
            // 3. 从内存移除
            processes.delete(key);
            
            // 4. 通知前端变红
            socket.emit('status-change', { name: projectName, script: scriptName, running: false });
            
            // 5. 杀进程
            killProcessTree(child, key);
        }
    }

    if (!found) {
        console.warn(`⚠️ 未找到项目 [${projectName}] 的任何运行任务。当前运行列表:`, Array.from(processes.keys()));
        // 强制告诉前端：这个项目没在跑，把它变红（防止前端卡在绿色状态）
        // 既然找不到具体的 script，我们无法精确变红，但通常这意味着后端重启过
        // 你可以选择发一个特殊的事件重置前端，或者忽略
    } else {
        socket.emit('log', { name: projectName, data: '\r\n\x1b[31m[ ☠️ 已执行强制终止指令 ]\x1b[0m\r\n' });
    }
  });

  // 5. 打开文件 (VS Code)
  socket.on('open-file', (filePath) => {
      // 防止命令注入的简单过滤
      if (!filePath || /[&|;]/.test(filePath)) return;
      exec(`code -g "${filePath}"`, (err) => {
          if (err) exec(`explorer /select,"${filePath.split(':')[0]}"`); // 降级方案
      });
  });
  // --- 打开项目所在的文件夹 (资源管理器) ---
  socket.on('open-project-folder', (projectPath) => {
    console.log('📂 请求打开文件夹:', projectPath);
    if (!projectPath) return;

    if (process.platform === 'win32') {
      // 通过 Shell.Application COM 对象打开，窗口能正确获得焦点置顶
      const escaped = projectPath.replace(/'/g, "''");
      exec(`powershell -NoProfile -NonInteractive -Command "(New-Object -ComObject Shell.Application).Explore('${escaped}')"`);
    } else if (process.platform === 'darwin') {
      exec(`open "${projectPath}"`);
    } else {
      exec(`xdg-open "${projectPath}"`);
    }
  });

  // --- 在项目路径下打开系统终端 ---
  socket.on('open-terminal', (projectPath) => {
    console.log('💻 请求打开终端:', projectPath);
    if (!projectPath) return;

    let cmd;
    if (process.platform === 'win32') {
      cmd = `start cmd /K "cd /d "${projectPath}""`;
    } else if (process.platform === 'darwin') {
      cmd = `open -a Terminal "${projectPath}"`;
    } else {
      cmd = `x-terminal-emulator --working-directory="${projectPath}" || gnome-terminal --working-directory="${projectPath}"`;
    }

    exec(cmd, (err) => {
      if (err) {
        console.error('打开终端失败:', err);
      }
    });
  });

  // 1. 获取 Git 变更 (用于发给 AI)
  socket.on('git:get-diff', ({ projectPath }, callback) => {
    // 获取未暂存和已暂存的所有变更
    // 限制 3000 字符，防止 Token 爆炸
    exec('git diff HEAD', { cwd: projectPath, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        // 可能是新仓库没有 HEAD，尝试 git status
        exec('git status -s', { cwd: projectPath }, (e, statusOut) => {
          callback({ diff: statusOut || '', error: null });
        });
      } else {
        const diff = stdout.length > 4000 ? stdout.slice(0, 4000) + '\n...(截断)' : stdout;
        callback({ diff: diff, error: null });
      }
    });
  });

  // 2. 执行 Git 提交（支持自动拉取和推送）
  socket.on('git:commit', ({ projectPath, message, autoPush }, callback) => {
    console.log(`📝 [Git] 正在提交项目: ${projectPath}${autoPush ? ' (Pull → Commit → Push)' : ''}`);

    // 封装 spawn 为 Promise，便于链式调用
    const runGit = (args) => new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: projectPath });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => stdout += d.toString());
      child.stderr.on('data', d => stderr += d.toString());
      child.on('close', code => code === 0 ? resolve(stdout) : reject(stderr || stdout));
    });

    (async () => {
      try {
        await runGit(['add', '.']);
        await runGit(['commit', '-m', message]);
        if (autoPush) {
          try {
            await runGit(['pull', '--rebase']);
          } catch (pullErr) {
            // rebase 冲突时自动回滚，避免仓库卡在中间状态
            await runGit(['rebase', '--abort']).catch(() => {});
            return callback({ success: false, error: `拉取冲突，提交已保留在本地，请手动解决冲突后推送\n${pullErr}` });
          }
          await runGit(['push']);
        }
        console.log('✅ Git 操作成功');
        callback({ success: true });
      } catch (err) {
        if (err.includes('nothing to commit')) {
          callback({ success: true, output: '没有检测到文件变化' });
        } else {
          console.error('❌ Git 操作失败:', err);
          callback({ success: false, error: err });
        }
      }
    })();
  });

  socket.on('config:load', (key, callback) => {
    const allData = readConfigFile();
    const value = allData[key] || null; // 取出对应 key 的值
    console.log(`📖 读取配置 [${key}]`);
    callback(value); // ✅ 发回前端
  });

  // 💾 【监听】前端请求保存配置
  socket.on('config:save', ({ key, value }) => {
    const allData = readConfigFile();
    allData[key] = value; // 更新对应的 key
    writeConfigFile(allData); // 写入硬盘
    console.log(`💾 保存配置 [${key}] Success`);
  });

  // --- Node 版本管理事件 ---
  socket.on('node:get-versions', (callback) => {
    const nvmHome = nodeVersions.getNvmHome();
    const versions = nodeVersions.getInstalledVersions();
    console.log(`📦 [Node] 已安装版本: ${versions.length > 0 ? versions.join(', ') : '未检测到 nvm'}`);
    callback({
      nvmDetected: !!nvmHome,
      nvmHome: nvmHome || '',
      versions
    });
  });

  socket.on('node:detect-version', ({ projectPath }, callback) => {
    const detected = nodeVersions.detectProjectNodeVersion(projectPath);
    const resolved = detected ? nodeVersions.resolveNodeVersion(detected.raw) : null;
    callback({ detected, resolved });
  });

  socket.on('proxy:claude', async ({ message, systemPrompt, configId }, callback) => {
    // 从配置文件读取 AI 配置，支持场景级指定
    const allConfig = readConfigFile();
    const configList = allConfig['ai_config_list'] || [];
    const targetId = configId || allConfig['ai_active_id'] || '';
    const aiConfig = configList.find(c => c.id === targetId) || configList[0];

    if (!aiConfig || !aiConfig.baseURL || !aiConfig.apiKey) {
      return callback({ success: false, error: '请先在设置中配置 AI 模型的 Base URL 和 API Key' });
    }

    const provider = aiConfig.provider || 'openai';
    const base = aiConfig.baseURL.replace(/\/+$/, '');
    const model = aiConfig.model || 'gpt-3.5-turbo';
    console.log(`🕵️‍♀️ [proxy:claude] provider=${provider}, model=${model}`);

    let url, headers, body;

    if (provider === 'anthropic') {
      // Anthropic 原生协议 (/v1/messages)
      url = base + '/v1/messages';
      headers = {
        "Content-Type": "application/json",
        "x-api-key": aiConfig.apiKey,
        "anthropic-version": "2023-06-01"
      };
      body = { model, max_tokens: 4096, messages: [{ role: "user", content: message }] };
      if (systemPrompt) body.system = systemPrompt;
    } else if (provider === 'gemini') {
      // Google Gemini (/v1beta/models/xxx:generateContent)
      url = `${base}/v1beta/models/${model}:generateContent?key=${aiConfig.apiKey}`;
      headers = { "Content-Type": "application/json" };
      const parts = [{ text: message }];
      if (systemPrompt) parts.unshift({ text: systemPrompt });
      body = { contents: [{ parts }] };
    } else {
      // OpenAI 兼容协议 (openai / deepseek / codex 等)
      url = base + '/v1/chat/completions';
      headers = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${aiConfig.apiKey}`
      };
      body = { model, messages: [{ role: "user", content: message }], stream: false };
      if (systemPrompt) body.messages.unshift({ role: "system", content: systemPrompt });
    }

    try {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const rawText = await response.text();
      console.log(`[Status] ${response.status}`);

      let data;
      try { data = JSON.parse(rawText); } catch {
        console.error("❌ 返回非 JSON:", rawText.substring(0, 200));
        return callback({ success: false, error: "API 返回非 JSON 数据" });
      }

      if (data.error) {
        console.error("❌ API 错误:", data.error);
        return callback({ success: false, error: data.error.message || JSON.stringify(data.error) });
      }

      // 按 provider 提取内容
      let content;
      if (provider === 'anthropic') {
        content = data.content?.[0]?.text;
      } else if (provider === 'gemini') {
        content = data.candidates?.[0]?.content?.parts?.[0]?.text;
      } else {
        content = data.choices?.[0]?.message?.content;
      }

      if (content) {
        console.log("✅ 成功拿到内容！");
        callback({ success: true, data: content });
      } else {
        console.error("❌ 结构异常:", JSON.stringify(data).substring(0, 300));
        callback({ success: false, error: "返回数据结构异常" });
      }
    } catch (e) {
      console.error("❌ 网络请求失败:", e);
      callback({ success: false, error: e.message });
    }
  });

  // 在项目目录下执行单条命令（供 AI 修复功能使用）
  socket.on('exec:run', ({ command, cwd }, callback) => {
    if (!command || !cwd) {
      return callback({ success: false, error: '缺少 command 或 cwd 参数' });
    }
    console.log(`🔧 [exec:run] 在 ${cwd} 执行: ${command}`);
    exec(command, { cwd, shell: true, timeout: 60000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      callback({
        success: !error,
        stdout: stdout?.toString() || '',
        stderr: stderr?.toString() || '',
        error: error?.message || ''
      });
    });
  });

  // 读取文件内容（供 AI 修复读取源文件）
  socket.on('file:read', ({ filePath }, callback) => {
    try {
      if (!fs.existsSync(filePath)) {
        return callback({ success: false, error: `文件不存在: ${filePath}` });
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      callback({ success: true, content });
    } catch (e) {
      callback({ success: false, error: e.message });
    }
  });

  // 写入文件（供 AI 修复应用代码变更）
  socket.on('file:write', ({ filePath, content }, callback) => {
    try {
      fs.writeFileSync(filePath, content, 'utf-8');
      console.log(`📝 [file:write] 已写入: ${filePath}`);
      callback({ success: true });
    } catch (e) {
      callback({ success: false, error: e.message });
    }
  });
});

// --- ✨ 核心修复：监听主进程退出事件 ---
let isCleaningUp = false;
const cleanup = () => {
  if (isCleaningUp) return;
  isCleaningUp = true;

  if (cloudflaredProcess) {
    killProcessTree(cloudflaredProcess, 'cloudflared');
  }
  stopTunnelGatewayServer();

  for (const [key, child] of processes) {
    killProcessTree(child, key);
  }

  setTimeout(() => {
    process.exit(0);
  }, 600);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// 防止未捕获异常导致 server 崩溃重启（--watch 模式下崩溃会丢失所有进程追踪）
process.on('uncaughtException', (err) => {
  console.error('⚠️ [uncaughtException] 捕获未处理异常（已阻止崩溃）:', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ [unhandledRejection] 捕获未处理 Promise 拒绝:', reason);
});
// 👇 2. 在文件最底部，server.listen 之前，添加“兜底路由”
// 作用：无论用户访问什么 URL，如果不是 API，都返回 index.html (支持 Vue Router history 模式)
app.get(/.*/, (req, res) => {
    const indexPath = path.join(clientDistPath, 'index.html');
    
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Backend is running, but index.html not found.');
    }
});
if (require.main === module) {
    startTunnelGatewayServer();
    restoreTunnelTargetFromConfig();
    server.listen(2117, () => console.log('Server running on 2117'));
}

module.exports = server;
