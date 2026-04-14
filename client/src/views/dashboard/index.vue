<script setup>
import { ref, onMounted, computed, onUnmounted } from 'vue'
import { socket } from "../../utils/socket";
import ProjectList from '../../components/ProjectList.vue'
import AiSettings from '../../components/AiSettings.vue';
import { useAiConfig } from '../../utils/useAiConfig';

const showSettings = ref(false); // 控制弹窗显示
const { tunnelConfig, wechatDevtoolsConfig } = useAiConfig();
const WORKSPACE_CONFIG_KEY = 'workspace_root_path';
const HIDDEN_PROJECTS_CONFIG_KEY = 'hidden_projects_by_workspace';
const LEGACY_HIDDEN_PROJECTS_KEY = 'hidden-projects';
const PROJECT_TAGS_CONFIG_KEY = 'project_tags_by_path';

// --- 状态定义 ---
const currentPath = ref('')
const rawProjects = ref([])
const projectLogs = ref({})
const hiddenProjectPaths = ref(new Set())
const showHidden = ref(false)
const isScanning = ref(false)
const stats = ref({}) // 存放实时监控数据
const installedNodeVersions = ref([]) // nvm 已安装的 Node 版本列表
const nvmDetected = ref(false) // 是否检测到 nvm
const hiddenProjectsStore = ref({})
const tunnelState = ref({
  gatewayPort: 26324,
  gatewayRunning: false,
  gatewayError: '',
  activeTarget: null,
  cloudflaredRunning: false
})

const normalizePath = (value = '') =>
  String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()

const getClientPlatform = () => {
  if (typeof navigator === 'undefined') return 'unknown'
  const rawPlatform = String(navigator.userAgentData?.platform || navigator.platform || '').toLowerCase()
  if (rawPlatform.includes('win')) return 'win32'
  if (rawPlatform.includes('mac')) return 'darwin'
  return 'unknown'
}

const currentPlatform = getClientPlatform()

const normalizeHiddenProjectsStore = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const result = {}
  Object.entries(input).forEach(([workspacePath, pathList]) => {
    const workspaceKey = normalizePath(workspacePath)
    if (!workspaceKey || !Array.isArray(pathList)) return
    const deduped = [...new Set(pathList.map(normalizePath).filter(Boolean))]
    result[workspaceKey] = deduped
  })
  return result
}

const saveHiddenStore = () => {
  socket.emit('config:save', {
    key: HIDDEN_PROJECTS_CONFIG_KEY,
    value: hiddenProjectsStore.value
  })
}

const loadHiddenStore = (callback) => {
  socket.emit('config:load', HIDDEN_PROJECTS_CONFIG_KEY, (savedStore) => {
    hiddenProjectsStore.value = normalizeHiddenProjectsStore(savedStore)
    callback?.()
  })
}

const migrateLegacyHiddenNamesForWorkspace = (allowMigration = false) => {
  if (!allowMigration) return
  const workspaceKey = normalizePath(currentPath.value)
  if (!workspaceKey) return
  if (Object.prototype.hasOwnProperty.call(hiddenProjectsStore.value, workspaceKey)) return

  const legacyRaw = localStorage.getItem(LEGACY_HIDDEN_PROJECTS_KEY)
  if (!legacyRaw) return

  let legacyNames = []
  try {
    const parsed = JSON.parse(legacyRaw)
    if (Array.isArray(parsed)) {
      legacyNames = parsed.map(v => String(v || '').trim()).filter(Boolean)
    }
  } catch {
    return
  }
  if (legacyNames.length === 0) return

  const legacyNameSet = new Set(legacyNames)
  const matchedPathKeys = rawProjects.value
    .filter(p => legacyNameSet.has(p.name))
    .map(p => p.normalizedPath || normalizePath(p.path))
    .filter(Boolean)

  if (matchedPathKeys.length === 0) return
  hiddenProjectPaths.value = new Set(matchedPathKeys)
  saveHiddenSetForWorkspace(currentPath.value)
}

const loadWorkspaceAndScan = () => {
  socket.emit('config:load', WORKSPACE_CONFIG_KEY, (savedPath) => {
    const normalizedPath = typeof savedPath === 'string' ? savedPath.trim() : ''
    if (!normalizedPath) return
    currentPath.value = normalizedPath
    loadHiddenSetForWorkspace(normalizedPath)
    isScanning.value = true
    socket.emit('scan-dir', normalizedPath)
  })
}

const canAccessLocalStorage = () => {
  try {
    return typeof window !== 'undefined' && !!window.localStorage
  } catch {
    return false
  }
}

const loadHiddenSetForWorkspace = (workspacePath) => {
  const workspaceKey = normalizePath(workspacePath)
  if (!workspaceKey) {
    hiddenProjectPaths.value = new Set()
    return
  }
  const savedPaths = hiddenProjectsStore.value[workspaceKey]
  hiddenProjectPaths.value = new Set(
    Array.isArray(savedPaths) ? savedPaths.map(normalizePath).filter(Boolean) : []
  )
}

const saveHiddenSetForWorkspace = (workspacePath) => {
  const workspaceKey = normalizePath(workspacePath)
  if (!workspaceKey) return
  hiddenProjectsStore.value = {
    ...hiddenProjectsStore.value,
    [workspaceKey]: [...hiddenProjectPaths.value].map(normalizePath).filter(Boolean)
  }
  saveHiddenStore()
}

// --- 初始化 ---
onMounted(() => {
  loadHiddenStore(loadWorkspaceAndScan)

  // 加载已安装的 Node 版本列表
  socket.emit('node:get-versions', (data) => {
    nvmDetected.value = data.nvmDetected
    installedNodeVersions.value = data.versions || []
    console.log(`📦 NVM ${data.nvmDetected ? '已检测到' : '未检测到'}, 已安装版本: ${data.versions.length}`)
  })

  // 建立连接日志
  socket.on('connect', () => console.log('✅ Socket已连接, id:', socket.id))
  socket.on('disconnect', (reason) => console.warn('❌ Socket断开:', reason))
  socket.on('reconnect', () => console.log('🔄 Socket重连成功'))
  socket.on('tunnel:state', (state) => {
    if (state) tunnelState.value = state
  })
  socket.emit('tunnel:get-state', (state) => {
    if (state) tunnelState.value = state
  })
})

onUnmounted(() => {
  socket.off('monitor:update')
  socket.off('projects-loaded')
  socket.off('status-change')
  socket.off('log')
  socket.off('command:status-change')
  socket.off('tunnel:state')
})

// --- 计算属性 ---
const visibleProjects = computed(() => {
  if (showHidden.value) return rawProjects.value
  return rawProjects.value.filter(p => !hiddenProjectPaths.value.has(p.normalizedPath || normalizePath(p.path)))
})

const projectCountLabel = computed(() => {
  const total = rawProjects.value.length
  const visible = visibleProjects.value.length
  return total === visible ? `${total}` : `${visible} / ${total}`
})

const runningProjectCount = computed(() => {
  return rawProjects.value.filter(p => 
    p.runningScripts && Object.values(p.runningScripts).some(Boolean)
  ).length
})

const wechatDevtoolsConfigured = computed(() => {
  if (currentPlatform === 'win32') {
    return !!String(wechatDevtoolsConfig.value.windowsPath || '').trim()
  }
  if (currentPlatform === 'darwin') {
    return !!String(wechatDevtoolsConfig.value.macosPath || '').trim()
  }
  return false
})

// --- Socket 事件处理 ---

// 1. 收到监控数据
socket.on('monitor:update', (data) => {
  // data Key 是 "ProjectName:script"，我们需要映射到 ProjectPath
  Object.keys(data).forEach(taskKey => {
    const [projName] = taskKey.split(':')
    const project = rawProjects.value.find(p => p.name === projName)
    if (project) {
      stats.value[project.path] = data[taskKey]
    }
  })
})

// 2. 加载项目列表
socket.on('projects-loaded', (data) => {
  isScanning.value = false
  rawProjects.value = data.map(p => ({
    ...p,
    normalizedPath: normalizePath(p.path),
    runningScripts: p.runningScripts || {},
    commandRunning: !!p.commandRunning,
    runningCommand: p.runningCommand || '',
    isMiniProgram: p.isMiniProgram === true
  }))
  migrateLegacyHiddenNamesForWorkspace(canAccessLocalStorage())
})

// 3. 状态变更
socket.on('status-change', ({ name, script, running }) => {
  const p = rawProjects.value.find(x => x.name === name)
  if (p) {
    if (!p.runningScripts) p.runningScripts = {}
    p.runningScripts[script] = running
    // 停止时清理监控数据
    if (!running && stats.value[p.path]) {
      // 只有当所有脚本都停止时才完全删除监控显示? 
      // 简单起见，如果收到停止信号，可以暂时不管，monitor:update 会自动停止推送
    }
  }
})

socket.on('project:stopped', ({ id }) => {
  // 这里的 ID 可能是 path 或 name，视后端实现而定，做个防御清理
  if (stats.value[id]) delete stats.value[id]
})

// 4. 日志
socket.on('log', ({ name, data }) => {
  if (!projectLogs.value[name]) projectLogs.value[name] = []
  projectLogs.value[name].push(data)
})

socket.on('command:status-change', ({ projectPath, running, command }) => {
  const project = rawProjects.value.find(x => x.path === projectPath)
  if (!project) return
  project.commandRunning = running
  project.runningCommand = running ? String(command || '') : ''
})

socket.on('folder-selected', path => {
  const normalizedPath = typeof path === 'string' ? path.trim() : ''
  currentPath.value = normalizedPath
  if (normalizedPath) {
    socket.emit('config:save', { key: WORKSPACE_CONFIG_KEY, value: normalizedPath })
  }
  loadHiddenSetForWorkspace(normalizedPath)
  isScanning.value = true
})

// --- 动作方法 ---
const manualScan = () => {
  const normalizedPath = typeof currentPath.value === 'string' ? currentPath.value.trim() : ''
  if (normalizedPath) {
    currentPath.value = normalizedPath
    socket.emit('config:save', { key: WORKSPACE_CONFIG_KEY, value: normalizedPath })
    loadHiddenSetForWorkspace(normalizedPath)
    isScanning.value = true
    rawProjects.value = [] // 清空以显示 loading 态
    socket.emit('scan-dir', normalizedPath)
  }
}

const openNativeDialog = () => socket.emit('open-folder-dialog')

const handleRun = (p, script) => {
  console.log(`[handleRun] 触发! socket.connected=${socket.connected}, 项目=${p.name}, 脚本=${script}`)
  // 如果是 dev 类脚本，清空一下旧日志
  if (['dev', 'start', 'serve'].includes(script)) {
    projectLogs.value[p.name] = []
  }
  socket.emit('start-task', {
    projectName: p.name,
    script,
    projectPath: p.path,
    runner: p.runner,
    nodeVersion: p.effectiveNodeVersion || null
  })
}

const handleNodeVersionChange = (p, version) => {
  // 保存手动覆盖到配置文件
  socket.emit('config:load', 'node_version_overrides', (overrides) => {
    const newOverrides = { ...(overrides || {}) }
    if (version === 'auto') {
      // 清除手动覆盖，回到自动检测
      delete newOverrides[p.path]
    } else if (version === 'system') {
      // 显式指定使用系统默认
      newOverrides[p.path] = 'system'
    } else {
      // 手动指定具体版本
      newOverrides[p.path] = version
    }
    socket.emit('config:save', { key: 'node_version_overrides', value: newOverrides })

    // 更新本地项目数据
    const project = rawProjects.value.find(x => x.path === p.path)
    if (project) {
      if (version === 'auto') {
        project.nodeVersionOverride = null
        project.effectiveNodeVersion = project.resolvedNodeVersion?.version || null
        project.nodeVersionSource = project.resolvedNodeVersion ? 'auto' : 'system'
      } else if (version === 'system') {
        project.nodeVersionOverride = null
        project.effectiveNodeVersion = null
        project.nodeVersionSource = 'system'
      } else {
        project.nodeVersionOverride = version
        project.effectiveNodeVersion = version
        project.nodeVersionSource = 'manual'
      }
    }
  })
}

const handleStop = (p) => {
  socket.emit('stop-task', p.name)
  // 乐观更新 UI
  if (p.runningScripts) {
    Object.keys(p.runningScripts).forEach(k => p.runningScripts[k] = false)
  }
  if (stats.value[p.path]) delete stats.value[p.path]
}

const handleMiniProgramToggle = (p) => {
  socket.emit('config:load', PROJECT_TAGS_CONFIG_KEY, (savedTags) => {
    const nextTags = { ...(savedTags || {}) }
    const nextValue = !p.isMiniProgram

    if (nextValue) {
      nextTags[p.path] = { ...(nextTags[p.path] || {}), isMiniProgram: true }
    } else {
      delete nextTags[p.path]
    }

    socket.emit('config:save', { key: PROJECT_TAGS_CONFIG_KEY, value: nextTags })

    const project = rawProjects.value.find(x => x.path === p.path)
    if (project) {
      project.isMiniProgram = nextValue
    }
  })
}

const handleOpenWechatDevtools = (p) => {
  socket.emit('tool:open-wechat-devtools', { projectPath: p.path }, ({ success, error }) => {
    if (success) {
      window.$toast?.success?.('已启动微信开发者工具')
      return
    }
    window.$toast?.warning?.(error || '打开微信开发者工具失败')
  })
}

const handleRunCommand = ({ project, command }) => {
  const trimmedCommand = String(command || '').trim()
  if (!trimmedCommand) {
    window.$toast?.warning?.('请输入要执行的命令')
    return
  }

  socket.emit('project:run-command', {
    projectPath: project.path,
    projectName: project.name,
    command: trimmedCommand,
    nodeVersion: project.effectiveNodeVersion || null
  }, ({ success, error }) => {
    if (!success) {
      window.$toast?.warning?.(error || '执行命令失败')
    }
  })
}

const handleStopCommand = (p) => {
  socket.emit('project:stop-command', {
    projectPath: p.path
  }, ({ success, error }) => {
    if (!success) {
      window.$toast?.warning?.(error || '停止命令失败')
    }
  })
}

const toggleHide = (p) => {
  const pathKey = p.normalizedPath || normalizePath(p.path)
  if (!pathKey) return
  if (hiddenProjectPaths.value.has(pathKey)) hiddenProjectPaths.value.delete(pathKey)
  else hiddenProjectPaths.value.add(pathKey)
  saveHiddenSetForWorkspace(currentPath.value)
}
</script>

<template>
  <div class="flex flex-col min-h-screen font-sans text-white bg-gray-900">
    <div class="sticky top-0 z-10 flex flex-col items-center gap-4 p-4 bg-gray-800 border-b border-gray-700 shadow-lg md:flex-row">
      <h1 class="flex items-center text-xl font-bold text-blue-400 whitespace-nowrap">
        <img style="width:50px; height: 50px" src="../../assets/main.png"/>
        terminalManage
      </h1>

      <div class="flex flex-1 w-full gap-2">
        <input
          v-model="currentPath"
          @keyup.enter="manualScan"
          :disabled="isScanning"
          type="text"
          class="w-full px-3 py-2 font-mono text-sm text-gray-300 bg-gray-900 border border-gray-600 rounded focus:outline-none focus:border-blue-500 disabled:opacity-50"
          placeholder="输入路径或点击右侧按钮选择..."
        />
        <button @click="openNativeDialog" :disabled="isScanning" class="flex items-center gap-2 px-4 py-2 text-sm font-medium transition bg-gray-700 border border-gray-600 rounded hover:bg-gray-600 whitespace-nowrap disabled:opacity-50">
          📂 <span class="hidden sm:inline">选择</span>
        </button>
        <button @click="manualScan" :disabled="isScanning" class="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-sm font-medium whitespace-nowrap transition shadow-sm shadow-blue-900/50 flex items-center gap-2 disabled:opacity-50 min-w-[80px] justify-center">
          <span v-if="!isScanning">🔄</span>
          <svg v-else class="w-4 h-4 text-white animate-spin" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          {{ isScanning ? '扫描中' : '扫描' }}
        </button>
      </div>

      <div class="flex items-center gap-4">
        <div class="flex items-center gap-2 px-3 py-1 text-xs bg-gray-900 border border-gray-700 rounded-full" :class="{ 'border-green-900/50 bg-green-900/10': runningProjectCount > 0 }">
          <div :class="['w-2 h-2 rounded-full transition-all', runningProjectCount > 0 ? 'bg-green-500 animate-pulse' : 'bg-gray-600']"></div>
          <span :class="runningProjectCount > 0 ? 'text-green-400 font-bold' : 'text-gray-500'">Running: {{ runningProjectCount }}</span>
        </div>
        <div class="flex items-center gap-2 px-3 py-1 text-xs text-gray-400 bg-gray-900 border border-gray-700 rounded-full">
          <span>Total:</span><span class="font-bold text-blue-400">{{ projectCountLabel }}</span>
        </div>
        <label class="flex items-center gap-2 cursor-pointer hover:text-gray-300">
          <input type="checkbox" v-model="showHidden" class="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-0">
          <span class="text-xs text-gray-400">显示隐藏</span>
        </label>
        <button 
          @click="showSettings = true"
          class="p-2 ml-2 text-gray-400 transition rounded-full hover:text-white hover:bg-gray-700"
          title="全局设置"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
        </button>
      </div>
    </div>

    <div class="relative flex-1 p-6 overflow-auto">
      <div v-if="isScanning && visibleProjects.length === 0" class="absolute inset-0 z-20 flex flex-col items-center justify-center bg-gray-900/80 backdrop-blur-sm">
        <div class="w-12 h-12 mb-4 border-b-2 border-blue-500 rounded-full animate-spin"></div>
        <p class="text-blue-400 animate-pulse">正在深度扫描...</p>
      </div>

      <ProjectList
        :projects="visibleProjects"
        :stats="stats"
        :logs="projectLogs"
        :hidden-set="hiddenProjectPaths"
        :installed-node-versions="installedNodeVersions"
        :nvm-detected="nvmDetected"
        :wechat-devtools-configured="wechatDevtoolsConfigured"
        :tunnel-state="tunnelState"
        :tunnel-public-domain="tunnelConfig.publicDomain || ''"
        :tunnel-active-project-path="tunnelConfig.activeProjectPath || ''"
        @run="handleRun"
        @stop="handleStop"
        @run-command="handleRunCommand"
        @stop-command="handleStopCommand"
        @open-folder="(path) => socket.emit('open-project-folder', path)"
        @open-terminal="(path) => socket.emit('open-terminal', path)"
        @open-file="(uri) => socket.emit('open-file', uri)"
        @toggle-hide="toggleHide"
        @toggle-mini-program="handleMiniProgramToggle"
        @open-wechat-devtools="handleOpenWechatDevtools"
        @node-version-change="handleNodeVersionChange"
      />
      <AiSettings 
        :visible="showSettings" 
        @close="showSettings = false" 
      />
    </div>
  </div>
</template>
