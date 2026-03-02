<script setup>
import { ref, onMounted, computed, watch, onUnmounted } from 'vue'
import { socket } from "../../utils/socket";
import ProjectList from '../../components/ProjectList.vue'
import AiSettings from '../../components/AiSettings.vue';

const showSettings = ref(false); // 控制弹窗显示

// --- 状态定义 ---
const currentPath = ref('')
const rawProjects = ref([])
const projectLogs = ref({})
const hiddenProjectNames = ref(new Set())
const showHidden = ref(false)
const isScanning = ref(false)
const stats = ref({}) // 存放实时监控数据
const installedNodeVersions = ref([]) // nvm 已安装的 Node 版本列表
const nvmDetected = ref(false) // 是否检测到 nvm

// --- 初始化 ---
onMounted(() => {
  const savedPath = localStorage.getItem('last-workspace')
  if (savedPath) {
    currentPath.value = savedPath
    isScanning.value = true
    socket.emit('scan-dir', savedPath)
  }

  const savedHidden = localStorage.getItem('hidden-projects')
  if (savedHidden) {
    hiddenProjectNames.value = new Set(JSON.parse(savedHidden))
  }

  // 加载已安装的 Node 版本列表
  socket.emit('node:get-versions', (data) => {
    nvmDetected.value = data.nvmDetected
    installedNodeVersions.value = data.versions || []
    console.log(`📦 NVM ${data.nvmDetected ? '已检测到' : '未检测到'}, 已安装版本: ${data.versions.length}`)
  })

  // 建立连接日志
  socket.on('connect', () => console.log('✅ Socket已连接'))
})

onUnmounted(() => {
  socket.off('monitor:update')
  socket.off('projects-loaded')
  socket.off('status-change')
  socket.off('log')
})

watch(hiddenProjectNames, (newSet) => {
  localStorage.setItem('hidden-projects', JSON.stringify([...newSet]))
}, { deep: true })

// --- 计算属性 ---
const visibleProjects = computed(() => {
  if (showHidden.value) return rawProjects.value
  return rawProjects.value.filter(p => !hiddenProjectNames.value.has(p.name))
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
    runningScripts: p.runningScripts || {}
  }))
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

socket.on('folder-selected', path => {
  currentPath.value = path
  localStorage.setItem('last-workspace', path)
  isScanning.value = true
})

// --- 动作方法 ---
const manualScan = () => {
  if (currentPath.value) {
    isScanning.value = true
    rawProjects.value = [] // 清空以显示 loading 态
    socket.emit('scan-dir', currentPath.value)
  }
}

const openNativeDialog = () => socket.emit('open-folder-dialog')

const handleRun = (p, script) => {
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

const toggleHide = (p) => {
  if (hiddenProjectNames.value.has(p.name)) hiddenProjectNames.value.delete(p.name)
  else hiddenProjectNames.value.add(p.name)
}
</script>

<template>
  <div class="flex flex-col min-h-screen font-sans text-white bg-gray-900">
    <div class="sticky top-0 z-10 flex flex-col items-center gap-4 p-4 bg-gray-800 border-b border-gray-700 shadow-lg md:flex-row">
      <h1 class="flex items-center text-xl font-bold text-blue-400 whitespace-nowrap">
        <img style="width:50px; height: 50px" src="../../assets/main.png"/>
        DevMaster
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
          title="AI 全局设置"
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
        :hidden-set="hiddenProjectNames"
        :installed-node-versions="installedNodeVersions"
        :nvm-detected="nvmDetected"
        @run="handleRun"
        @stop="handleStop"
        @open-folder="(path) => socket.emit('open-project-folder', path)"
        @open-file="(uri) => socket.emit('open-file', uri)"
        @toggle-hide="toggleHide"
        @node-version-change="handleNodeVersionChange"
      />
      <AiSettings 
        :visible="showSettings" 
        @close="showSettings = false" 
      />
    </div>
  </div>
</template>