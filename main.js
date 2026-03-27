const { app, BrowserWindow, Menu, Tray, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fixPath = require('fix-path');
const appUpdater = require('./server/utils/appUpdater');

const isProd = !process.argv.includes('--dev') && app.isPackaged;
const shouldHideMenu = !process.argv.includes('--show-menu');

// 修复环境变量
fixPath();

// 引入后端
let server;
try {
  server = require('./server/index.js');
} catch (e) {
  console.error('❌ 后端加载失败，请检查根目录 node_modules:', e);
}

let mainWindow;
let tray = null;
let isQuitting = false;
let hasRequestedCleanup = false;
let appBaseUrl = '';
let serverStartPromise = null;

function isInternalAppUrl(targetUrl) {
  if (!targetUrl) return false;

  try {
    const parsedTarget = new URL(targetUrl);

    // 允许应用自己的 data 错误页和 about:blank
    if (parsedTarget.protocol === 'data:' || parsedTarget.href === 'about:blank') {
      return true;
    }

    if (!appBaseUrl) return false;

    const parsedBase = new URL(appBaseUrl);
    return (
      parsedTarget.protocol === parsedBase.protocol &&
      parsedTarget.hostname === parsedBase.hostname &&
      parsedTarget.port === parsedBase.port
    );
  } catch (e) {
    return false;
  }
}

function getFallbackErrorPage(errorMessage) {
  const safeMessage = String(errorMessage || 'Unknown error').replace(/</g, '&lt;');
  return `data:text/html;charset=UTF-8,${encodeURIComponent(
    `<html><body style="font-family: sans-serif; padding: 24px; background: #111827; color: #e5e7eb;">
      <h2>terminalManage 启动失败</h2>
      <p>无法连接到内置服务，请重启应用后重试。</p>
      <pre style="white-space: pre-wrap; color: #fca5a5;">${safeMessage}</pre>
    </body></html>`
  )}`;
}

function ensureServerUrl() {
  if (!server) {
    return Promise.reject(new Error('Server module is unavailable.'));
  }

  if (appBaseUrl) {
    return Promise.resolve(appBaseUrl);
  }

  if (server.listening) {
    const currentPort = server.address()?.port;
    if (currentPort) {
      appBaseUrl = `http://localhost:${currentPort}`;
      return Promise.resolve(appBaseUrl);
    }
  }

  if (serverStartPromise) {
    return serverStartPromise;
  }

  serverStartPromise = new Promise((resolve, reject) => {
    const handleError = (err) => {
      server.off('listening', handleListening);
      serverStartPromise = null;
      reject(err);
    };

    const handleListening = () => {
      server.off('error', handleError);
      const port = server.address()?.port;
      if (!port) {
        serverStartPromise = null;
        reject(new Error('Server started but port is unavailable.'));
        return;
      }
      appBaseUrl = `http://localhost:${port}`;
      console.log(`🚀 terminalManage 已启动，自动分配端口: ${port}`);
      resolve(appBaseUrl);
    };

    server.once('error', handleError);
    server.once('listening', handleListening);

    try {
      server.listen(0);
    } catch (err) {
      server.off('error', handleError);
      server.off('listening', handleListening);
      serverStartPromise = null;
      reject(err);
    }
  });

  return serverStartPromise;
}

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, 'client/dist/favicon.ico'),
    path.join(__dirname, 'client/dist/mac.png'),
    path.join(__dirname, 'client/src/assets/main.png')
  ];
  return candidates.find((item) => fs.existsSync(item)) || candidates[0];
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;

  tray = new Tray(resolveAppIconPath());
  tray.setToolTip('terminalManage');

  const trayMenu = Menu.buildFromTemplate([
    { label: '显示窗口', click: showMainWindow },
    { label: '隐藏窗口', click: hideMainWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: requestQuitApp
    }
  ]);

  tray.setContextMenu(trayMenu);
  tray.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
      showMainWindow();
      return;
    }
    hideMainWindow();
  });
}

async function shutdownManagedProcesses() {
  if (hasRequestedCleanup) return;
  hasRequestedCleanup = true;
  if (!server) return;

  const cleanupFn = server.cleanupManagedProcesses;
  if (typeof cleanupFn !== 'function') return;

  try {
    await Promise.resolve(cleanupFn());
  } catch (err) {
    console.error('⚠️ 退出前清理托管进程失败:', err);
  }
}

async function requestQuitApp() {
  if (isQuitting) return;
  isQuitting = true;
  await shutdownManagedProcesses();
  app.quit();
}

function createWindow() {
  if (shouldHideMenu) {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "terminalManage",
    icon: resolveAppIconPath(),
    autoHideMenuBar: shouldHideMenu,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  if (shouldHideMenu) {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.removeMenu();
  }

  if (isProd) {
    // 禁用 DevTools
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });

    // 拦截快捷键：F12、Ctrl+Shift+I、Ctrl+Shift+J、Ctrl+Shift+C
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12') {
        event.preventDefault();
        return;
      }
      if (input.control && input.shift && ['I', 'J', 'C'].includes(input.key.toUpperCase())) {
        event.preventDefault();
      }
    });
  }

  // 所有外链默认交给系统浏览器，不在 Electron 内嵌窗口打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalAppUrl(url)) {
      return { action: 'allow' };
    }
    shell.openExternal(url).catch((err) => {
      console.error('❌ 打开外部链接失败:', err);
    });
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isInternalAppUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url).catch((err) => {
      console.error('❌ 打开外部链接失败:', err);
    });
  });

  ensureServerUrl()
    .then((url) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      return mainWindow.loadURL(url);
    })
    .catch((err) => {
      console.error('❌ 加载内置服务失败:', err);
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(getFallbackErrorPage(err?.message || err));
    });

  mainWindow.on('close', (event) => {
    if (isQuitting || !app.isPackaged) return;
    event.preventDefault();
    hideMainWindow();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('ready', () => {
  createTray();
  createWindow();
  appUpdater.setup();

  if (app.isPackaged) {
    // 启动后延迟检查，避免和首屏加载抢资源
    setTimeout(() => {
      appUpdater.checkForUpdates().catch(() => {});
    }, 12000);

    // 定时轮询更新（每 3 小时）
    setInterval(() => {
      appUpdater.checkForUpdates().catch(() => {});
    }, 3 * 60 * 60 * 1000);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  shutdownManagedProcesses();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
  else showMainWindow();
});
