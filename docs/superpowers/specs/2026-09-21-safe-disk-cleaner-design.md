# C 盘安全清理功能设计

## 目标

为 DevMaster 增加一个仅面向 Windows 的“磁盘清理”独立页面。用户可以扫描预定义的低风险缓存目录，查看每类缓存的文件数量和占用空间，勾选后经二次确认执行清理，缓解 C 盘空间不足问题。

第一版只实现安全模式，不提供任意路径扫描、全盘大文件扫描或项目构建产物清理。

## 用户流程

1. 用户在 Dashboard 顶部点击“磁盘清理”。
2. 应用进入独立的 `/disk-cleaner` 页面，先展示 C 盘容量概览和安全说明，不自动删除任何文件。
3. 用户点击“开始扫描”。页面展示扫描进度，服务端统计各安全类别。
4. 页面按类别展示名称、说明、实际路径、文件数量、可释放空间和扫描异常数。
5. 有可清理内容的低风险类别默认勾选，用户可以逐项取消。
6. 用户点击“立即清理”，确认框明确显示类别数和预计释放空间。
7. 确认后服务端重新解析白名单并执行清理。页面展示实际释放空间、已删除文件数、跳过数和失败数。
8. 用户可重新扫描，确认清理后的空间状态。

非 Windows 平台只展示“不支持”的说明，扫描和清理按钮不可用。

## 扫描范围

安全类别由服务端定义，客户端不能提交路径：

| 类别 ID | 类别 | Windows 路径来源 | 行为 |
| --- | --- | --- | --- |
| `user-temp` | 用户临时文件 | `%TEMP%`、`%LOCALAPPDATA%\Temp` | 路径去重后扫描目录内容，保留根目录 |
| `npm-cache` | npm 缓存 | `%LOCALAPPDATA%\npm-cache`，以及 npm 默认用户缓存位置 | 扫描目录内容，保留根目录 |
| `pnpm-cache` | pnpm 缓存 | `%LOCALAPPDATA%\pnpm\store`、`%LOCALAPPDATA%\pnpm-store` | 仅处理存在的目录，保留根目录 |
| `yarn-cache` | Yarn 缓存 | `%LOCALAPPDATA%\Yarn\Cache` | 扫描目录内容，保留根目录 |
| `devmaster-cache` | DevMaster/Electron 缓存 | 应用 userData 下的 `Cache`、`Code Cache`、`GPUCache` | 不清理当前进程正在使用或锁定的文件，保留根目录 |

Windows Update、`C:\Windows\Temp` 和回收站第一版不执行清理。它们涉及系统服务、管理员权限或用户恢复语义，不能满足“普通权限、低风险、可预测”的安全模式约束。页面文案不会把这些目录计入“可释放空间”。这也保证实现与“不触碰 Windows 系统目录”的安全边界一致。

不扫描或删除以下内容：

- `C:\Windows`（上述设计也没有任何允许的例外）
- `C:\Program Files` 和 `C:\Program Files (x86)`
- 桌面、文档、下载、图片等用户内容目录
- DevMaster 管理的项目源码、`node_modules`、构建产物
- 符号链接、目录联接点及其目标
- 客户端提供的任意文件系统路径

## 架构与组件

### 后端清理模块

新增 `server/utils/diskCleaner.js`，职责单一：

- `getSafeCategories(environment)`：根据平台、环境变量和应用 userData 目录生成安全类别；规范化并去重目录。
- `isPathInsideRoot(candidate, root)`：使用 Windows 路径语义验证候选路径严格位于白名单根目录内，拒绝根目录自身、前缀碰撞和目录穿越。
- `scanSafeCategories(options)`：逐类别递归遍历普通文件，累计字节数、文件数和不可访问项；不跟随符号链接或目录联接点。
- `cleanSafeCategories(categoryIds, options)`：只接受已知类别 ID；服务端重新生成路径并逐项校验后删除目录内容，绝不删除类别根目录。
- `getDriveSpace(drive)`：返回 C 盘总容量、可用容量和已用容量。实现失败时返回可展示的错误，而不影响缓存扫描。

文件系统和环境信息通过可选依赖注入传入，便于用 Node 内置测试运行器覆盖路径安全及扫描行为。

### Socket.io 接口

在 `server/index.js` 中增加：

- `disk-cleaner:scan(payload, callback)`
  - `payload` 第一版为空对象，不接收目录。
  - 成功返回 `{ success, platform, drive, categories, totals, durationMs }`。
  - 每个类别返回 `{ id, name, description, paths, fileCount, sizeBytes, skippedCount, errors }`。
- `disk-cleaner:clean({ categoryIds }, callback)`
  - `categoryIds` 必须是非空、去重后的已知 ID 数组。
  - 成功返回 `{ success, releasedBytes, deletedFiles, skippedCount, failedCount, categories }`。
  - 部分文件因占用或权限失败时仍返回整体结果，并包含分类错误摘要。
  - 非 Windows 平台返回明确错误，不执行文件操作。

每个回调都只调用一次。未捕获异常转换为 `{ success: false, error }`，避免导致 Socket 进程退出。

### 前端页面

新增 `client/src/views/disk-cleaner/index.vue`：

- 顶部提供返回 Dashboard 的按钮和“C 盘安全清理”标题。
- 容量卡片展示总容量、已用、可用及占用比例。
- 安全说明明确列出只处理缓存、不触碰个人文件和项目源码。
- 扫描结果卡片支持按类别勾选，显示格式化后的容量、路径、文件数和跳过项。
- 扫描期间禁用重复扫描和清理；清理期间禁用全部选择操作。
- 使用现有 `GlobalConfirm` 进行二次确认，使用现有全局 Toast 显示错误或完成状态。
- 组件卸载后忽略过期回调，避免离开页面后更新状态。

修改 `client/src/router/index.ts` 注册 `/disk-cleaner`；修改 Dashboard 顶部工具区增加入口按钮。

## 数据与安全边界

客户端只持有类别 ID 和展示数据。删除请求不能携带路径，后端也不读取扫描响应中的路径作为删除依据。

每次清理都重新执行以下校验：

1. 平台必须为 `win32`。
2. 类别 ID 必须存在于当前服务端生成的安全类别中。
3. 类别根路径必须是绝对路径，且命中明确的用户缓存白名单。
4. 遍历得到的每个子项必须严格位于对应根目录内。
5. `lstat` 判定为符号链接或目录联接点时跳过，不解析目标。
6. 删除仅针对根目录的子项，永不删除根目录。

扫描结果是估算值。文件可能在扫描和清理之间变化，因此最终结果以清理阶段实际统计为准。

## 错误处理

- 目录不存在：视为空类别，不报错。
- 单个文件无权限、被占用或扫描期间消失：计入跳过/失败并继续。
- 整个类别不可访问：类别保留在结果中并显示错误摘要。
- C 盘容量查询失败：缓存扫描仍可用，容量卡片显示“暂不可用”。
- Socket 断开或超时：前端恢复按钮状态并提示用户重试，不保留“清理成功”假象。
- 清理部分成功：显示实际释放空间及失败数，不使用笼统的完全成功提示。

## 测试与验证

项目现有测试使用 Node 内置 `node:test`。新增 `server/utils/diskCleaner.test.js`，通过临时目录和依赖注入测试：

- Windows 路径规范化与重复路径合并。
- 严格子路径判断，覆盖 `..`、大小写、相似前缀和根目录本身。
- 未知类别 ID 被拒绝。
- 扫描统计普通文件并跳过符号链接。
- 清理只删除白名单根目录下的内容，保留根目录。
- 文件占用/权限错误被汇总且不终止其他项目。
- 非 Windows 平台拒绝扫描和清理。

验证命令：

- `node --test server/utils/diskCleaner.test.js`
- `node --test server/utils/*.test.js`
- `cd client && npm run build`

最后在 Windows 开发模式下手动验证：页面入口、扫描状态、取消勾选、二次确认、部分失败提示、清理后重新扫描以及非任意路径删除约束。

## 第一版明确不做

- 全盘大文件扫描或目录树可视化
- 清理项目 `node_modules`、构建产物或源码
- 自动清理、定时清理或后台静默清理
- 管理员提权
- 清空回收站
- Windows Update、系统还原点、休眠文件或系统组件存储清理
- 删除前打包备份或恢复已删除缓存
