const pidusage = require('pidusage');
const pidtree = require('pidtree');

// 存储监控目标：Key = 项目ID/名称, Value = 根进程 PID (npm 的 PID)
const targets = new Map();
let isRunning = false;

const addMonitor = (projectId, pid) => {
  targets.set(projectId, pid);
};

const removeMonitor = (projectId) => {
  targets.delete(projectId);
  // 清理 pidusage 对该 PID 的内部缓存，防止残留状态导致后续查询异常
  try { pidusage.clear(); } catch (_) {}
};

/**
 * 获取单个项目的真实资源占用（聚合子进程）
 */
const getProjectStats = async (rootPid) => {
  try {
    const children = await pidtree(rootPid).catch(() => []);
    const allPids = [rootPid, ...children];
    const stats = await pidusage(allPids);

    let totalCpu = 0;
    let totalMem = 0;

    for (const s of Object.values(stats)) {
      if (s && typeof s.cpu === 'number' && typeof s.memory === 'number') {
        totalCpu += s.cpu;
        totalMem += s.memory;
      }
    }

    return { cpu: totalCpu, memory: totalMem };
  } catch (err) {
    return null;
  }
};

/**
 * 启动轮询
 * @param {Object} io Socket.io 实例
 */
const startLoop = (io) => {
  if (isRunning) return;
  isRunning = true;
  console.log('✅ 监控循环已启动');

  setInterval(async () => {
    if (targets.size === 0) return;

    try {
      // 快照当前 targets，防止 await 期间 Map 被外部修改导致迭代异常
      const snapshot = Array.from(targets.entries());
      const payload = {};

      for (const [id, pid] of snapshot) {
        // 二次确认目标仍存在（可能在 await 间隙被 removeMonitor 了）
        if (!targets.has(id)) continue;

        const data = await getProjectStats(pid);
        if (data) {
          payload[id] = {
            cpu: data.cpu.toFixed(1),
            memory: data.memory
          };
        }
      }

      if (Object.keys(payload).length > 0) {
        io.emit('monitor:update', payload);
      }
    } catch (err) {
      // 兜底：无论发生什么都不能让这个回调崩溃 server
      console.error('⚠️ [monitor] 轮询异常:', err.message);
    }
  }, 2000);
};

module.exports = { addMonitor, removeMonitor, startLoop };
