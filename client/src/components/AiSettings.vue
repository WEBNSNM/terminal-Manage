<template>
  <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" @mousedown.self="$emit('close')" @keydown.esc="$emit('close')" tabindex="-1" ref="backdrop">
    <div class="w-full max-w-3xl bg-[#1e1e1e] border border-gray-700 rounded-lg shadow-2xl overflow-hidden flex flex-col h-[520px]">

      <div class="flex items-center justify-between p-4 border-b border-gray-700 bg-[#252526]">
        <h3 class="flex items-center gap-2 text-lg font-bold text-white">
          <span>⚙️</span> 全局设置
        </h3>
        <button @click="$emit('close')" class="px-2 text-gray-400 hover:text-white">✕</button>
      </div>

      <div class="flex flex-1 overflow-hidden">

        <!-- 左侧边栏 -->
        <div class="w-56 border-r border-gray-700 bg-[#18181b] flex flex-col">
          <div class="p-3 text-xs font-bold tracking-wider text-gray-500 uppercase">已保存的模型</div>

          <div class="flex-1 px-2 space-y-1 overflow-y-auto">
            <div
              v-for="config in configList"
              :key="config.id"
              @click="handleSelect(config)"
              class="flex items-center justify-between px-3 py-2.5 transition rounded cursor-pointer select-none"
              :class="currentView === 'model' && currentEditId === config.id ? 'bg-[#37373d] text-white' : 'text-gray-400 hover:bg-[#2a2a2d]'"
            >
              <div class="flex flex-col overflow-hidden">
                <span class="text-sm font-medium truncate">{{ config.name }}</span>
                <span class="text-[10px] text-gray-500 truncate">{{ config.model }}</span>
              </div>

              <div
                v-if="activeId === config.id"
                class="flex-shrink-0 w-2 h-2 ml-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.8)]"
                title="当前全局使用"
              ></div>
            </div>
          </div>

          <!-- 场景配置入口 -->
          <div class="px-2 py-2 border-t border-gray-700">
            <div
              @click="showSceneView"
              class="flex items-center gap-2 px-3 py-2.5 transition rounded cursor-pointer select-none"
              :class="currentView === 'scene' ? 'bg-purple-500/20 text-purple-300' : 'text-gray-400 hover:bg-[#2a2a2d]'"
            >
              <span class="text-sm">🎯</span>
              <span class="text-sm font-medium">场景配置</span>
            </div>
          </div>

          <div class="px-2 py-2 border-t border-gray-700">
            <div
              @click="showTunnelView"
              class="flex items-center gap-2 px-3 py-2.5 transition rounded cursor-pointer select-none"
              :class="currentView === 'tunnel' ? 'bg-cyan-500/20 text-cyan-300' : 'text-gray-400 hover:bg-[#2a2a2d]'"
            >
              <span class="text-sm">T</span>
              <span class="text-sm font-medium">Tunnel</span>
            </div>
          </div>

          <div class="px-2 py-2 border-t border-gray-700">
            <div
              @click="showAppView"
              class="flex items-center gap-2 px-3 py-2.5 transition rounded cursor-pointer select-none"
              :class="currentView === 'app' ? 'bg-blue-500/20 text-blue-300' : 'text-gray-400 hover:bg-[#2a2a2d]'"
            >
              <span class="text-sm">U</span>
              <span class="text-sm font-medium">应用更新</span>
            </div>
          </div>

          <div class="p-3 border-t border-gray-700">
            <button
              @click="handleCreateNew"
              class="flex items-center justify-center w-full gap-2 px-4 py-2 text-sm text-blue-400 transition border border-gray-600 border-dashed rounded hover:bg-blue-500/10 hover:border-blue-500"
            >
              <span>+</span> 添加新模型
            </button>
          </div>
        </div>

        <!-- 右侧面板 -->
        <div class="flex-1 bg-[#1e1e1e] flex flex-col">

          <!-- 模型编辑视图 -->
          <template v-if="currentView === 'model' && formData">
            <div class="flex-1 p-6 overflow-y-auto">
              <div class="flex items-center justify-between pb-2 mb-6 border-b border-gray-700">
                <h4 class="text-base font-bold text-white">
                  {{ isCreating ? '🆕 新增配置' : '✏️ 编辑配置' }}
                </h4>
                <button
                  v-if="!isCreating && activeId !== formData.id"
                  @click="setActive(formData.id)"
                  class="px-3 py-1 text-xs text-green-400 transition border border-green-800 rounded bg-green-900/30 hover:bg-green-800"
                >
                  设为全局默认
                </button>
                <span v-else-if="activeId === formData.id" class="px-2 py-1 text-xs font-bold text-green-500 border rounded border-green-500/30 bg-green-500/10">
                  ✅ 全局默认
                </span>
              </div>

              <div class="space-y-4">
                <div>
                  <label class="block mb-1 text-xs text-gray-500">显示名称 (别名)</label>
                  <input v-model="formData.name" type="text" placeholder="例如：DeepSeek V3" class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none transition">
                </div>

                <div>
                  <label class="block mb-1 text-xs text-gray-500">API 协议</label>
                  <select v-model="formData.provider" class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white focus:border-blue-500 focus:outline-none transition">
                    <option value="openai">OpenAI 兼容 (DeepSeek / GPT / Codex 等)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="gemini">Google Gemini</option>
                  </select>
                </div>

                <div>
                  <label class="block mb-1 text-xs text-gray-500">Base URL (API 地址)</label>
                  <input v-model="formData.baseURL" type="text" placeholder="https://api.deepseek.com" class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white font-mono focus:border-blue-500 focus:outline-none transition">
                </div>

                <div>
                  <label class="block mb-1 text-xs text-gray-500">API Key</label>
                  <input v-model="formData.apiKey" type="password" placeholder="API Key..." class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white font-mono focus:border-blue-500 focus:outline-none transition">
                </div>

                <div>
                  <label class="block mb-1 text-xs text-gray-500">Model (模型名)</label>
                  <input v-model="formData.model" type="text" placeholder="deepseek-chat" class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white font-mono focus:border-blue-500 focus:outline-none transition">
                  <p class="text-[10px] text-yellow-600 mt-1">⚠️ 模型名称以供应商实际提供的为准，可能与官方命名不同</p>
                  <p class="text-[10px] text-gray-500 mt-1">
                    常用:
                    <span class="text-gray-300 cursor-pointer hover:text-blue-400" @click="formData.model='deepseek-chat'">deepseek-chat</span>,
                    <span class="text-gray-300 cursor-pointer hover:text-blue-400" @click="formData.model='gpt-4o'">gpt-4o</span>,
                    <span class="text-gray-300 cursor-pointer hover:text-blue-400" @click="formData.model='claude-sonnet-4-20250514'">claude-sonnet-4</span>
                  </p>
                </div>
              </div>
            </div>

            <div class="p-4 border-t border-gray-700 bg-[#252526] flex justify-between items-center">
              <button
                v-if="!isCreating"
                @click="handleDelete"
                class="text-xs text-red-400 underline hover:text-red-300"
              >
                删除配置
              </button>
              <div v-else></div>
              <div class="flex gap-3">
                <button
                  @click="formData = null; currentEditId = null"
                  class="px-4 py-2 text-xs text-gray-300 transition hover:text-white"
                >
                  取消
                </button>
                <button
                  @click="save"
                  class="px-5 py-2 text-xs font-bold text-white transition bg-blue-600 rounded shadow-lg hover:bg-blue-500 shadow-blue-900/50"
                >
                  保存配置
                </button>
              </div>
            </div>
          </template>

          <!-- 场景配置视图 -->
          <template v-else-if="currentView === 'scene'">
            <div class="flex-1 p-6 overflow-y-auto">
              <div class="pb-2 mb-5 border-b border-gray-700">
                <h4 class="text-base font-bold text-white">🎯 场景配置</h4>
                <p class="mt-1 text-xs text-gray-500">为不同使用场景指定独立的 AI 模型，未指定时跟随全局默认</p>
              </div>

              <div class="space-y-4">
                <!-- Git 提交 -->
                <div class="p-4 border border-gray-700 rounded-lg bg-[#252526] transition hover:border-gray-600">
                  <div class="flex items-start gap-3">
                    <div class="flex items-center justify-center flex-shrink-0 text-lg text-orange-400 rounded-lg w-9 h-9 bg-orange-500/15">
                      G
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between mb-1">
                        <span class="text-sm font-medium text-white">Git 提交消息</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-400/80">git commit</span>
                      </div>
                      <p class="mb-3 text-xs text-gray-500">根据 diff 自动生成 commit message</p>
                      <select
                        v-model="sceneConfigs.git"
                        class="w-full bg-[#1e1e1e] border border-gray-600 rounded px-3 py-2 text-sm text-white focus:border-orange-500/50 focus:outline-none transition"
                      >
                        <option value="">跟随全局默认 ({{ globalModelName }})</option>
                        <option v-for="c in configList" :key="c.id" :value="c.id">{{ c.name }} — {{ c.model }}</option>
                      </select>
                    </div>
                  </div>
                </div>

                <!-- 报错诊断 -->
                <div class="p-4 border border-gray-700 rounded-lg bg-[#252526] transition hover:border-gray-600">
                  <div class="flex items-start gap-3">
                    <div class="flex items-center justify-center flex-shrink-0 text-lg text-red-400 rounded-lg w-9 h-9 bg-red-500/15">
                      D
                    </div>
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center justify-between mb-1">
                        <span class="text-sm font-medium text-white">提问及诊断</span>
                        <span class="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400/80">diagnosis</span>
                      </div>
                      <p class="mb-3 text-xs text-gray-500">分析终端日志、定位错误原因并给出修复建议</p>
                      <select
                        v-model="sceneConfigs.diagnosis"
                        class="w-full bg-[#1e1e1e] border border-gray-600 rounded px-3 py-2 text-sm text-white focus:border-red-500/50 focus:outline-none transition"
                      >
                        <option value="">跟随全局默认 ({{ globalModelName }})</option>
                        <option v-for="c in configList" :key="c.id" :value="c.id">{{ c.name }} — {{ c.model }}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- 空状态 -->
          <template v-else-if="currentView === 'tunnel'">
            <div class="flex-1 p-6 overflow-y-auto">
              <div class="pb-2 mb-5 border-b border-gray-700">
                <h4 class="text-base font-bold text-white">Tunnel Config</h4>
                <p class="mt-1 text-xs text-gray-500">Configure cloudflared token and tunnel runtime.</p>
              </div>

              <div class="space-y-4">
                <div>
                  <label class="block mb-1 text-xs text-gray-500">cloudflared Token</label>
                  <input
                    v-model="tunnelConfig.token"
                    type="password"
                    class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white font-mono focus:border-cyan-500 focus:outline-none transition"
                    placeholder="Paste cloudflared tunnel run token"
                  >
                </div>

                <div>
                  <label class="block mb-1 text-xs text-gray-500">Public Domain</label>
                  <input
                    v-model="tunnelConfig.publicDomain"
                    type="text"
                    class="w-full bg-[#252526] border border-gray-600 rounded px-3 py-2 text-sm text-white font-mono focus:border-cyan-500 focus:outline-none transition"
                    placeholder="e.g. http://kuyep.indevs.in"
                  >
                </div>

                <label class="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                  <input
                    type="checkbox"
                    v-model="tunnelConfig.autoSwitchOnRun"
                    class="w-4 h-4 bg-gray-700 border-gray-600 rounded text-cyan-500 focus:ring-0"
                  >
                  运行项目脚本自动切换隧道映射
                </label>

                <div class="p-3 border border-gray-700 rounded bg-[#252526] text-xs text-gray-300 space-y-2">
                  <div class="flex items-center justify-between">
                    <span>Gateway</span>
                    <span class="font-mono">127.0.0.1:{{ tunnelState.gatewayPort || 26324 }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span>Gateway Status</span>
                    <span :class="tunnelState.gatewayRunning ? 'text-green-400' : 'text-yellow-400'">
                      {{ tunnelState.gatewayRunning ? 'RUNNING' : 'STOPPED' }}
                    </span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span>Cloudflared</span>
                    <span :class="tunnelState.cloudflaredRunning ? 'text-green-400' : 'text-gray-400'">
                      {{ tunnelState.cloudflaredRunning ? 'RUNNING' : 'STOPPED' }}
                    </span>
                  </div>
                  <div v-if="tunnelState.activeTarget?.projectName" class="pt-2 border-t border-gray-700">
                    Active: {{ tunnelState.activeTarget.projectName }} :{{ tunnelState.activeTarget.port }}
                  </div>
                  <div v-if="tunnelState.gatewayError" class="text-red-400">
                    {{ tunnelState.gatewayError }}
                  </div>
                </div>

                <div class="flex gap-3">
                  <button
                    @click="handleTunnelStart"
                    :disabled="tunnelState.cloudflaredRunning"
                    class="px-4 py-2 text-xs font-bold text-white rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50"
                  >
                    Start cloudflared
                  </button>
                  <button
                    @click="handleTunnelStop"
                    :disabled="!tunnelState.cloudflaredRunning"
                    class="px-4 py-2 text-xs font-bold text-white bg-gray-600 rounded hover:bg-gray-500 disabled:opacity-50"
                  >
                    Stop cloudflared
                  </button>
                </div>
              </div>
            </div>
          </template>

          <template v-else-if="currentView === 'app'">
            <div class="flex-1 p-6 overflow-y-auto">
              <div class="pb-2 mb-5 border-b border-gray-700">
                <h4 class="text-base font-bold text-white">应用更新</h4>
                <p class="mt-1 text-xs text-gray-500">自动下载更新包，下载完成后可重启安装。</p>
              </div>

              <div class="space-y-4">
                <div class="p-4 border border-gray-700 rounded bg-[#252526] space-y-2 text-sm">
                  <div class="flex items-center justify-between">
                    <span class="text-gray-400">应用名称</span>
                    <span class="font-medium text-white">{{ appUpdate.appName || '-' }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-gray-400">当前版本</span>
                    <span class="font-mono text-cyan-300">v{{ appUpdate.currentVersion || '-' }}</span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-gray-400">最新版本</span>
                    <span class="font-mono text-white">
                      {{ appUpdate.latestVersion ? `v${appUpdate.latestVersion}` : '-' }}
                    </span>
                  </div>
                  <div class="flex items-center justify-between">
                    <span class="text-gray-400">状态</span>
                    <span
                      :class="appUpdate.downloaded ? 'text-green-400' : appUpdate.error ? 'text-red-400' : appUpdate.hasUpdate ? 'text-orange-400' : 'text-gray-300'"
                    >
                      {{ appUpdate.message || '尚未检查' }}
                    </span>
                  </div>
                  <div v-if="appUpdate.hasUpdate" class="pt-2 border-t border-gray-700">
                    <div class="flex items-center justify-between text-xs text-gray-400 mb-1">
                      <span>下载进度</span>
                      <span>{{ Number(appUpdate.progress || 0).toFixed(0) }}%</span>
                    </div>
                    <div class="h-2 bg-gray-700 rounded overflow-hidden">
                      <div
                        class="h-full bg-blue-500 transition-all"
                        :style="{ width: `${Math.min(100, Math.max(0, Number(appUpdate.progress || 0)))}%` }"
                      ></div>
                    </div>
                  </div>
                  <div v-if="appUpdate.lastCheckedAt" class="text-xs text-gray-500">
                    最后检查时间：{{ appUpdate.lastCheckedAt }}
                  </div>
                </div>

                <div class="flex gap-3">
                  <button
                    @click="checkAppUpdate"
                    :disabled="appUpdate.checking || !appUpdate.enabled"
                    class="px-4 py-2 text-xs font-bold text-white rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
                  >
                    {{ appUpdate.checking ? '检查中...' : '检查并下载更新' }}
                  </button>

                  <button
                    @click="installUpdateNow"
                    :disabled="!appUpdate.downloaded"
                    class="px-4 py-2 text-xs font-bold text-white rounded bg-green-600 hover:bg-green-500 disabled:opacity-50"
                  >
                    立即重启并安装
                  </button>
                </div>

                <div v-if="appUpdate.error" class="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-3">
                  {{ appUpdate.error }}
                </div>
                <div v-else-if="!appUpdate.enabled" class="text-xs text-yellow-300 bg-yellow-500/10 border border-yellow-500/20 rounded p-3">
                  {{ appUpdate.message || '当前环境不支持自动更新（仅打包后的桌面应用可用）' }}
                </div>
              </div>
            </div>
          </template>

          <div v-else class="flex flex-col items-center justify-center h-full text-gray-600">
            <div class="mb-2 text-4xl grayscale opacity-30">⚙️</div>
            <p class="text-sm">请在左侧选择模型，或点击添加</p>
          </div>

        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { useAiConfig } from '../utils/useAiConfig';
import { socket } from '../utils/socket';

const props = defineProps({ visible: Boolean });
const emit = defineEmits(['close']);

const backdrop = ref(null);

const { configList, activeId, sceneConfigs, activeConfig, tunnelConfig, addConfig, updateConfig, removeConfig } = useAiConfig();

const currentView = ref('model'); // 'model' | 'scene' | 'tunnel' | 'app'
const currentEditId = ref(null);
const formData = ref(null);
const isCreating = ref(false);
const appUpdate = ref({
  appName: 'terminalManage',
  currentVersion: '',
  supported: false,
  enabled: false,
  checking: false,
  hasUpdate: false,
  downloaded: false,
  progress: 0,
  status: 'idle',
  latestVersion: '',
  message: '',
  error: '',
  lastCheckedAt: ''
});
const tunnelState = ref({
  gatewayPort: 26324,
  gatewayRunning: false,
  gatewayError: '',
  activeTarget: null,
  cloudflaredRunning: false
});

// 全局默认模型名称（用于场景配置的下拉提示）
const globalModelName = computed(() => activeConfig.value?.name || '未配置');

// 点击左侧模型列表项
const handleSelect = (config) => {
  currentView.value = 'model';
  isCreating.value = false;
  currentEditId.value = config.id;
  formData.value = { ...config };
};

// 切换到场景配置视图
const showSceneView = () => {
  currentView.value = 'scene';
  currentEditId.value = null;
  formData.value = null;
  isCreating.value = false;
};

const showTunnelView = () => {
  currentView.value = 'tunnel';
  currentEditId.value = null;
  formData.value = null;
  isCreating.value = false;
  socket.emit('tunnel:get-state', (state) => {
    if (state) tunnelState.value = state;
  });
};

const showAppView = () => {
  currentView.value = 'app';
  currentEditId.value = null;
  formData.value = null;
  isCreating.value = false;
  socket.emit('app:update:get-state', applyAppUpdateState);
};

// 点击新增按钮
const handleCreateNew = () => {
  currentView.value = 'model';
  isCreating.value = true;
  currentEditId.value = 'NEW_TEMP_ID';
  formData.value = {
    name: 'New Model',
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-3.5-turbo'
  };
};

// 设为激活
const setActive = (id) => {
  activeId.value = id;
};

// 保存逻辑
const save = () => {
  if (!formData.value.name) return $toast.warning('名称不能为空');
  if (!formData.value.baseURL) return $toast.warning('Base URL 不能为空');
  if (!formData.value.apiKey) return $toast.warning('API Key 不能为空');

  if (isCreating.value) {
    addConfig(formData.value);
    const last = configList.value[configList.value.length - 1];
    handleSelect(last);
  } else {
    updateConfig(formData.value.id, formData.value);
    const updated = configList.value.find(c => c.id === formData.value.id);
    handleSelect(updated);
  }

  $toast.success('保存成功')
};

const handleDelete = async () => {
  const ok = await window.$confirm('确定要删除吗？', '警告', {
    type: 'error',
    confirmText: '狠狠地删'
  });
  if (ok) {
    removeConfig(formData.value.id);
    formData.value = null;
    currentEditId.value = null;
  }
};

// 每次打开弹窗，默认选中当前正在使用的那个
const handleTunnelStart = () => {
  const token = tunnelConfig.value?.token?.trim();
  if (!token) {
    $toast.warning('Please enter cloudflared token first');
    return;
  }
  socket.emit('tunnel:start', { token }, ({ success, error }) => {
    if (success) $toast.success('cloudflared started');
    else $toast.error(error || 'Failed to start cloudflared');
  });
};

const handleTunnelStop = () => {
  socket.emit('tunnel:stop', ({ success, error }) => {
    if (success) $toast.success('cloudflared stop signal sent');
    else $toast.warning(error || 'cloudflared is not running');
  });
};

const handleTunnelState = (state) => {
  if (state) tunnelState.value = state;
};

const applyAppUpdateState = (payload) => {
  if (!payload) return;
  appUpdate.value = {
    ...appUpdate.value,
    ...payload
  };
};

const checkAppUpdate = () => {
  if (appUpdate.value.checking || !appUpdate.value.enabled) return;
  appUpdate.value.checking = true;
  appUpdate.value.error = '';
  appUpdate.value.lastCheckedAt = new Date().toLocaleString();

  socket.emit('app:update:check', (result) => {
    if (!result?.success) {
      appUpdate.value.checking = false;
      appUpdate.value.error = result?.error || '检查更新失败';
      $toast.warning(appUpdate.value.error);
      return;
    }
    if (result?.state) applyAppUpdateState(result.state);
  });
};

const installUpdateNow = () => {
  if (!appUpdate.value.downloaded) {
    $toast.warning('更新包尚未下载完成');
    return;
  }
  socket.emit('app:update:quit-install', ({ success, error }) => {
    if (!success) {
      $toast.error(error || '安装失败');
      return;
    }
    $toast.success('正在重启并安装更新...');
  });
};

onMounted(() => {
  socket.on('tunnel:state', handleTunnelState);
  socket.on('app:update:state', applyAppUpdateState);
  socket.emit('tunnel:get-state', handleTunnelState);
  socket.emit('app:update:get-state', applyAppUpdateState);
});

onUnmounted(() => {
  socket.off('tunnel:state', handleTunnelState);
  socket.off('app:update:state', applyAppUpdateState);
});

watch(() => props.visible, (val) => {
  if (val) {
    document.body.style.overflow = 'hidden';
    nextTick(() => backdrop.value?.focus());
    currentView.value = 'model';
    const active = configList.value.find(c => c.id === activeId.value);
    if (active) {
      handleSelect(active);
    } else if (configList.value.length > 0) {
      handleSelect(configList.value[0]);
    } else {
      handleCreateNew();
    }
    socket.emit('tunnel:get-state', handleTunnelState);
    socket.emit('app:update:get-state', applyAppUpdateState);
  } else {
    document.body.style.overflow = '';
  }
});
</script>
