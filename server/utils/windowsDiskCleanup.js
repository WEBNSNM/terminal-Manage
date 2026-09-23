const { spawn } = require('child_process');

function openWindowsDiskCleanup(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return Promise.reject(new Error('Windows 磁盘清理仅支持 Windows'));
  }

  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnImpl('cleanmgr.exe', ['/d', 'C:'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref?.();
      resolve({ success: true });
    });
  });
}

module.exports = { openWindowsDiskCleanup };
