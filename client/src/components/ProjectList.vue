<template>
  <div class="project-list-container">
    <div v-if="projects.length === 0" class="flex flex-col items-center justify-center h-64 text-gray-500">
      <div class="mb-4 text-4xl opacity-50">📂</div>
      <p>暂无项目</p>
    </div>

    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2 xl:grid-cols-3">
      <div
        v-for="p in projects"
        :key="p.path"
        class="relative flex flex-col transition bg-gray-800 border border-gray-700 rounded-lg shadow-xl group hover:border-blue-500/30"
      >
        <div class="flex items-center justify-between p-3 pl-4 bg-gray-800 border-b border-gray-700 rounded-t-lg">
          <div class="flex items-center gap-3 overflow-hidden">
            <div
              :class="[
                'w-2.5 h-2.5 rounded-full transition-all duration-300',
                hasRunningScripts(p) ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-gray-600'
              ]"
            ></div>

            <div class="flex flex-col overflow-hidden">
              <div class="flex items-center gap-2">
                <span class="font-mono text-base font-bold text-gray-200 truncate" :title="p.name">
                  {{ p.name }}
                </span>
                <span :class="['text-[10px] px-1.5 py-0.5 rounded border font-mono uppercase', getRunnerBadgeStyle(p.runner)]">
                  {{ p.runner }}
                </span>
                <span
                  v-if="nvmDetected"
                  :class="['text-[10px] px-1.5 py-0.5 rounded border font-mono', getNodeVersionBadgeStyle(p.nodeVersionSource)]"
                  :title="getNodeVersionTooltip(p)"
                >
                  {{ getNodeVersionLabel(p) }}
                </span>
              </div>
              
              <div class="flex items-center min-w-0 gap-1 text-gray-500">
                <span class="text-[10px] truncate hover:text-gray-300 transition">
                  {{ p.path.split(/[\\/]/).slice(-2).join('/') }}
                </span>
                <button
                  @click.stop="$emit('open-folder', p.path)"
                  title="在资源管理器中打开"
                  class="p-1 text-gray-500 transition rounded hover:bg-gray-700 hover:text-blue-400 shrink-0"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path><path d="M2 10h20"></path></svg>
                </button>
              </div>
            </div>

            <span v-if="isHidden(p.name)" class="text-[10px] bg-yellow-900/30 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-800/50">
              HIDDEN
            </span>
          </div>

          <button
            @click="$emit('toggle-hide', p)"
             :title="!isHidden(p.name) ? '隐藏' : '退出隐藏'"
            class="text-gray-500 hover:text-red-400 p-1.5 rounded transition hover:bg-gray-700"
          >
            <svg v-if="!isHidden(p.name)"xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="size-4">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
            </svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
          </button>
        </div>

        <div class="px-4 py-3 bg-[#111827] flex flex-wrap gap-2 items-center border-b border-gray-700/50 min-h-[50px]">
          <button
            v-for="(cmd, key) in p.scripts"
            :key="key"
            @click="$emit('run', p, key)"
            :disabled="p.runningScripts?.[key]"
            :class="[
              'px-3 py-1 text-xs font-bold rounded transition text-white shadow-sm border border-transparent',
              p.runningScripts?.[key]
                ? 'bg-green-600 cursor-default opacity-80'
                : 'bg-blue-600 hover:bg-blue-500 hover:border-blue-400'
            ]"
          >
            <span v-if="p.runningScripts?.[key]" class="flex items-center gap-1">
              <span class="animate-pulse">●</span> {{ key }}
            </span>
            <span v-else>{{ key }}</span>
          </button>

          <div class="flex-1"></div>

          <select
            v-if="nvmDetected && installedNodeVersions.length > 0"
            :value="p.nodeVersionOverride || (p.nodeVersionSource === 'auto' ? 'auto' : 'system')"
            @change="emit('node-version-change', p, $event.target.value)"
            class="px-2 py-1 text-[10px] font-mono bg-gray-800 border border-gray-600 rounded text-gray-300 focus:outline-none focus:border-blue-500 cursor-pointer max-w-[120px]"
            title="选择 Node 版本"
          >
            <option value="auto">
              {{ p.detectedNodeVersion ? `自动 (${p.detectedNodeVersion.raw})` : '自动检测' }}
            </option>
            <option value="system">系统默认</option>
            <option v-for="v in installedNodeVersions" :key="v" :value="v">
              v{{ v }}
            </option>
          </select>

          <button
            @click="handleAiCommit(p)"
            class="flex items-center gap-1 px-3 py-1 text-xs font-bold text-purple-300 transition border rounded bg-purple-900/30 hover:bg-purple-600 hover:text-white border-purple-800/50"
            title="AI 生成提交信息并提交"
          >
            <span>✨</span> Git
          </button>

          <button
            v-if="hasRunningScripts(p)"
            @click="$emit('stop', p)"
            title="强制杀死进程"
            class="flex items-center gap-1 px-3 py-1 text-xs font-bold text-red-400 transition border rounded bg-red-900/30 hover:bg-red-600 hover:text-white border-red-800/50"
          >
            <span>💀</span> KILL
          </button>
        </div>

        <div v-if="stats[p.path]" class="px-4 py-2 border-b bg-gray-900/80 border-gray-700/50">
          <div class="flex items-center mb-1 text-xs whitespace-nowrap">
            <span class="w-8 text-gray-400">CPU</span>
            <div class="flex-1 h-1.5 mx-2 bg-gray-700 rounded-full overflow-hidden">
              <div 
                class="h-full transition-all duration-300 bg-red-500" 
                :style="{ width: Math.min(stats[p.path].cpu, 100) + '%' }"
              ></div>
            </div>
            <span class="w-12 font-mono text-right text-red-400">{{ stats[p.path].cpu }}%</span>
          </div>
          <div class="flex items-center text-xs whitespace-nowrap">
            <span class="w-8 text-gray-400">MEM</span>
            <div class="flex-1 h-1.5 mx-2 bg-gray-700 rounded-full overflow-hidden">
              <div 
              class="h-full transition-all duration-300 bg-blue-500" 
              :style="{ width: calcMemPercent(stats[p.path].memory) + '%' }"
              ></div>
            </div>
            <span class="w-12 font-mono text-right text-blue-400 white-nowrap">{{ formatBytes(stats[p.path].memory) }}</span>
          </div>
        </div>

        <TerminalView :id="p.name" :logs="logs[p.name] || []" :project-path="p.path" @open-file="(uri) => $emit('open-file', uri)" />
      </div>
    </div>

    <div v-if="showGitModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div class="w-full max-w-lg p-6 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl">
        <h3 class="flex items-center gap-2 mb-4 text-lg font-bold text-purple-400">
          <span>✨</span> AI 智能提交
        </h3>
        
        <div v-if="isGenerating" class="flex flex-col items-center justify-center h-32 space-y-3">
          <div class="w-8 h-8 border-4 border-purple-500 rounded-full border-t-transparent animate-spin"></div>
          <p class="text-sm text-gray-400">正在分析代码变更...</p>
        </div>

        <div v-else>
          <textarea
            v-model="commitMessage"
            rows="4"
            class="w-full p-3 mb-4 font-mono text-sm text-gray-200 bg-gray-900 border border-gray-600 rounded focus:border-purple-500 focus:outline-none"
            placeholder="生成的提交信息将显示在这里..."
          ></textarea>
          
          <div class="flex items-center gap-2 mb-3 text-xs text-gray-500">
            <span>由</span>
            <span class="text-purple-400">{{ activeConfig.name || 'AI' }}</span>
            <span>·</span>
            <span class="font-mono text-gray-400">{{ activeConfig.model }}</span>
            <span>提供</span>
          </div>

          <div class="flex justify-end gap-3">
            <button @click="showGitModal = false" class="px-4 py-2 text-sm text-gray-400 hover:text-white">取消</button>
            <button 
              @click="confirmCommit" 
              class="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-purple-600 rounded hover:bg-purple-500"
              :disabled="isCommitting"
            >
              <span v-if="isCommitting" class="animate-spin">⏳</span>
              {{ isCommitting ? '提交中...' : '确认并提交' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import TerminalView from './TerminalView.vue'
import { callKuyepClaude } from '../utils/ai' // 引入通用的 AI 工具
import { socket } from "../utils/socket";
import { useAiConfig } from '../utils/useAiConfig';

const { activeConfig } = useAiConfig();

const props = defineProps({
  projects: { type: Array, default: () => [] },
  stats: { type: Object, default: () => ({}) }, // 监控数据
  logs: { type: Object, default: () => ({}) },  // 日志数据
  hiddenSet: { type: Set, default: () => new Set() },
  installedNodeVersions: { type: Array, default: () => [] },
  nvmDetected: { type: Boolean, default: false }
})

const emit = defineEmits(['run', 'stop', 'open-folder', 'open-file', 'toggle-hide', 'node-version-change'])

// Git 状态
const showGitModal = ref(false);
const isGenerating = ref(false);
const isCommitting = ref(false);
const commitMessage = ref('');
const currentGitProject = ref(null);

// 1. 点击 Git 按钮：获取 Diff -> 让 AI 写
const handleAiCommit = (p) => {
  currentGitProject.value = p;
  showGitModal.value = true;
  isGenerating.value = true;
  commitMessage.value = '';

  // 1. 请求后端获取 diff
  socket.emit('git:get-diff', { projectPath: p.path }, async ({ diff, error }) => {
    if (error) {
      $toast.warning('获取 Git 变更失败，请确认该项目是一个 Git 仓库');
      showGitModal.value = false;
      return;
    }
    
    if (!diff || diff.trim() === '') {
      commitMessage.value = 'chore: no changes detected';
      isGenerating.value = false;
      return;
    }

    // 2. 发送给 AI
    try {
      const systemPrompt = `你是一个资深代码提交助手。
      请根据用户的 git diff 内容，生成一条符合 Angular 规范的 Commit Message。
      格式要求：<type> <emoji>(<scope>): <subject>
      type 与 emoji 的对应关系：
      - feat ✨  - fix 🐛  - docs 📝  - style 💄
      - refactor ♻️  - perf ⚡️  - test ✅  - build 📦
      - ci 👷  - chore 🔧  - revert ⏪
      示例：feat ✨(auth): 新增登录页面
      规则：
      1. 只返回 Message 文本，不要包含 Markdown 代码块。
      2. 语言使用中文。
      3. 保持简练，subject 不超过 50 字。`;

      const result = await callKuyepClaude(diff, systemPrompt);
      commitMessage.value = result.replace(/`/g, '').trim(); // 清理一下可能的多余符号
    } catch (e) {
      commitMessage.value = `feat: update code\n\n(AI 生成失败: ${e.message})`;
    } finally {
      isGenerating.value = false;
    }
  });
};

// 2. 确认提交：发送给后端执行 git commit
const confirmCommit = () => {
  if (!commitMessage.value) return;
  isCommitting.value = true;
  
  socket.emit('git:commit', { 
    projectPath: currentGitProject.value.path, 
    message: commitMessage.value 
  }, ({ success, error }) => {
    isCommitting.value = false;
    if (success) {
      showGitModal.value = false;
      // 可以加个 toast 提示成功
      $toast.success('提交成功！');
    } else {
      $toast.error(`提交失败: ${error}`);
    }
  });
};

// 辅助函数
const hasRunningScripts = (p) => {
  return p.runningScripts && Object.values(p.runningScripts).some(Boolean)
}

const isHidden = (name) => {
  return props.hiddenSet.has(name)
}

const getRunnerBadgeStyle = (runner) => {
  switch (runner) {
    case 'pnpm': return 'bg-orange-500/20 text-orange-400 border-orange-500/50'
    case 'yarn': return 'bg-blue-500/20 text-blue-400 border-blue-500/50'
    case 'bun': return 'bg-pink-500/20 text-pink-400 border-pink-500/50'
    default: return 'bg-red-500/20 text-red-400 border-red-500/50'
  }
}

// 格式化内存
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

const calcMemPercent = (bytes) => {
  const limit = 500 * 1024 * 1024 // 500MB 基准
  return Math.min((bytes / limit) * 100, 100)
}

// Node 版本标签样式
const getNodeVersionBadgeStyle = (source) => {
  switch (source) {
    case 'auto': return 'bg-green-500/20 text-green-400 border-green-500/50'
    case 'manual': return 'bg-purple-500/20 text-purple-400 border-purple-500/50'
    default: return 'bg-gray-500/20 text-gray-400 border-gray-500/50'
  }
}

const getNodeVersionLabel = (p) => {
  if (p.effectiveNodeVersion) {
    return `v${p.effectiveNodeVersion}`
  }
  return 'system'
}

const getNodeVersionTooltip = (p) => {
  if (p.nodeVersionSource === 'manual') {
    return `手动指定: v${p.effectiveNodeVersion}`
  }
  if (p.nodeVersionSource === 'auto' && p.detectedNodeVersion) {
    return `自动检测: ${p.detectedNodeVersion.raw} (来源: ${p.detectedNodeVersion.source})`
  }
  return '使用系统默认 Node 版本'
}
</script>