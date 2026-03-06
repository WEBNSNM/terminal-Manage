const express = require('express');
const http = require('http');
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

      return [{
        name: folderName,
        path: currentPath,
        runner: runner,
        scripts: pkg.scripts || {},
        detectedNodeVersion: detected,   // { raw, source } | null
        resolvedNodeVersion: resolved     // { version, exact } | null
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

      return {
        ...p,
        runningScripts,
        nodeVersionOverride: (override && override !== 'system') ? override : null,
        effectiveNodeVersion,
        nodeVersionSource
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

    const logHandler = (data) => io.emit('log', { name: projectName, data: data.toString() });
    child.stdout.on('data', logHandler);
    child.stderr.on('data', logHandler);
    child.on('error', (err) => {
       io.emit('log', { name: projectName, data: `❌ 启动失败: ${err.message}` });
    });

    child.on('close', (code) => {
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

  // 2. 执行 Git 提交 (自动暂存所有文件)
  socket.on('git:commit', ({ projectPath, message }, callback) => {
    console.log(`📝 [Git] 正在提交项目: ${projectPath}`);
    
    // 第一步：git add .
    // 使用 spawn 而不是 exec，避免 Shell 注入风险
    const addProcess = spawn('git', ['add', '.'], { cwd: projectPath });

    addProcess.on('close', (code) => {
      if (code !== 0) {
        return callback({ success: false, error: 'git add 失败' });
      }

      // 第二步：git commit -m "message"
      // spawn 会自动处理引号、空格和特殊字符，Mac/Windows 通吃
      const commitProcess = spawn('git', ['commit', '-m', message], { cwd: projectPath });
      
      let errorMsg = '';
      let outputMsg = '';

      commitProcess.stdout.on('data', (d) => outputMsg += d.toString());
      commitProcess.stderr.on('data', (d) => errorMsg += d.toString());

      commitProcess.on('close', (commitCode) => {
        if (commitCode === 0) {
          console.log('✅ Git 提交成功');
          callback({ success: true, output: outputMsg });
        } else {
          // 常见错误：没有变化需要提交 (Nothing to commit)
          if (outputMsg.includes('nothing to commit')) {
             callback({ success: true, output: '没有检测到文件变化' });
          } else {
             console.error('❌ Git 提交失败:', errorMsg);
             // 如果没配置 user.email，错误信息会在这里
             callback({ success: false, error: errorMsg || '提交失败，请检查 Git 配置' });
          }
        }
      });
    });
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

  socket.on('proxy:claude', async ({ message, systemPrompt }, callback) => {
    // 从配置文件读取当前激活的 AI 配置
    const allConfig = readConfigFile();
    const configList = allConfig['ai_config_list'] || [];
    const activeId = allConfig['ai_active_id'] || '';
    const aiConfig = configList.find(c => c.id === activeId) || configList[0];

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
});

// --- ✨ 核心修复：监听主进程退出事件 ---
const cleanup = () => {
    console.log('\n\n🧹 terminalManage 正在关闭，清理所有子进程...');
    
    if (processes.size === 0) {
        console.log('✅ 没有活动的子进程。');
        process.exit(0);
    }

    // 遍历所有正在运行的进程并杀掉
    for (const [key, child] of processes) {
        // key 可能是 "Project:dev"
        console.log(`正在终止: ${key}...`);
        killProcessTree(child, key);
    }
    
    // 给一点点时间让 taskkill 执行完
    setTimeout(() => {
        console.log('👋 再见！');
        process.exit(0);
    }, 500);
};

process.on('SIGINT', cleanup);

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
    server.listen(3000, () => console.log('✅ Server running on 3000'));
}

module.exports = server;