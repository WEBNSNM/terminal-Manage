<script setup>
import { onMounted, ref, watch, nextTick, computed, onBeforeUnmount } from 'vue';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import 'xterm/css/xterm.css';
import { callKuyepClaude } from '../utils/ai';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';
import { useAiConfig } from '../utils/useAiConfig';
import { socket } from '../utils/socket';

const { activeConfig, getSceneConfig } = useAiConfig();
const diagModelConfig = computed(() => getSceneConfig('diagnosis'));

const props = defineProps({
  id: String,
  logs: { type: Array, default: () => [] },
  projectPath: { type: String, default: '' }
});

const emit = defineEmits(['open-file']);

const terminalContainer = ref(null);
const copySuccess = ref(false);
const copyError = ref(false);

// --- AI 诊断状态 ---
const isAnalyzing = ref(false);
const showAiModal = ref(false);
const aiResult = ref('');
const userQuestion = ref('');

// --- 执行修复状态 ---
const isFixing = ref(false);
const isFullscreen = ref(false);
const fixSteps = ref([]);  // { type:'file'|'cmd', label, path?, search?, replace?, command?, status, output }

// 全屏时禁止外层滚动
watch(isFullscreen, (val) => {
  document.body.style.overflow = val ? 'hidden' : '';
});

const md = new MarkdownIt({
  highlight: function (str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(str, { language: lang }).value; } catch (__) {}
    }
    return '';
  }
});
const renderedMarkdown = computed(() => md.render(aiResult.value));

// 🟢 智能状态检测
const hasError = ref(false);
let checkTimer = null;

const checkErrorLogic = () => {
  const logsAfterClear = props.logs.slice(logsClearOffset);
  if (logsAfterClear.length === 0) { hasError.value = false; return; }
  const recentLogs = logsAfterClear.slice(-100);
  let errorIdx = -1, successIdx = -1;
  recentLogs.forEach((line, i) => {
    if (/error|fail|exception|fatal/i.test(line) && !/node_modules|npm update/i.test(line)) errorIdx = i;
    if (/ready in|built in|running|compiled successfully|webpack compiled/i.test(line) && !/error|fail/i.test(line)) successIdx = i;
  });
  hasError.value = errorIdx > -1 && errorIdx > successIdx;
};

watch(() => props.logs.length, () => {
  if (checkTimer) return;
  checkTimer = setTimeout(() => { checkErrorLogic(); checkTimer = null; }, 500);
}, { immediate: true });

// --- xterm ---
let term = null;
let fitAddon = null;
let writeIndex = 0;
let logsClearOffset = 0; // 清屏后的日志偏移量，AI 诊断只读取此偏移之后的日志
const hasSelection = ref(false);
const lastSelectionText = ref('');
let copyStateTimer = null;

const markCopySuccess = () => {
  copyError.value = false;
  copySuccess.value = true;
  if (copyStateTimer) clearTimeout(copyStateTimer);
  copyStateTimer = setTimeout(() => {
    copySuccess.value = false;
    copyError.value = false;
    copyStateTimer = null;
  }, 2000);
};

const markCopyError = () => {
  copySuccess.value = false;
  copyError.value = true;
  if (copyStateTimer) clearTimeout(copyStateTimer);
  copyStateTimer = setTimeout(() => {
    copySuccess.value = false;
    copyError.value = false;
    copyStateTimer = null;
  }, 2000);
};

const writeTextToClipboard = async (text) => {
  if (!text) return false;

  // 优先使用异步 Clipboard API
  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // 忽略，继续降级到 execCommand
    }
  }

  // Electron/部分浏览器环境降级方案
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch (_) {
    return false;
  }
};

const copyLogs = async () => {
  try {
    const currentSelection = term?.getSelection() || '';
    const selection = hasSelection.value ? (currentSelection || lastSelectionText.value) : '';
    const text = selection || props.logs.join('\n');
    if (!text) return;
    const copied = await writeTextToClipboard(text);
    if (!copied) {
      markCopyError();
      return;
    }
    markCopySuccess();
  } catch (err) {
    console.error('复制失败', err);
    markCopyError();
  }
};

const clearLogs = () => {
  term?.clear();
  writeIndex = props.logs.length;
  logsClearOffset = props.logs.length;
  lastSelectionText.value = '';
  hasSelection.value = false;
  hasError.value = false;
  // 重置 AI 诊断状态，确保清屏后重新诊断不会使用旧数据
  aiResult.value = '';
  fixSteps.value = [];
  showAiModal.value = false;
  isFullscreen.value = false;
};

const extractSmartLogs = (logs) => {
  const lines = logs.map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';

  const errorPattern = /error|fail|exception|fatal|ENOENT|EACCES|TypeError|SyntaxError|ReferenceError|Cannot find|not found|rejected|EPERM/i;
  const noisePattern = /node_modules|npm warn|npm notice|npm update|progress|downloading|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|\[=+\s*\]/i;
  const successPattern = /ready in|built in|running|compiled successfully|webpack compiled|started server|listening on/i;

  // 找到最后一条成功标记和最后一条报错标记的位置
  let lastErrorIdx = -1, lastSuccessIdx = -1;
  lines.forEach((line, i) => {
    if (errorPattern.test(line) && !noisePattern.test(line)) lastErrorIdx = i;
    if (successPattern.test(line) && !(/error|fail/i.test(line))) lastSuccessIdx = i;
  });

  // 项目已恢复稳定：最后的 success 在最后的 error 之后
  // 只提取 success 之后的日志，不再挖掘旧报错
  if (lastSuccessIdx > -1 && lastSuccessIdx > lastErrorIdx) {
    return lines.slice(lastSuccessIdx).slice(-30).join('\n');
  }

  // 存在未恢复的报错：提取报错上下文
  if (lastErrorIdx > -1) {
    const errorIndices = [];
    lines.forEach((line, i) => { if (errorPattern.test(line) && !noisePattern.test(line)) errorIndices.push(i); });
    const picked = new Set();
    errorIndices.forEach(idx => { for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 3); i++) picked.add(i); });
    return [...picked].sort((a, b) => a - b).map(i => lines[i]).slice(-60).join('\n');
  }

  // 无报错也无成功标记：返回最近日志
  return lines.slice(-20).join('\n');
};

// --- 🤖 AI 诊断 ---

// 仅打开弹窗，不立即执行诊断
const openAiModal = () => {
  showAiModal.value = true;
};

const handleAnalyze = async () => {
  const question = userQuestion.value.trim();
  const recentLogs = extractSmartLogs(props.logs.slice(logsClearOffset));
  if (!recentLogs && !question) return;

  isAnalyzing.value = true;
  aiResult.value = '';
  fixSteps.value = [];
  showAiModal.value = true;

  try {
    const projectInfo = props.projectPath ? `项目路径: ${props.projectPath}` : '';
    let systemPrompt, userMessage;

    if (question) {
      systemPrompt = `你是一位世界顶级全栈首席架构师，精通所有主流技术栈。
${projectInfo}
用户正在开发一个项目，会向你提问或请求帮助。
请你：
1. 如果用户提供了控制台日志，结合日志上下文回答。
2. 如果涉及代码修改，给出具体的代码片段和文件路径建议。
3. 使用 Markdown 格式回复，语言使用中文。`;
      userMessage = question + (recentLogs ? `\n\n当前控制台日志:\n${recentLogs}` : '');
    } else {
      systemPrompt = `你是一位世界顶级全栈首席架构师，精通所有主流技术栈。
${projectInfo}
用户将提供一段控制台运行日志。
请你：
1. 优先检查日志中是否存在错误（error/fail/exception 等），如果有，分析错误原因并给出修复建议。
2. 如果没有明显错误，简要总结当前运行状态。
3. 如果涉及代码修改，给出具体的代码片段和文件路径建议。
4. 使用 Markdown 格式回复，语言使用中文。`;
      userMessage = recentLogs;
    }

    const diagConfig = getSceneConfig('diagnosis');
    const result = await callKuyepClaude(userMessage, systemPrompt, diagConfig?.id);
    aiResult.value = result;
    userQuestion.value = '';
  } catch (error) {
    aiResult.value = `### ❌ 分析失败\n\n${error.message}\n\n请检查 API Key 配置（点击右上角配置）。`;
  } finally {
    isAnalyzing.value = false;
  }
};

// --- 🔧 执行修复 ---

// 从日志和诊断结果中提取文件路径
const extractFilePaths = (text) => {
  const paths = new Set();
  // 匹配常见路径：src/xxx.ts, ./xxx/yyy.vue, path\to\file.js 等（排除 http 和 node_modules）
  const regex = /(?:(?:\.\/|src\/|client\/|server\/)[^\s:,'"*?<>|()]+\.\w{1,5})/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    let p = m[0].replace(/[;,'")\]]+$/, ''); // 清理尾部标点
    paths.add(p);
  }
  return [...paths].slice(0, 8); // 最多 8 个文件，避免过量
};

// 读取文件内容
const readFile = (filePath) => {
  return new Promise((resolve) => {
    socket.emit('file:read', { filePath }, (res) => {
      resolve(res.success ? res.content : null);
    });
  });
};

// 写入文件
const writeFile = (filePath, content) => {
  return new Promise((resolve) => {
    socket.emit('file:write', { filePath, content }, resolve);
  });
};

// 执行命令
const runCommand = (command, cwd) => {
  return new Promise((resolve) => {
    socket.emit('exec:run', { command, cwd }, resolve);
  });
};

// 模糊匹配：忽略空白差异找到文件中对应的原始片段
const fuzzyFindInContent = (content, search) => {
  // 先试精确匹配
  if (content.includes(search)) return { found: true, match: search };

  // 标准化后匹配：统一换行符 + 去除每行首尾空白
  const normalize = (s) => s.replace(/\r\n/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).join('\n');
  const normalizedSearch = normalize(search);
  const contentLines = content.replace(/\r\n/g, '\n').split('\n');

  // 滑动窗口：在文件中找一段行数相近、标准化后匹配的片段
  const searchLineCount = normalizedSearch.split('\n').length;
  for (let start = 0; start <= contentLines.length - searchLineCount; start++) {
    // 允许窗口大小有 ±2 行的弹性
    for (let winSize = searchLineCount - 1; winSize <= searchLineCount + 2 && start + winSize <= contentLines.length; winSize++) {
      if (winSize < 1) continue;
      const window = contentLines.slice(start, start + winSize);
      const normalizedWindow = window.map(l => l.trim()).filter(Boolean).join('\n');
      if (normalizedWindow === normalizedSearch) {
        // 找到了，返回文件中的原始文本（保留原始缩进）
        return { found: true, match: contentLines.slice(start, start + winSize).join('\n') };
      }
    }
  }

  return { found: false, match: null };
};

// 解析 AI 返回的修复指令
const parseFixActions = (text) => {
  const actions = [];

  // 解析文件修改: <fix-file path="..."> <search>...</search> <replace>...</replace> </fix-file>
  const fileRegex = /<fix-file\s+path="([^"]+)">\s*<search>([\s\S]*?)<\/search>\s*<replace>([\s\S]*?)<\/replace>\s*<\/fix-file>/g;
  let m;
  while ((m = fileRegex.exec(text)) !== null) {
    actions.push({
      type: 'file',
      label: `修改 ${m[1]}`,
      path: m[1],
      search: m[2].trim(),
      replace: m[3].trim(),
      status: 'pending',
      output: ''
    });
  }

  // 解析命令: <fix-cmd>...</fix-cmd>
  const cmdRegex = /<fix-cmd>([\s\S]*?)<\/fix-cmd>/g;
  while ((m = cmdRegex.exec(text)) !== null) {
    const cmd = m[1].trim();
    if (cmd) {
      actions.push({
        type: 'cmd',
        label: cmd.length > 50 ? cmd.slice(0, 50) + '...' : cmd,
        command: cmd,
        status: 'pending',
        output: ''
      });
    }
  }

  return actions;
};

const handleFix = async () => {
  if (!props.projectPath || !aiResult.value) return;
  isFixing.value = true;
  fixSteps.value = [];

  try {
    // 1. 从诊断结果和日志中提取相关文件路径
    const allText = aiResult.value + '\n' + props.logs.slice(logsClearOffset).join('\n');
    const relativePaths = extractFilePaths(allText);

    // 2. 读取这些文件的内容
    const fileContents = [];
    for (const rp of relativePaths) {
      // 尝试拼接项目路径
      const fullPath = props.projectPath.replace(/\\/g, '/') + '/' + rp.replace(/^\.\//, '');
      const content = await readFile(fullPath);
      if (content !== null) {
        fileContents.push({ path: rp, content });
      }
    }

    // 3. 构建修复 prompt
    const filesSection = fileContents.length > 0
      ? fileContents.map(f => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')
      : '（未读取到相关文件）';

    const systemPrompt = `你是一位世界顶级全栈首席架构师兼故障修复专家。
项目路径: ${props.projectPath}

你的任务：根据诊断报告和源文件内容，输出精确的修复操作。

输出格式要求（严格遵守）：
1. 先简要说明修复思路（1-2 句话）
2. 然后输出具体的修复操作，使用以下标签格式：

修改文件：
<fix-file path="相对路径，如 src/App.vue">
<search>
要替换的原始代码（必须与文件中完全一致）
</search>
<replace>
替换后的新代码
</replace>
</fix-file>

执行命令：
<fix-cmd>npm install some-package</fix-cmd>

规则：
- search 中的内容必须与源文件中的原文完全匹配（包括空格和缩进）
- 每个 fix-file 只做一处修改，多处修改用多个 fix-file
- path 使用相对于项目根目录的路径
- 优先修改文件，只在需要安装依赖/清缓存等场景才用 fix-cmd
- 不要输出无关的解释，保持精简`;

    const userMessage = `## 诊断报告\n${aiResult.value}\n\n## 相关源文件\n${filesSection}`;

    const diagConfig = getSceneConfig('diagnosis');
    const result = await callKuyepClaude(userMessage, systemPrompt, diagConfig?.id);

    // 4. 解析修复操作
    const actions = parseFixActions(result);
    if (actions.length === 0) {
      fixSteps.value = [{ type: 'info', label: 'AI 未输出可执行的修复操作，请参考诊断报告手动修复', status: 'info', output: result }];
      return;
    }

    fixSteps.value = actions;

    // 5. 逐步执行
    for (let i = 0; i < fixSteps.value.length; i++) {
      const step = fixSteps.value[i];
      step.status = 'running';

      if (step.type === 'file') {
        const fullPath = props.projectPath.replace(/\\/g, '/') + '/' + step.path.replace(/^\.\//, '');
        const content = await readFile(fullPath);
        if (content === null) {
          step.status = 'error';
          step.output = `文件不存在: ${fullPath}`;
          break;
        }
        // 标准化换行符
        const normalizedContent = content.replace(/\r\n/g, '\n');
        const { found, match } = fuzzyFindInContent(normalizedContent, step.search);
        if (!found) {
          step.status = 'error';
          step.output = '未在文件中找到匹配的原始代码片段（已尝试模糊匹配）';
          break;
        }
        const newContent = normalizedContent.replace(match, step.replace);
        const res = await writeFile(fullPath, newContent);
        step.status = res.success ? 'success' : 'error';
        step.output = res.success ? '已写入' : res.error;
      } else if (step.type === 'cmd') {
        const res = await runCommand(step.command, props.projectPath);
        step.status = res.success ? 'success' : 'error';
        step.output = res.stdout || res.stderr || res.error || '';
      }

      if (step.status === 'error') break;
    }
  } catch (error) {
    fixSteps.value = [{ type: 'info', label: '修复失败: ' + error.message, status: 'error', output: '' }];
  } finally {
    isFixing.value = false;
  }
};

// --- xterm 初始化 ---
const initTerminal = () => {
  if (term) return;
  term = new Terminal({
    theme: { background: '#0f172a', foreground: '#cbd5e1', cursor: '#38bdf8', selectionBackground: '#3b82f64d' },
    fontSize: 12, lineHeight: 1.4, fontFamily: 'Consolas, "Courier New", monospace',
    convertEol: true, rows: 16, cursorBlink: true, disableStdin: true, rightClickSelectsWord: true,
  });
  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const linkRegex = /(https?:\/\/[^\s"'()]+)|([a-zA-Z]:[\\/][\w.\-\\/ ]+(:[\d]+){0,2})/;
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    uri.startsWith('http') ? window.open(uri, '_blank') : emit('open-file', uri);
  }, { urlRegex: linkRegex }));
  term.open(terminalContainer.value);
  setTimeout(() => fitAddon.fit(), 50);
  term.onSelectionChange(() => {
    const selection = term?.getSelection() || '';
    hasSelection.value = !!selection;
    lastSelectionText.value = selection;
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.key === 'c' && e.type === 'keydown' && term.getSelection()) { copyLogs(); return false; }
    return true;
  });
  props.logs.forEach(line => term.writeln(line));
  writeIndex = props.logs.length;
};

const flushLogs = () => {
  if (!term || !props.logs) return;
  if (props.logs.length < writeIndex) { term.clear(); writeIndex = 0; }
  const newLogs = props.logs.slice(writeIndex);
  if (newLogs.length > 0) { newLogs.forEach(line => term.writeln(line)); writeIndex = props.logs.length; term.scrollToBottom(); }
};

onMounted(() => { nextTick(() => initTerminal()); });
watch(() => props.logs, () => flushLogs(), { deep: true });
const resizeObserver = new ResizeObserver(() => fitAddon?.fit());
onMounted(() => { if (terminalContainer.value) resizeObserver.observe(terminalContainer.value); });
onBeforeUnmount(() => {
  term?.dispose();
  resizeObserver.disconnect();
  document.body.style.overflow = '';
  if (copyStateTimer) clearTimeout(copyStateTimer);
});
</script>

<template>
  <div class="w-full h-[300px] bg-[#0f172a] rounded-b-lg p-2 overflow-hidden border-t border-gray-700 relative group">

    <div class="absolute z-10 flex items-center gap-2 pointer-events-none top-2 left-4">
       <span v-if="hasError" class="flex items-center gap-1 text-[10px] font-bold text-red-400 animate-pulse bg-black/40 px-2 py-0.5 rounded backdrop-blur-sm border border-red-500/30">
          ⚠️ 报错检测
       </span>
    </div>

    <div class="absolute z-10 flex items-center gap-2 transition-opacity duration-200 opacity-0 top-2 right-4 group-hover:opacity-100">
      <span v-if="copySuccess" class="px-2 py-1 text-xs text-green-400 border rounded bg-black/50 fade-in border-green-500/30">✅ 已复制</span>
      <span v-if="copyError" class="px-2 py-1 text-xs text-red-300 border rounded bg-black/50 fade-in border-red-500/30">❌ 复制失败</span>

      <input v-model="userQuestion" @keyup.enter="handleAnalyze" type="text" placeholder="向 AI 提问..."
        class="w-40 px-2 py-1 text-xs text-white placeholder-gray-500 transition border border-gray-600 rounded bg-gray-800/80 backdrop-blur-sm focus:border-purple-500 focus:outline-none focus:w-56" />

      <button @click="openAiModal"
        class="flex items-center gap-1 px-2 py-1 text-xs text-white transition border rounded backdrop-blur-sm bg-purple-600/80 hover:bg-purple-600 border-purple-500/50" title="打开 AI 诊断面板">
        <span>🤖</span>
        AI 诊断
      </button>

      <button @mousedown.prevent @click="copyLogs" class="p-1.5 hover:text-white rounded text-xs backdrop-blur-sm border transition"
        :class="hasSelection ? 'bg-blue-600/80 hover:bg-blue-600 text-white border-blue-500/50' : 'bg-gray-700/80 hover:bg-blue-600 text-gray-300 border-gray-600'"
        :title="hasSelection ? '复制选中文本 (Ctrl+C)' : '复制所有日志'">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      </button>

      <button @click="clearLogs" class="p-1.5 bg-gray-700/80 hover:bg-red-600 text-gray-300 hover:text-white rounded text-xs backdrop-blur-sm border border-gray-600 transition" title="清空当前屏幕">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
      </button>
    </div>

    <div ref="terminalContainer" class="w-full h-full" style="text-align: left !important;"></div>

    <!-- AI 弹窗 -->
    <div v-if="showAiModal"
      class="z-50 flex flex-col backdrop-blur-md transition-all duration-300 animate-fade-in"
      :class="isFullscreen ? 'fixed inset-0 bg-[#0f172a]' : 'absolute inset-0 bg-[#0f172a]/95'"
    >
      <!-- 头部 -->
      <div class="flex items-center justify-between p-3 border-b border-gray-700/50 bg-[#1e293b]/50">
        <h3 class="flex items-center gap-2 text-sm font-bold text-purple-400">
          <span>🤖</span> AI 报告
        </h3>
        <div class="flex items-center gap-1">
          <button @click="isFullscreen = !isFullscreen" class="px-2 text-gray-400 transition rounded hover:text-white hover:bg-white/10" :title="isFullscreen ? '退出全屏' : '全屏'">
            <svg v-if="!isFullscreen" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
          </button>
          <button @click="showAiModal = false; isFullscreen = false" class="px-2 text-gray-400 transition rounded hover:text-white hover:bg-white/10">✕</button>
        </div>
      </div>

      <!-- 内容区 -->
      <div class="flex-1 p-4 overflow-y-auto prose-sm prose text-left custom-markdown prose-invert max-w-none">
        <!-- 诊断中 -->
        <div v-if="isAnalyzing" class="flex flex-col items-center justify-center h-full space-y-2 text-gray-400">
          <div class="w-6 h-6 border-2 border-purple-500 rounded-full border-t-transparent animate-spin"></div>
          <p class="text-xs animate-pulse">正在思考分析...</p>
        </div>
        <!-- 空状态：尚未诊断 -->
        <div v-else-if="!aiResult" class="flex flex-col items-center justify-center h-full space-y-3 text-gray-500">
          <div class="text-3xl opacity-30">🤖</div>
          <p class="text-sm">点击下方「立即诊断」开始分析</p>
          <p class="text-xs text-gray-600">将基于当前终端日志进行智能诊断</p>
        </div>
        <!-- 诊断结果 -->
        <template v-else>
          <div v-html="renderedMarkdown"></div>

          <!-- 修复执行进度 -->
          <div v-if="fixSteps.length > 0" class="pt-4 mt-4 border-t border-gray-700 not-prose">
            <h4 class="mb-3 text-sm font-bold text-amber-400">🔧 修复执行</h4>
            <div class="space-y-2">
              <div v-for="(step, i) in fixSteps" :key="i" class="rounded-lg border border-gray-700 bg-[#0d1117] overflow-hidden">
                <div class="flex items-center gap-2 px-3 py-2 bg-[#161b22]">
                  <span v-if="step.status === 'pending'" class="text-gray-500">○</span>
                  <span v-else-if="step.status === 'running'" class="text-blue-400 animate-pulse">◉</span>
                  <span v-else-if="step.status === 'success'" class="text-green-400">✅</span>
                  <span v-else-if="step.status === 'error'" class="text-red-400">❌</span>
                  <span v-else class="text-gray-400">ℹ️</span>
                  <span class="text-xs" :class="step.status === 'error' ? 'text-red-300' : 'text-gray-300'">{{ step.label }}</span>
                </div>
                <div v-if="step.output" class="px-3 py-2 text-xs border-t border-gray-700/50">
                  <pre class="!p-0 !m-0 !border-0 !bg-transparent whitespace-pre-wrap" :class="step.status === 'error' ? 'text-red-400' : 'text-green-300/80'">{{ step.output }}</pre>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>

      <!-- 底部 -->
      <div class="flex items-center justify-between px-4 py-2 text-xs border-t border-gray-700/50 bg-[#1e293b]/30">
        <div class="flex items-center gap-2 text-gray-500">
          <span>由</span>
          <span class="text-purple-400">{{ diagModelConfig.name || 'AI' }}</span>
          <span>·</span>
          <span class="font-mono text-gray-400">{{ diagModelConfig.model }}</span>
          <span>提供</span>
        </div>
        <div class="flex items-center gap-2">
          <span v-if="isFixing" class="text-amber-400 animate-pulse">正在读取文件并修复...</span>
          <!-- 立即诊断 -->
          <button
            v-if="!isFixing"
            @click="handleAnalyze"
            :disabled="isAnalyzing || (logs.length === 0 && !userQuestion.trim())"
            class="flex items-center gap-1 px-3 py-1 font-medium text-white transition rounded disabled:opacity-50 disabled:cursor-not-allowed"
            :class="isAnalyzing ? 'bg-gray-600' : 'bg-purple-600 hover:bg-purple-500'"
          >
            <span v-if="isAnalyzing" class="animate-spin">⏳</span>
            <span v-else>🤖</span>
            {{ isAnalyzing ? '诊断中...' : '立即诊断' }}
          </button>
          <!-- 执行修复：诊断成功后才显示 -->
          <button
            v-if="aiResult && !isAnalyzing && !isFixing"
            @click="handleFix"
            :disabled="!projectPath"
            class="flex items-center gap-1 px-3 py-1 font-medium text-white transition rounded disabled:opacity-50 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500"
          >
            <span>🔧</span>
            执行修复
          </button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.fade-in { animation: fadeIn 0.3s ease-in-out; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
.animate-fade-in { animation: fadeIn 0.2s ease-out; }

.custom-markdown :deep(pre) { background-color: #0d1117 !important; padding: 1rem; border-radius: 0.5rem; border: 1px solid #30363d; overflow-x: auto; }
.custom-markdown :deep(code) { color: #e5e7eb; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background-color: transparent !important; }
.custom-markdown :deep(h3) { color: #c084fc; margin-top: 1em; font-size: 1.1em; border-bottom: 1px solid #333; padding-bottom: 0.3em; }
.custom-markdown :deep(ul) { padding-left: 1.2rem; list-style-type: disc; }
.custom-markdown :deep(li) { margin-bottom: 0.2em; }
.custom-markdown :deep(strong) { color: #818cf8; }
</style>
