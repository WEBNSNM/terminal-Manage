import { ref, computed, watch } from 'vue';
import { socket } from './socket'; // 👈 引入刚才创建的 socket 单例

// 定义存储在 JSON 文件里的 Key 名称
const STORAGE_KEY_LIST = 'ai_config_list';
const STORAGE_KEY_ACTIVE = 'ai_active_id';
const STORAGE_KEY_SCENES = 'ai_scene_configs';
const STORAGE_KEY_TUNNEL = 'ai_tunnel_config';

const DEFAULT_CONFIG: any = {
  id: 'default',
  name: 'DeepSeek (默认)',
  provider: 'openai',
  baseURL: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
};

// 响应式状态
const configList = ref([DEFAULT_CONFIG]);
const activeId = ref('default');
const sceneConfigs = ref<Record<string, string>>({ git: '', diagnosis: '' });
const tunnelConfig = ref({
  token: '',
  publicDomain: '',
  autoSwitchOnRun: false,
  projectPorts: {},
  activeProjectPath: ''
});
const isLoaded = ref(false); // 标记是否加载完成

// 🔄 初始化：从后端加载数据
const init = () => {
  // 1. 加载列表
  socket.emit('config:load', STORAGE_KEY_LIST, (data: any) => {
    if (data && Array.isArray(data) && data.length > 0) {
      configList.value = data;
    } else {
      // 如果后端没数据，保持默认
      configList.value = [DEFAULT_CONFIG];
    }
    isLoaded.value = true;
  });

  // 2. 加载选中的 ID
  socket.emit('config:load', STORAGE_KEY_ACTIVE, (id: any) => {
    if (id) activeId.value = id;
  });

  // 3. 加载场景配置
  socket.emit('config:load', STORAGE_KEY_SCENES, (data: any) => {
    if (data && typeof data === 'object') {
      sceneConfigs.value = { git: '', diagnosis: '', ...data };
    }
  });

  socket.emit('config:load', STORAGE_KEY_TUNNEL, (data: any) => {
    if (data && typeof data === 'object') {
      tunnelConfig.value = {
        token: typeof data.token === 'string' ? data.token : '',
        publicDomain: typeof data.publicDomain === 'string' ? data.publicDomain : '',
        autoSwitchOnRun: data.autoSwitchOnRun !== false,
        projectPorts: data.projectPorts && typeof data.projectPorts === 'object' ? data.projectPorts : {},
        activeProjectPath: typeof data.activeProjectPath === 'string' ? data.activeProjectPath : ''
      };
    }
  });
};

// 立即启动加载
init();

// 💾 监听变化 -> 发送给后端保存
watch(configList, (newVal) => {
  // 只有当加载完成后才允许保存（防止空数据覆盖了服务器数据）
  if (isLoaded.value) {
    socket.emit('config:save', { key: STORAGE_KEY_LIST, value: newVal });
  }
}, { deep: true });

watch(activeId, (newVal) => {
  if (isLoaded.value) {
    socket.emit('config:save', { key: STORAGE_KEY_ACTIVE, value: newVal });
  }
});

watch(sceneConfigs, (newVal) => {
  if (isLoaded.value) {
    socket.emit('config:save', { key: STORAGE_KEY_SCENES, value: newVal });
  }
}, { deep: true });

watch(tunnelConfig, (newVal) => {
  if (isLoaded.value) {
    socket.emit('config:save', { key: STORAGE_KEY_TUNNEL, value: newVal });
  }
}, { deep: true });

export function useAiConfig() {
  const activeConfig = computed(() => {
    return configList.value.find(c => c.id === activeId.value) || configList.value[0];
  });

  const addConfig = (config: any) => {
    const newConfig = { ...config, id: Date.now().toString() };
    configList.value.push(newConfig);
    activeId.value = newConfig.id;
  };

  const updateConfig = (id: any, newFields: any) => {
    const index = configList.value.findIndex(c => c.id === id);
    if (index !== -1) {
      configList.value[index] = { ...configList.value[index], ...newFields };
    }
  };

  const removeConfig = (id: any) => {
    configList.value = configList.value.filter(c => c.id !== id);
    if (activeId.value === id && configList.value.length > 0) {
      activeId.value = configList.value[0].id;
    }
  };

  // 根据场景获取对应的配置对象（无场景配置时回退到全局）
  const getSceneConfig = (scene: string) => {
    const sceneId = sceneConfigs.value[scene];
    if (sceneId) {
      return configList.value.find(c => c.id === sceneId) || activeConfig.value;
    }
    return activeConfig.value;
  };

  return {
    configList,
    activeId,
    activeConfig,
    sceneConfigs,
    tunnelConfig,
    getSceneConfig,
    addConfig,
    removeConfig,
    updateConfig
  };
}
