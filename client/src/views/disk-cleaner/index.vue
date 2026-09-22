<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { socket } from '../../utils/socket';
import { confirm } from '../../utils/confirm';

interface DriveSpace {
  drive: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

interface CleanerError {
  path: string;
  code: string;
}

interface ScanCategory {
  id: string;
  mode: 'cleanable' | 'report-only';
  name: string;
  description: string;
  paths: string[];
  fileCount: number;
  sizeBytes: number;
  skippedCount: number;
  errors: CleanerError[];
  safeToClean: boolean;
  cleanupAdvice: string;
}

interface ScanResponse {
  success: boolean;
  error?: string;
  platform?: string;
  drive: DriveSpace | null;
  driveError?: string;
  categories?: ScanCategory[];
  totals?: {
    fileCount: number;
    sizeBytes: number;
    skippedCount: number;
  };
  durationMs?: number;
}

interface CleanResponse {
  success: boolean;
  error?: string;
  releasedBytes?: number;
  deletedFiles?: number;
  skippedCount?: number;
  failedCount?: number;
}

const router = useRouter();
const isScanning = ref(false);
const isCleaning = ref(false);
const scanResult = ref<ScanResponse | null>(null);
const cleanResult = ref<CleanResponse | null>(null);
const selectedIds = ref(new Set<string>());
const pageError = ref('');
let requestGeneration = 0;
let mounted = true;

const request = <T,>(event: string, payload: unknown, timeoutMs = 120_000) =>
  new Promise<T>((resolve, reject) => {
    socket.timeout(timeoutMs).emit(event, payload, (error: Error | null, response: T) => {
      if (error) reject(new Error('请求超时，请检查本地服务后重试'));
      else resolve(response);
    });
  });

const categories = computed(() => scanResult.value?.categories || []);
const cleanableCategories = computed(() => categories.value.filter((category) => category.mode !== 'report-only' && category.safeToClean));
const reportOnlyCategories = computed(() => categories.value.filter((category) => category.mode === 'report-only' || !category.safeToClean));
const selectedCount = computed(() => selectedIds.value.size);
const selectedBytes = computed(() => categories.value.reduce(
  (total, category) => selectedIds.value.has(category.id) ? total + category.sizeBytes : total,
  0
));
const usedPercent = computed(() => {
  const drive = scanResult.value?.drive;
  if (!drive || drive.totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, (drive.usedBytes / drive.totalBytes) * 100));
});
const isBusy = computed(() => isScanning.value || isCleaning.value);
const canClean = computed(() => selectedCount.value > 0 && selectedBytes.value > 0 && !isBusy.value);

const formatBytes = (value: number | undefined) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${index === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[index]}`;
};

const toggleCategory = (id: string) => {
  if (isBusy.value) return;
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
};

const scan = async ({ preserveCleanResult = false } = {}) => {
  const generation = ++requestGeneration;
  isScanning.value = true;
  pageError.value = '';
  if (!preserveCleanResult) cleanResult.value = null;

  try {
    const response = await request<ScanResponse>('disk-cleaner:scan', {});
    if (!mounted || generation !== requestGeneration) return;
    if (!response?.success) throw new Error(response?.error || '扫描失败');
    scanResult.value = response;
    selectedIds.value = new Set(
      (response.categories || [])
        .filter((category) => category.mode !== 'report-only' && category.safeToClean && category.sizeBytes > 0)
        .map((category) => category.id)
    );
  } catch (error) {
    if (!mounted || generation !== requestGeneration) return;
    const message = error instanceof Error ? error.message : '扫描失败';
    pageError.value = message;
    window.$toast?.error(message, 5000);
  } finally {
    if (mounted && generation === requestGeneration) isScanning.value = false;
  }
};

const clean = async () => {
  if (!canClean.value) return;
  const approved = await confirm(
    `将清理 ${selectedCount.value} 类缓存，预计释放 ${formatBytes(selectedBytes.value)}。\n\n缓存可重新生成，但清理过程中请勿关闭应用。`,
    '确认清理缓存',
    { confirmText: '立即清理', cancelText: '取消', type: 'warning' }
  );
  if (!approved || !mounted) return;

  const generation = ++requestGeneration;
  isCleaning.value = true;
  pageError.value = '';
  try {
    const response = await request<CleanResponse>('disk-cleaner:clean', {
      categoryIds: [...selectedIds.value],
    });
    if (!mounted || generation !== requestGeneration) return;
    if (!response?.success) throw new Error(response?.error || '清理失败');
    cleanResult.value = response;
    if ((response.failedCount || 0) > 0) {
      window.$toast?.warning(`已释放 ${formatBytes(response.releasedBytes)}，${response.failedCount} 项未能清理`, 5000);
    } else {
      window.$toast?.success(`已释放 ${formatBytes(response.releasedBytes)}`, 4000);
    }
    isCleaning.value = false;
    await scan({ preserveCleanResult: true });
  } catch (error) {
    if (!mounted || generation !== requestGeneration) return;
    const message = error instanceof Error ? error.message : '清理失败';
    pageError.value = message;
    window.$toast?.error(message, 5000);
  } finally {
    if (mounted && generation === requestGeneration) isCleaning.value = false;
  }
};

onUnmounted(() => {
  mounted = false;
  requestGeneration += 1;
});
</script>

<template>
  <div class="min-h-screen pb-24 text-gray-100 bg-gray-950">
    <header class="sticky top-0 z-20 border-b border-gray-800 bg-gray-950/95 backdrop-blur">
      <div class="flex items-center justify-between max-w-6xl gap-4 px-4 py-4 mx-auto sm:px-6">
        <div class="flex items-center min-w-0 gap-3">
          <button
            type="button"
            class="flex items-center justify-center flex-none w-9 h-9 text-gray-300 transition border border-gray-700 rounded hover:text-white hover:bg-gray-800"
            title="返回项目面板"
            aria-label="返回项目面板"
            @click="router.push('/dashboard')"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <div class="min-w-0">
            <h1 class="text-lg font-semibold text-white truncate">C 盘安全清理</h1>
            <p class="text-xs text-gray-500">仅清理可重新生成的用户缓存</p>
          </div>
        </div>
        <button
          type="button"
          class="flex items-center justify-center min-w-[104px] gap-2 px-4 py-2 text-sm font-medium text-white transition rounded bg-emerald-700 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="isBusy"
          @click="scan()"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" class="w-4 h-4" :class="{ 'animate-spin': isScanning }" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v6h-6"/></svg>
          {{ isScanning ? '扫描中' : '开始扫描' }}
        </button>
      </div>
    </header>

    <main class="max-w-6xl px-4 py-6 mx-auto space-y-6 sm:px-6">
      <section v-if="scanResult?.drive" class="py-2" aria-label="C 盘容量">
        <div class="grid gap-5 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <div>
            <p class="text-xs font-medium text-gray-500">C 盘使用情况</p>
            <p class="mt-1 text-2xl font-semibold text-white">{{ usedPercent.toFixed(1) }}%</p>
          </div>
          <div><p class="text-xs text-gray-500">总容量</p><p class="mt-1 font-medium">{{ formatBytes(scanResult.drive.totalBytes) }}</p></div>
          <div><p class="text-xs text-gray-500">已使用</p><p class="mt-1 font-medium text-amber-300">{{ formatBytes(scanResult.drive.usedBytes) }}</p></div>
          <div><p class="text-xs text-gray-500">可用空间</p><p class="mt-1 font-medium text-emerald-300">{{ formatBytes(scanResult.drive.freeBytes) }}</p></div>
        </div>
        <div class="h-2 mt-4 overflow-hidden bg-gray-800 rounded">
          <div class="h-full transition-all rounded bg-amber-500" :style="{ width: `${usedPercent}%` }"></div>
        </div>
      </section>

      <section v-else-if="scanResult" class="py-2 border-b border-gray-800">
        <p class="font-medium text-gray-200">C 盘容量暂不可用</p>
        <p class="mt-1 text-sm text-gray-500">{{ scanResult.driveError || '无法读取磁盘容量' }}</p>
      </section>

      <section class="flex gap-3 px-4 py-3 border rounded bg-emerald-950/30 border-emerald-900/70">
        <svg aria-hidden="true" viewBox="0 0 24 24" class="flex-none w-5 h-5 mt-0.5 text-emerald-400" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></svg>
        <p class="text-sm leading-6 text-gray-300">清理仅限当前用户的明确缓存目录，不扫描个人文件或项目源码；软件安装目录只读统计，后端禁止删除。</p>
      </section>

      <section v-if="cleanResult" class="grid grid-cols-2 gap-px overflow-hidden border border-gray-800 rounded bg-gray-800 sm:grid-cols-4">
        <div class="p-4 bg-gray-900"><p class="text-xs text-gray-500">实际释放</p><p class="mt-1 text-lg font-semibold text-emerald-300">{{ formatBytes(cleanResult.releasedBytes) }}</p></div>
        <div class="p-4 bg-gray-900"><p class="text-xs text-gray-500">删除文件</p><p class="mt-1 text-lg font-semibold">{{ cleanResult.deletedFiles || 0 }}</p></div>
        <div class="p-4 bg-gray-900"><p class="text-xs text-gray-500">跳过项目</p><p class="mt-1 text-lg font-semibold text-amber-300">{{ cleanResult.skippedCount || 0 }}</p></div>
        <div class="p-4 bg-gray-900"><p class="text-xs text-gray-500">失败项目</p><p class="mt-1 text-lg font-semibold" :class="(cleanResult.failedCount || 0) > 0 ? 'text-red-400' : 'text-gray-200'">{{ cleanResult.failedCount || 0 }}</p></div>
      </section>

      <section v-if="pageError && !scanResult" class="px-4 py-8 text-center border border-red-900 rounded bg-red-950/20">
        <p class="font-medium text-red-300">{{ pageError }}</p>
        <p class="mt-2 text-sm text-gray-500">请确认当前在 Windows 环境运行，并检查本地服务连接。</p>
      </section>

      <section v-if="!scanResult && !isScanning && !pageError" class="flex flex-col items-center justify-center min-h-[320px] py-12 text-center border-y border-gray-800">
        <div class="flex items-center justify-center w-12 h-12 text-gray-400 bg-gray-900 border border-gray-800 rounded">
          <svg aria-hidden="true" viewBox="0 0 24 24" class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 21h14"/></svg>
        </div>
        <p class="mt-4 font-medium text-gray-200">尚未扫描缓存</p>
        <p class="mt-1 text-sm text-gray-500">开始扫描后可查看每类缓存的占用情况。</p>
        <button type="button" class="px-4 py-2 mt-5 text-sm font-medium text-white rounded bg-emerald-700 hover:bg-emerald-600" @click="scan()">开始扫描</button>
      </section>

      <section v-if="isScanning && !scanResult" class="flex min-h-[320px] items-center justify-center border-y border-gray-800">
        <div class="text-center"><div class="w-9 h-9 mx-auto border-2 rounded-full border-emerald-500/30 border-t-emerald-400 animate-spin"></div><p class="mt-4 text-sm text-gray-400">正在统计安全缓存...</p></div>
      </section>

      <section v-if="cleanableCategories.length" class="space-y-3">
        <div class="flex items-end justify-between gap-4">
          <div><h2 class="text-sm font-semibold text-white">可清理项目</h2><p class="mt-1 text-xs text-gray-500">扫描耗时 {{ scanResult?.durationMs || 0 }} ms</p></div>
          <p class="text-xs text-gray-500">共 {{ scanResult?.totals?.fileCount || 0 }} 个文件</p>
        </div>

        <article
          v-for="category in cleanableCategories"
          :key="category.id"
          class="grid gap-4 p-4 transition border rounded-lg sm:grid-cols-[auto_1fr_auto]"
          :class="selectedIds.has(category.id) ? 'border-emerald-800 bg-gray-900' : 'border-gray-800 bg-gray-900/60'"
        >
          <input
            v-if="category.mode !== 'report-only' && category.safeToClean"
            type="checkbox"
            class="w-5 h-5 mt-1 text-emerald-600 bg-gray-800 border-gray-600 rounded focus:ring-emerald-600 disabled:opacity-40"
            :checked="selectedIds.has(category.id)"
            :disabled="isBusy || category.sizeBytes <= 0"
            :aria-label="`选择${category.name}`"
            @change="toggleCategory(category.id)"
          />
          <div v-else class="flex items-center justify-center w-5 h-5 mt-1 text-gray-500 border border-gray-700 rounded" title="只读分析，不提供删除">i</div>
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-white">{{ category.name }}</h3>
            <p class="mt-1 text-sm text-gray-400">{{ category.description }}</p>
            <p class="mt-2 text-xs" :class="category.safeToClean ? 'text-emerald-300' : 'text-amber-300'">可安全清理：{{ category.safeToClean ? '是' : '否' }}</p>
            <p class="mt-1 text-xs text-gray-500">建议：{{ category.cleanupAdvice }}</p>
            <div class="mt-3 space-y-1">
              <p v-for="cachePath in category.paths" :key="cachePath" class="font-mono text-xs text-gray-500 break-all">{{ cachePath }}</p>
            </div>
            <p v-if="category.skippedCount > 0" class="mt-3 text-xs text-amber-400">{{ category.skippedCount }} 项因占用、权限或链接被跳过</p>
          </div>
          <div class="sm:text-right">
            <p class="text-lg font-semibold" :class="category.sizeBytes > 0 ? 'text-emerald-300' : 'text-gray-500'">{{ formatBytes(category.sizeBytes) }}</p>
            <p class="mt-1 text-xs text-gray-500">{{ category.fileCount }} 个文件</p>
          </div>
        </article>
      </section>

      <section v-if="reportOnlyCategories.length" class="space-y-3">
        <div>
          <h2 class="text-sm font-semibold text-white">只读占用分析</h2>
          <p class="mt-1 text-xs text-gray-500">这些目录可能包含账号、配置或用户数据，仅统计大小，不提供删除。</p>
        </div>
        <article
          v-for="category in reportOnlyCategories"
          :key="category.id"
          class="grid gap-4 p-4 border border-amber-900/60 rounded-lg bg-amber-950/10 sm:grid-cols-[1fr_auto]"
        >
          <div class="min-w-0">
            <h3 class="text-sm font-semibold text-white">{{ category.name }}</h3>
            <p class="mt-1 text-sm text-gray-400">{{ category.description }}</p>
            <p class="mt-2 text-xs text-amber-300">只读分析，不会加入清理</p>
            <p class="mt-1 text-xs text-gray-500">建议：{{ category.cleanupAdvice }}</p>
            <p v-for="cachePath in category.paths" :key="cachePath" class="mt-2 font-mono text-xs text-gray-500 break-all">{{ cachePath }}</p>
          </div>
          <div class="sm:text-right">
            <p class="text-lg font-semibold text-amber-200">{{ formatBytes(category.sizeBytes) }}</p>
            <p class="mt-1 text-xs text-gray-500">{{ category.fileCount }} 个文件</p>
          </div>
        </article>
      </section>

      <section v-if="scanResult && !isScanning && categories.length === 0" class="py-12 text-center border-y border-gray-800">
        <p class="font-medium text-gray-200">未发现可清理缓存</p>
        <p class="mt-1 text-sm text-gray-500">当前安全目录没有可统计的缓存文件。</p>
      </section>
    </main>

    <footer v-if="scanResult && cleanableCategories.length" class="fixed bottom-0 left-0 right-0 z-20 border-t border-gray-800 bg-gray-950/95 backdrop-blur">
      <div class="flex items-center justify-between max-w-6xl gap-4 px-4 py-3 mx-auto sm:px-6">
        <div class="min-w-0"><p class="text-sm font-medium text-white">已选 {{ selectedCount }} 类</p><p class="text-xs text-gray-500">预计释放 {{ formatBytes(selectedBytes) }}</p></div>
        <button
          type="button"
          class="flex items-center justify-center min-w-[112px] px-4 py-2 text-sm font-semibold text-white transition rounded bg-emerald-700 hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!canClean"
          @click="clean"
        >
          {{ isCleaning ? '清理中...' : '立即清理' }}
        </button>
      </div>
    </footer>
  </div>
</template>
