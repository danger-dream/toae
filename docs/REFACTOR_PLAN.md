# Tosa Electron 重构实施方案

> 状态：实施基线方案（本文件不包含应用代码）  
> 方案日期：2026-07-26  
> 旧项目事实基线：`/opt/workspace/tosa`，commit `a506c9ad0a80954f761f57bc032fdb03247af7d1`  
> 第一版目标平台：Windows x64  
> 推荐宿主基线：Electron 43.2.0 x64（Chromium 150.0.7871.129 / Node 24.18.0）

## 0. 阅读约定

本文中的“必须 / 不得”是首版交付门槛，“建议”是默认实施选择，若偏离须在实施记录中给出可复现实测依据。本文建立在已经完成的旧仓库事实审阅和 Windows/Electron 技术审阅之上，不再重复全仓审计。

**版本快照声明：**上面的 Electron、Chromium、Node 版本，以及下文 AutoHotkey 版本，只代表截至 **2026-07-26** 的方案基线。正式实施开始当天必须重新检查各项目的最新 stable、Windows 支持范围和安全公告，然后精确锁定版本（含 lockfile、Rust toolchain/crate、helper 与 DLL 哈希）；不得使用浮动版本。若最新 stable 与本基线不同，应先完成兼容性复测再更新基线，而不是无条件追新。

---

## 1. 执行摘要

本轮重构的目标是将旧 Tauri 宿主替换为：

- **Electron Main**：应用、窗口、托盘、自启动、网络、配置与 helper 生命周期的可信控制面；
- **安全 preload**：只暴露按业务命名、参数受限的最小 API；
- **Vue renderer**：迁移并保真现有翻译、设置和截图 UI，不获得 Node 或任意 IPC 能力；
- **独立 Rust x64 native helper**：承载 UI Automation、剪贴板回退、Windows Graphics Capture（WGC）和 AutoHotkey_H 隔离；
- **AutoHotkey_H x64**：由 helper 的 `--hook` 子进程加载，继续向完整 AHK 脚本注入同名 `rust_callback`。

Electron Main **不得**通过 Node FFI 加载 AutoHotkey_H，也**不得**把 AutoHotkey_H DLL 直接加载到 Electron Main。DLL 崩溃、UIA 卡死或剪贴板等待必须被限制在独立 helper/worker 进程内，不能拖垮 Electron。

重构以行为等价和可回归为主，不把换壳变成功能扩张：

1. 保留当前三个生产窗口：`translator`、`setting`、`screen-capture`；
2. 明确删除 `selection-translator` 划词助手窗口及其专属功能；
3. **必须保留**快捷动作 `selection_translate`，以及 `get_selected_text.rs` 所代表的“UI Automation 优先，失败后 Ctrl+C”取词链路；
4. 除明确删除的划词助手外，旧 UI 中用户可见但尚为空壳的入口不得静默删除，也不得借重构擅自实现成新功能；
5. 迁移 11 个翻译 Provider 和 3 个 OCR Provider，网络请求移到 Main adapter；
6. 第一版只承诺 Windows x64。NSIS 是建议安装包；自动更新、新本地 OCR 均不在本轮范围。

---

## 2. 目标、边界与不变项

### 2.1 目标

- 在 Windows 10/11 x64 上复现旧产品可见工作流与视觉基线；
- 用 Electron 的安全进程模型替代旧 Tauri bridge；
- 保留完整 AHK 脚本兼容性，并使启停、重载、退出可观测且无残留；
- 修复审阅中已经证实的问题，不机械复制缺陷；
- 降低截图/OCR 链路的全屏编码、base64 膨胀和 renderer 重编码成本；
- 可靠迁移旧配置、`script.ahk` 与缓存，同时绝不修改旧数据；
- 交付可安装、可卸载、可验证自启动状态的 Windows x64 安装版。

### 2.2 明确不在范围内

- 不新增 macOS/Linux 首版支持；
- 不新增本地 OCR，也不增加第四个 OCR Provider；
- 不新增自动更新系统；
- 不把旧 UI 空壳入口扩展为新功能；
- 不重新设计翻译产品形态、设置栏目或截图交互；
- 不把 AHK DLL 搬进 Electron Main，不采用 `ffi-napi`、Node-API 原生 FFI 等方案；
- 不在迁移时删除、改名、清理或“修复”旧应用目录；
- 不以放宽 Electron 安全设置来换取旧代码直接运行。

### 2.3 必须保持的不变项

| 项目 | 不变要求 |
| --- | --- |
| 生产窗口 | `translator`、`setting`、`screen-capture` 均保留 |
| 翻译窗视觉 | 初始内容尺寸 450×230 DIP；透明、无边框、8px 圆角、阴影、可拖拽 |
| 翻译窗行为 | 失焦时未 pinup 则隐藏；pinup 时保持；内容可自动增高 |
| 快捷动作 | 保留四个 action 的名字和含义：`show_translator`、`screenshot_translate`、`selection_translate`、`screenshot_recognizer` |
| 取词 | `selection_translate` 继续执行 UIA→Ctrl+C 回退，不退化为只读剪贴板 |
| AHK | 用户完整脚本基本原样兼容；继续注入同名 `rust_callback` |
| Provider | 11 个翻译 Provider、百度/腾讯/Custom 三个 OCR Provider 均进入迁移与实测矩阵 |
| 数据 | 配置、脚本、缓存仅 copy/import；旧源文件保持字节不变 |
| 可见空壳 | 除划词助手外保持原可见状态与无功能语义，不删除、不扩展 |

---

## 3. “删除划词助手”与“保留取词翻译”的边界

这是本次最容易误删的边界，必须按两条独立能力处理。

### 3.1 删除：划词助手 `selection-translator`

“划词助手”是选中文本后出现的独立浮动工具栏/窗口及其插件动作，旧代码对应：

- 窗口 label：`selection-translator`；
- renderer：`src/SelectionTranslator/App.vue`；
- 插件：`src/Plugins/Selection/*`（Translate、Copy、Link、Baidu、Bing、Google）；
- 专属设置：`enable_selection_assistant`、`pickword_type`、`assistant_hide_timer`、`assistants`、`enable_rule`、`assistant_rules` 等。

首版不创建该窗口，不注册其监听/托盘入口，不运行其自动弹出逻辑，并从设置 UI 中移除仅服务于该助手的控制项。迁移时这些旧字段保留在只读原始备份/迁移报告中，但不激活，不映射成别的新功能。

### 3.2 保留：取词翻译 `selection_translate`

`selection_translate` 是四个全局 action 之一，其语义是：

1. 获取当前前台应用所选文本；
2. UI Automation 成功则直接使用文本；
3. UIA 不可用时，以完整剪贴板保存/恢复保护的 Ctrl+C 作为回退；
4. 成功后显示/聚焦 `translator`，把文本送入源文本区并按既有配置触发翻译；
5. 失败时给出有界、可理解的错误，不打开已删除的划词助手。

因此，删除 `selection-translator` **绝不等于**删除 `selection_translate`，也不得删除或简化 `get_selected_text.rs` 所代表的 UIA→Ctrl+C 能力。

### 3.3 其他空壳入口规则

UI 迁移前以旧 commit 的截图和交互清单冻结可见入口。除上节明确列出的划词助手专属项外：

- 原来可见但点击无实际实现的入口仍保持可见及原有禁用/空壳反馈；
- 不得因为 Electron bridge 尚未实现而直接隐藏入口；
- 不得把空壳解释成需求并新增后台能力；
- 若某入口是否属于划词助手无法由基线确定，默认保留并标记待产品确认，而不是删除。

---

## 4. 旧项目事实、关键文件与可复用范围

### 4.1 已核实事实

- 事实基线仓库：`/opt/workspace/tosa`；commit：`a506c9ad0a80954f761f57bc032fdb03247af7d1`。
- 当前生产窗口是 `translator`、`setting`、`screen-capture`。
- `selection-translator` 是本轮待删除的划词助手。
- 四个 action 常量位于 `src-tauri/src/global.rs`。
- `src/Background/Electron.ts` 的方法全部抛出 `Method not implemented`，只是 stub，不能视作 Electron 迁移已具备基础实现。
- 当前 AHK 链路已经是：`src-tauri/src/ahk.rs` 启动当前程序的 `--hook` 子进程，`src-tauri/src/ahk_worker.rs` 在该子进程中加载 AutoHotkey_H DLL，并由 `rust_callback` 输出 action。
- Windows 取词实现在 `src-tauri/src/get_selected_text.rs`，其保留价值是 UI Automation 优先和 Ctrl+C 回退，而不是逐行照搬其中的剪贴板缺陷。
- 旧 bundle identifier 为 `com.danger-dream.tosa`，迁移探测旧目录时应以该标识和旧 Tauri 实际解析路径为依据，不做全盘模糊扫描。

### 4.2 关键文件映射

| 旧文件/目录 | 事实用途 | 新项目处理 |
| --- | --- | --- |
| `src/main.ts` | 按窗口 label 装载 renderer | 改为明确的多入口/路由映射，仅保留三个生产窗口 |
| `src/Translator/*` | 翻译窗 UI、状态、缓存和翻译流程 | UI/交互优先复用；异步、缓存和 Provider 调度按缺陷清单修正 |
| `src/Setting/*` | 通用、服务、AHK、日志、划词助手设置 | 保留非划词助手页面；划词助手专属设置删除；不扩展空壳 |
| `src/ScreenCapture/App.vue` | 截图选择 UI | 复用视觉和交互，替换 base64/canvas 数据路径与坐标换算 |
| `src/SelectionTranslator/*` | 划词助手 UI | 不迁移 |
| `src/Plugins/Translator/*` | 11 个翻译 Provider | 复用协议语义、字段和解析测试；请求执行迁到 Main adapter |
| `src/Plugins/OCR/*` | 3 个 OCR Provider | 保留百度、腾讯、Custom；请求执行迁到 Main adapter |
| `src/Configuration.ts` | 配置字段和默认行为 | 作为 schema 迁移输入；移除助手字段的激活，不复用非原子持久化方式 |
| `src/Background/BaseBackground.ts` | 旧 renderer 对宿主能力的抽象 | 可用作能力盘点，不照搬“万能 bridge”接口 |
| `src/Background/Tauri.ts` | 旧 Tauri 宿主适配 | 仅作行为参照；不得复制其广泛文件/网络/shell 权限 |
| `src/Background/Electron.ts` | 全 stub | 不复用为实现完成度；用最小 preload API 取代 |
| `src-tauri/src/window.rs` | 窗口创建、显示、定位 | 迁移行为，不直接移植框架 API |
| `src-tauri/src/event_handle.rs` | action 路由 | 映射到 Main 的固定 allowlist |
| `src-tauri/src/ahk.rs` | `--hook` 子进程管理 | 在 Rust helper 中保留 supervisor/worker 隔离思路并修复生命周期 |
| `src-tauri/src/ahk_worker.rs` | DLL 加载、`rust_callback` | 移入 x64 helper worker，补齐 ABI、路径和线程安全验证 |
| `src-tauri/src/get_selected_text.rs` | UIA 与复制回退 | 保留策略，重写完整 `IDataObject` 快照/恢复和超时隔离 |
| `src-tauri/tauri.conf.json` | 旧标识、资源与窗口参考 | 仅作迁移输入；其中宽泛 CSP/allowlist 不得带入 Electron |

### 4.3 可复用与不得直接复用

**优先复用：**

- Vue 组件的布局、文案、图标、样式和已有交互；
- Translator/Setting/ScreenCapture 的业务状态名称和用户配置语义；
- 11+3 Provider 的请求签名、响应解析和配置字段（需测试后迁移）；
- 用户 `script.ahk` 的完整文本和同名 `rust_callback` 合约；
- `ahk.rs` supervisor→`--hook` worker 的崩溃隔离思路；
- `get_selected_text.rs` 的 UIA 优先、复制回退顺序。

**不得直接复用：**

- `Electron.ts` stub 作为通用高权限 bridge；
- renderer 任意文件系统、shell、网络或任意 channel 调用能力；
- 全屏 PNG→base64→renderer canvas→base64 路径；
- 当前剪贴板仅保存文本或无条件覆盖恢复的做法；
- 已证实的并发、缓存、DPI、自启动、AHK 生命周期等缺陷；
- 旧 Tauri CSP 中 `default-src *`、`unsafe-eval` 等宽松策略。

---

## 5. 版本与发布基线

### 5.1 截至方案日期的快照

| 组件 | 方案基线 | 约束 |
| --- | --- | --- |
| Electron x64 | 43.2.0 | Chromium 150.0.7871.129 / Node 24.18.0；实施开始重新查 stable 后精确锁定 |
| AutoHotkey v2 官方版 | 2.0.26 stable | 用于语法/行为兼容参考，不等同于 AutoHotkey_H DLL ABI |
| AutoHotkey_H | 2.0.25 stable | 必须使用 x64；实施时锁二进制哈希、来源、许可文本和 ABI 测试结果 |
| 仓库现有 DLL | 确切版本未知 | 内含字符串仍有 `v2.0-beta.1`；不得仅凭字符串认定版本 |
| 安装包 | NSIS（建议） | 首版 Windows x64 安装版；便于自启动、升级、卸载回归 |

### 5.2 版本锁定门禁

实施开始时必须完成：

1. 从官方 release/docs 检查最新 stable 和最低 Windows 版本；
2. 锁定 Electron 及打包器精确版本，提交 package lockfile；
3. 锁定 Rust toolchain、Cargo.lock 和 Windows SDK 版本；
4. 记录 helper.exe、AutoHotkey_H x64 DLL、默认 AHK 脚本的 SHA-256；
5. 对 DLL 导出（至少 `NewThread`、`ahkReady` 及 callback 调用约定）做 x64 ABI smoke test；
6. 在 Windows 10/11 真机运行完整 AHK 脚本。仓库旧 DLL 与 2.0.25 升级候选都要测，依据结果选择，不能按文件名或内嵌字符串猜版本；
7. 把 Electron/Chromium/Node、helper、AHK_H 的最终组合写入构建产物版本信息。

---

## 6. 目标架构

### 6.1 进程关系

```text
用户/全局热键
      │
      ▼
AutoHotkey_H x64 DLL
（仅 helper --hook worker 加载）
      │ rust_callback(action)
      ▼
Rust helper supervisor ───── UIA / IDataObject / SendInput / WGC
      │ 版本化、带 request id 的 IPC
      ▼
Electron Main ───── Provider 网络 adapter / 配置 / 窗口 / 托盘 / 自启动
      │ 固定 channel + schema 校验
      ▼
安全 preload（最小、冻结 API）
      │
      ▼
Vue renderer：translator / setting / screen-capture
```

Main 启动一个 helper supervisor；为保留现有隔离价值，supervisor 再启动同一 helper 的 `--hook` worker 加载 DLL。Main 永远不加载 DLL。若 spike 证明 supervisor 与 `--hook` 可安全合并，也仍必须保持 DLL 在 Electron 之外；任何简化都不能削弱崩溃隔离和退出清理。

### 6.2 目录建议

以下是后续实现目录建议，不要求在文档落地阶段创建：

```text
<repo-root>/
├─ REFACTOR_PLAN.md
├─ electron/
│  ├─ main/
│  │  ├─ windows/          # translator/setting/screen-capture
│  │  ├─ ipc/              # channel 注册、schema、sender 校验
│  │  ├─ network/          # 11+3 Provider adapters
│  │  ├─ config/           # schema、原子写、copy-only migration
│  │  ├─ helper/           # helper 启停、握手、请求取消
│  │  └─ startup/          # tray、single instance、login item
│  └─ preload/
│     ├─ translator.ts
│     ├─ setting.ts
│     └─ screen-capture.ts
├─ renderer/
│  ├─ shared/
│  ├─ translator/
│  ├─ setting/
│  └─ screen-capture/
├─ native-helper/
│  ├─ src/                 # ipc、uia、clipboard、capture、ahk、worker
│  └─ Cargo.toml
├─ resources/
│  └─ win32-x64/
│     ├─ native-helper.exe
│     ├─ AutoHotkey_H.dll
│     └─ default-script.ahk
└─ tests/
   ├─ contract/
   ├─ provider/
   └─ windows/
```

helper、DLL、默认脚本必须作为 **ASAR 外部资源**打包（例如打包器 `extraResources`），不得依赖开发目录、`cwd` 或从 ASAR 内直接加载。

### 6.3 各层职责

| 层 | 负责 | 明确不负责 |
| --- | --- | --- |
| Electron Main | 单实例、三窗口、托盘、登录项、配置、迁移、Provider 网络、helper 生命周期、action 路由 | 不解析任意 renderer 命令；不加载 AHK DLL；不渲染业务 UI |
| preload | 将少量强类型业务方法桥接给指定窗口；参数/返回值收窄；事件退订 | 不暴露 `ipcRenderer`、`require`、文件系统、shell、任意 URL fetch |
| Vue renderer | 视觉、输入、结果展示、截图选区交互 | 不持有 Node 权限；不直接请求第三方；不决定本机文件路径；不接收密钥日志 |
| Rust helper supervisor | 与 Main 握手、原生请求调度、超时/取消、worker 管理、WGC/UIA/clipboard | 不访问互联网；不信任 action 或脚本输出；不决定应用窗口策略 |
| helper `--hook` worker | 安全路径加载 AutoHotkey_H x64，注入 `rust_callback`，执行完整 AHK 脚本并上报 action | 不直接控制 Electron；不接受 allowlist 外 action；不写应用配置 |

### 6.4 Main↔helper IPC

采用有消息边界的本地 IPC（Windows named pipe 或等价的长度前缀 framing），协议首版固定为 `v: 1`。不得把混杂日志的 stdout 行直接当可信协议。控制消息最少包含：

```json
{"v":1,"id":"uuid","type":"selection.get","deadlineMs":1500,"payload":{}}
{"v":1,"id":"uuid","ok":true,"result":{"text":"...","method":"uia"}}
{"v":1,"event":"action","action":"selection_translate"}
```

要求：

- 启动握手返回 helper 版本、架构、协议版本、能力位、DLL SHA-256/探测版本；不匹配则 fail closed；
- 请求 id 全局唯一，响应必须匹配未完成请求；重复、迟到或未知响应丢弃；
- 每种 `type` 使用独立 schema、尺寸上限和 deadline；
- 图像走带长度与 request id 的二进制帧/共享内存，不嵌进 JSON，不转 base64；
- 支持显式 `cancel`，窗口关闭或新请求覆盖旧请求时传播到 helper；
- helper 事件只允许四个 action，未知字符串不执行，只记脱敏告警；
- pipe 仅允许当前用户会话连接；校验对端进程/随机会话 token，防止本机其他进程伪造动作；
- 日志走独立 stderr/日志通道，绝不与协议 framing 混用。

### 6.5 四个 action 的固定路由

| action | Main 行为 | helper 行为 | renderer 结果 |
| --- | --- | --- | --- |
| `show_translator` | 创建或显示/定位/聚焦 translator | 无额外原生操作 | 聚焦源文本；是否清空按原配置 |
| `screenshot_translate` | 开始截图会话；会话成功后调 OCR→翻译 | 截图、保留原始帧、按物理 ROI 裁剪 | 显示截图 UI；结果进入 translator 并翻译 |
| `selection_translate` | 发起有 deadline 的取词，成功后显示 translator | UIA 优先，失败后受保护的 Ctrl+C 回退 | 填入所选文本并按既有配置翻译 |
| `screenshot_recognizer` | 开始截图会话；只调 OCR | 同上 | 显示识别文本，不擅自追加翻译 |

action 名称是协议常量，不允许脚本构造任意 Main IPC channel、URL、文件路径或 shell 命令。

---

## 7. 窗口与 UI 保真

### 7.1 翻译窗口

Main 创建 translator 时采用：

- 初始 **content size 为 450×230 DIP**，使用 `setContentSize(450, 230)` 表达内容区，不用 outer size 猜边框；
- `frame: false`、`transparent: true`，背景透明；
- 8px CSS 圆角；窗口内容留出阴影安全边距，避免透明窗口边界裁掉阴影；
- 保留原拖拽区，拖拽容器使用 `app-region: drag`，输入框、按钮、滚动区必须 `app-region: no-drag`；
- 关闭按钮按旧行为隐藏到托盘/隐藏窗口，真正退出只由明确“退出”流程触发；
- `blur` 时读取 Main 的 pinup 状态：未 pinup 才隐藏；pinup 时保持可见并同步 always-on-top 语义；
- 设置、上下文菜单等应用内交互造成的短暂失焦不得误隐藏，使用受控弹层计数/窗口关系，而不是任意延迟猜测；
- 显示位置保留 `right-top`、`center`、`last`、`mouse` 等旧配置语义，并确保窗口完整落在当前工作区。

Windows 11 可利用系统阴影/圆角能力，但不能依赖其作为唯一实现。Windows 10 必须用 CSS `border-radius: 8px` 与 `box-shadow` 提供可接受兜底，并在透明窗口、远程桌面和不同缩放下检查黑边/锯齿。

### 7.2 内容自动变高

renderer 在翻译根内容节点使用 `ResizeObserver`，而不是每次翻译结果后手工猜高度：

1. 观察稳定的内容容器 border box；
2. 把 CSS 像素高度经 preload 上报为 DIP 高度；Electron renderer CSS px 与窗口 DIP 在本约定下同单位，**不得乘 `devicePixelRatio`**；
3. preload 只暴露 `setTranslatorContentHeight(heightDip)`；
4. Main 校验数值、去抖/合帧、向上取整，仅在差值至少 1 DIP 时调用 `setContentSize(450, nextHeight)`；
5. 高度下限 230 DIP，上限为当前 display workArea 可用高度；超过上限时固定窗口并在内容区滚动；
6. 调整高度时按窗口定位策略保住顶部或锚点，最后把 bounds clamp 到 workArea；
7. observer 不观察由窗口尺寸本身反向改变的外层节点，防止 resize feedback loop。

**单位规则：**窗口布局、Electron `screen`/BrowserWindow bounds 一律为 DIP；WGC 帧和最终 OCR ROI 一律为物理像素。只在明确的 display 映射边界转换一次。

### 7.3 设置窗口

- 保留现有设置分组、Provider 配置、热键、AHK 编辑、缓存、日志及其他用户可见入口；
- 仅移除第 3 节明确界定的划词助手专属设置；
- Provider 状态以 Main 保存并回读的 canonical 配置为真源，不能由某个表单临时状态覆盖其他 Provider；
- 密钥输入回读时只返回“已配置”和掩码，不把完整密钥广播给所有 renderer；
- AHK 脚本保存必须先写临时文件、校验非空/编码，再原子替换，并由 helper 返回 reload 成功后才显示“已生效”；失败继续运行上一版脚本。

### 7.4 截图 UI

- 保留旧截图遮罩、十字指针、拖选、调整、确认、取消/ESC 等视觉与交互；
- 多显示器可采用每 display 一个 overlay 或一个覆盖虚拟桌面的受控方案，但每个 overlay 必须携带明确 display id 与 DIP/物理映射；
- renderer 只提交选区几何，不通过 canvas 导出 OCR 图；
- 关闭截图窗口、按 ESC、再次触发截图或应用退出都必须取消旧会话并释放 WGC frame、共享内存和 transferable buffer；
- secure desktop、DRM/受保护内容无法捕获时返回明确“系统限制”，不返回黑图后继续 OCR。

---

## 8. AutoHotkey_H 与 native helper

### 8.1 保留现有可用链路

旧链路 `ahk.rs`→`--hook` 子进程→`ahk_worker.rs`→AutoHotkey_H DLL→`rust_callback` 已证明架构方向可用。新实现保留以下合约：

- 用户完整 `script.ahk` 基本原样送入 AutoHotkey_H；
- helper 注入的原生回调名称仍是 **`rust_callback`**；
- callback 输出/上报 action 名字不变；
- x64 helper 只加载 x64 DLL，首版不携带或自动选择 x86 DLL；
- Main 只接收经过 helper allowlist 的四个 action。

允许的脚本改动仅限实现同名 callback 所需的受控 bootstrap、编码/BOM 兼容和已验证的 AutoHotkey_H 2.0.25 语法差异。不得重新生成或简化用户完整热键脚本。

### 8.2 `AltTab` 与 `#HotIf` 限制

AutoHotkey 的 Alt-Tab 特殊 hotkey 不是普通 `Send "!{Tab}"` 的同义替换，且其上下文行为受版本和定义方式限制；尤其不能假定 `#HotIf` 会像普通热键一样约束所有 AltTab 特殊动作。实施时必须基于最终锁定的 AutoHotkey_H 版本验证完整脚本：

- 保持原脚本定义顺序与上下文，不自动把 AltTab 改写成普通 action；
- 对 `#HotIf` 下普通 hotkey、组合键和 AltTab 特殊动作分别测试；
- 无法受 `#HotIf` 正确约束的组合应在设置校验中明确提示“该组合不支持此上下文”，不得静默变成全局热键；
- 以官方 v2 Hotkeys/HotIf 文档和 AutoHotkey_H 实测为准，不能只通过官方 AutoHotkey.exe 语法检查推断 DLL 行为。

### 8.3 callback 与线程队列

AutoHotkey_H 可能从 DLL 自有线程调用 `rust_callback`。callback 必须：

- 使用与 DLL ABI 完全一致的 calling convention 和 UTF-16 参数定义；
- 只做空指针检查、受限长度复制和无阻塞 enqueue；
- 不进行 JSON 序列化、日志 I/O、窗口操作、等待锁或 IPC 写；
- 不允许 panic/unwind 穿过 FFI 边界；队列满时计数并丢弃，不能阻塞 DLL 线程；
- 由 helper 单独消费线程解码、校验 action allowlist、加序号，再发送给 Main；
- 对 action 去抖只按既定用户语义实施，不能吞掉两个真实、相邻的热键动作。

### 8.4 DLL 路径与打包安全

- helper、DLL、默认脚本放在 ASAR 外、只读安装资源目录；用户可编辑脚本放在 userData，DLL 不从 userData 加载；
- 从 `process.resourcesPath` 派生绝对路径并 canonicalize；Main 把绝对 helper 路径传给 spawn，helper 再从自身可信目录定位 DLL；
- Windows 使用安全 DLL 搜索策略（如 `SetDefaultDllDirectories`/`LoadLibraryEx` 的受限搜索 flag），不得使用当前工作目录或 PATH 搜索；
- 启动前验证文件存在、x64 PE 架构和构建清单 SHA-256；签名策略确定后同时校验签名；
- 拒绝 UNC、可重解析到资源目录外的路径和任意脚本提供的 DLL 路径；
- 日志记录版本/哈希，不记录脚本文本或 action 携带的用户内容。

### 8.5 生命周期

1. Main 获得单实例锁后启动 helper supervisor；
2. helper 完成协议/架构/哈希握手，再按配置启动 `--hook` worker；
3. AHK 启用、禁用或脚本更新必须等候明确 ack，UI 状态以 helper 回读为准；
4. 更新脚本时先验证并启动候选 worker，候选 ready 后切换；失败保留旧 worker，避免“保存成功但热键失效”；
5. worker 非预期退出时 supervisor 上报，采用有上限的退避重启；连续失败停止并提示，禁止无限 crash loop；
6. Main 正常退出先发 shutdown、等待短 deadline，再终止；用 Windows Job Object 的 kill-on-close 或等价机制兜底，确保 supervisor/worker 不残留；
7. 崩溃恢复和下次启动检查只处理由本应用创建且携带会话 token/job 的进程，不按进程名误杀其他程序；
8. AHK 即时启停、连续重载、helper 崩溃、Main 强退和系统注销均进入回归矩阵。

### 8.6 AutoHotkey_H 版本与 GPL-2.0 风险

官方 AutoHotkey v2 2.0.26 与 AutoHotkey_H 2.0.25 不是同一二进制；仓库 DLL 的确切版本未知，内含 `v2.0-beta.1` 字符串也不足以证明版本。升级必须做导出、calling convention、Unicode、callback、完整脚本和 Windows 真机测试。

AutoHotkey_H 仓库标注 GPL-2.0，随安装包分发 DLL、由自有 helper 动态加载并注入 callback 可能产生源代码提供、许可文本、修改披露或组合/衍生作品判断风险。独立进程不自动消除“共同分发”义务。发布前必须由有权人员完成许可审查，保存 DLL 来源、对应源码版本、构建方式、版权/许可文本和第三方清单，并按审查结论履行义务；未完成许可门禁不得发布。本文不替代法律意见。

---

## 9. Windows 取词设计

### 9.1 UI Automation 优先

`selection_translate` 请求由 helper 的专用原生 worker 执行：

1. 捕获触发瞬间的 foreground window/thread/process 信息；
2. 在正确初始化 COM 的线程查询 focused element；
3. 优先读取 UIA TextPattern/TextPattern2 的 selection range；必要时按既有兼容范围尝试受支持的文本/value pattern；
4. 拒绝密码/受保护字段，限制返回文本长度，空选择视为失败；
5. UIA 成功直接返回 `{method: "uia"}`；不接触剪贴板；
6. UIA 返回“不支持/空/有界超时”时才进入 Ctrl+C 回退。

UIA 调用不得运行在 Electron 线程或 AHK callback 线程。每次请求有硬 deadline；COM provider 卡住时可终止隔离 worker并重建，不让 helper supervisor/Main 一起卡死。

### 9.2 完整剪贴板 `IDataObject` 保存与恢复

Ctrl+C 回退必须保护**完整剪贴板**，不能只保存纯文本：

1. 串行化本应用的所有复制回退，记录 `GetClipboardSequenceNumber`；
2. 使用 OLE `OleGetClipboard` 获取 `IDataObject`，枚举可用格式并物化为 helper 自有快照，覆盖文本、HTML、RTF、图片、文件列表和自定义格式可获得的 `TYMED`；不能只长期持有可能延迟渲染/随源进程失效的裸指针；
3. 对无法安全物化的格式记录“不可完整快照”，此时默认中止 Ctrl+C 回退并提示，而不是冒险破坏用户剪贴板；
4. 设置唯一哨兵/记录 sequence，用 `SendInput` 发送完整的 Ctrl down、C down/up、Ctrl up 序列；所有退出路径都释放按键；
5. 在短轮询期限内等待 sequence 变化和可读 Unicode 文本，不能把复制前旧文本误判为结果；
6. 在 `finally` 中用自有 `IDataObject` 调 `OleSetClipboard` 恢复全部格式；按 OLE 生命周期正确持有对象，必要时 `OleFlushClipboard`；
7. 若 Ctrl+C 后用户/其他应用再次改变剪贴板（sequence 不再是本次预期值），不得用旧快照覆盖新内容，应跳过恢复并返回明确状态；
8. 打开剪贴板失败采用有界退避，总时长受请求 deadline 控制；不得无限重试；
9. 选中文本、剪贴板内容和快照绝不写日志，快照在请求结束后立即释放。

### 9.3 SendInput/UIPI 和已知边界

`SendInput` 受 UIPI 限制：普通权限应用通常不能向更高完整性级别（例如“以管理员运行”的编辑器）注入 Ctrl+C，且该 API 不一定返回足够信息区分所有阻断。首版不得为解决这一点让整个 Electron/helper 常驻提权。行为应为：

- UIA 可读则仍成功；
- UIA 不可读且复制 sequence 未变化时返回 `uipi_or_copy_blocked`/超时类错误；
- UI 明确说明“目标应用权限更高或不支持取词”，不伪造空翻译；
- 密码框、受保护浏览器/PDF、远程桌面、游戏/反作弊等场景列为受限或不支持并实测；
- helper 超时/崩溃可重启，本次请求失败但 Electron 和用户剪贴板应保持可用。

---

## 10. 截图与 OCR 数据路径

### 10.1 当前瓶颈

旧路径是：**整屏 PNG → base64 → renderer → canvas → 再次 base64**。其问题包括：

- base64 约 33% 体积膨胀并产生大字符串/多次复制；
- renderer 解码整屏、canvas 绘制、ROI 再编码，CPU 与峰值内存随 4K/多屏迅速放大；
- OCR 前同一图像跨 Rust/IPC/JS 多次编码；
- 坐标在 DIP、物理像素和 canvas scale 间重复换算，已出现重复 scale 风险；
- 请求没有贯穿 capture→OCR→translate 的取消语义。

新链路不得保留上述 base64 中转。

### 10.2 WGC 优先，并与 `desktopCapturer` 做 Windows spike

默认目标是在 Rust helper 使用 Windows Graphics Capture：

- WGC 保留物理像素帧，适合 helper 原生裁剪并隔离 Windows API；
- 实施第一阶段同时做 Electron `desktopCapturer` spike，不能只凭架构偏好决定；
- 在 Windows 10/11、1080p/4K、多屏混合 DPI、负坐标和 HDR 上比较冷/热启动时延、峰值内存、复制次数、颜色、黑屏/权限兼容、取消与资源释放；
- 选择 WGC 作为首选；只有 `desktopCapturer` 在全部门禁上有可复现优势时才允许变更，并记录决策。无论选择哪条，仍须满足二进制传输、物理 ROI 原生裁剪和无全屏 base64；
- WGC 不可用/被系统策略阻止时是否允许 `desktopCapturer` 作为 fallback，由 spike 结果明确，不能运行时随机选择。

### 10.3 新数据流

```text
helper 捕获物理帧（BGRA/适当 HDR 格式）
  ├─ 保留短生命周期原始帧供 ROI 裁剪
  └─ 生成一次预览二进制 → framed IPC/共享内存 → Main
                                      │
                           transferable ArrayBuffer/MessagePort
                                      ▼
                              renderer 仅显示和选区
                                      │ 选区 DIP + display id
                                      ▼
helper 按 display 映射换算并在原始物理帧裁剪 ROI
                                      │ ROI bytes
                                      ▼
Main OCR adapter：仅在目标 Provider 必需时编码/转 base64
```

具体要求：

- Main↔renderer 使用 binary/transferable buffer；renderer 用 Blob/object URL 或经验证的零/少复制方式显示，不拼 data URL；
- renderer 不用 canvas 导出 OCR 输入；可用 canvas 画遮罩，但不能承担最终裁剪/编码；
- helper 在保留的物理帧上裁剪 ROI，先校验边界、宽高、总字节和 request id；
- 百度/腾讯/Custom adapter 根据各自协议选择 PNG/JPEG/raw/multipart；只有 Provider 明确要求文本 base64 时在 adapter 边界编码一次；
- 每个截图会话有 id，新的截图 action、ESC、窗口关闭和应用退出都取消旧会话；
- OCR 和后续翻译使用 `AbortController`/helper cancel 贯穿，迟到响应不得覆盖新结果；
- buffer/共享内存有上限和释放确认，重复截图不得单调增长内存。

### 10.4 DPI、负坐标与 ROI

- Electron 窗口及 pointer 几何使用 DIP；WGC/原生帧使用各显示器物理像素；
- 建立稳定的 display 映射：Electron display id/bounds/scaleFactor 与 helper 的物理 monitor bounds 对应；
- 单屏转换公式为 `physicalOrigin + round((dipPoint - dipOrigin) * scaleFactor)`；不得对虚拟桌面全局负坐标直接乘一个 scale；
- 跨屏选区按显示器拆分后分别转换/裁剪，再按物理布局合成；混合 DPI 时不能用主屏 scale；
- 对左侧/上方的负坐标显示器测试选择、拖拽、窗口定位和最终像素；
- 明确边缘取整规则（左/上 floor，右/下 ceil，再 clamp），避免漏一列像素或越界；
- 移除旧链路中 renderer 与 native 各乘一次 scale 的重复缩放。

### 10.5 HDR 与颜色

WGC 可能返回 HDR/scRGB 内容。OCR 与普通 renderer 预览前要按 Windows 色彩空间信息做一次确定的 SDR sRGB 转换/色调映射，避免文字对比度下降和洗白。至少测试 HDR 开/关、HDR 主屏+SDR 副屏、跨屏 ROI；记录源格式与转换路径但不记录截图内容。受保护内容返回明确不支持。

### 10.6 OCR 范围

只保留：

1. 百度 OCR（`baidu`）；
2. 腾讯 OCR（`tencent`）；
3. Custom OCR（`custom`）。

不得在本轮擅自增加本地 OCR、Windows OCR、Tesseract 或其他云 Provider。OCR 调度必须确定性使用配置的 `round`/`concurrent`/`first` 语义；修复随机 Provider 和 auto-copy 错误，详见第 14 节。

---

## 11. Provider 与网络迁移

### 11.1 翻译 Provider（11 个）

以下 ID 必须保持可迁移，不以 UI label 替代稳定 ID：

| # | 稳定 ID | 旧文件 | 实施要点 |
| --- | --- | --- | --- |
| 1 | `youdao` | `Translator/Youdao.ts` | 签名、语言码、词典/翻译响应实测 |
| 2 | `baidu` | `Translator/Baidu.ts` | token/签名缓存与过期、并发刷新只允许一个 |
| 3 | `tencent` | `Translator/Tencent.tsx` | 签名 canonicalization、时钟/region 错误分类 |
| 4 | `google` | `Translator/Google.ts` | 官方 Cloud API、API key 和语言码 |
| 5 | `google-free` | `Translator/GoogleFree.ts` | 非正式/未承诺端点，必须 Windows 安装版在线实测 |
| 6 | `bing` | `Translator/Bing.ts` | 现用 edge/非正式行为可能变化，token/header 流程实测 |
| 7 | `openai` | `Translator/OpenAI.ts` | 自定义 base URL、模型、响应/错误兼容；URL 严格校验 |
| 8 | `gemini-pro` | `Translator/GeminiPro.ts` | API 版本、模型可用性和安全错误实测 |
| 9 | `deepl` | `Translator/DeepL.ts` | 官方 DeepL 与用户 DeepLX URL 分支分别测 |
| 10 | `caiyun` | `Translator/CaiYun.ts` | 现有端点/协议有效性实测；不得无提示降级明文 HTTP |
| 11 | `alibaba-free` | `Translator/AlibabaFree.ts` | 非正式端点/参数易变，必须在线实测并可明确报不可用 |

“迁移”不代表这些第三方端点截至实施日仍然可用。GoogleFree、Bing 的非正式路径、AlibabaFree、用户 DeepLX/自定义 OpenAI 地址及其他未有稳定公开契约的端点必须做真实 Windows 网络测试；失败应显示 Provider 级错误并保持其他 Provider 可用，不得伪造成功或私自替换为另一服务。

### 11.2 OCR Provider（3 个）

| 稳定 ID | 旧文件 | 实施要点 |
| --- | --- | --- |
| `baidu` | `OCR/Baidu.ts` | token 单飞刷新、过期重试一次、图片格式/尺寸限制 |
| `tencent` | `OCR/Tencent.ts` | 签名、物理 ROI bytes、错误码映射 |
| `custom` | `OCR/Custom.tsx` | 用户 URL/headers/body 模板受限校验；保留旧能力，不扩大为任意系统请求器 |

### 11.3 Main 网络 adapter

第三方请求统一在 Electron Main 执行以规避 renderer CORS，但“规避 CORS”不能变成开放代理：

- preload 只接受 Provider ID、标准化业务参数和 request id，不接受任意 method+URL；
- adapter 在 Main 内组装 URL、header、签名和 body；Custom/自定义 base URL 仅允许对应 Provider 的已定义字段；
- URL 只允许 `https:`，确因旧端点只能 HTTP 时必须显式风险提示与单独兼容决定，不全局放开；拒绝 `file:`、`javascript:`、loopback、link-local、私网和凭据内嵌 URL，除非 Custom 的明确产品能力经确认需要本地地址并有单独开关；
- 设置连接、总请求、响应体大小和重定向上限；重定向后再次校验目标；
- 每次请求关联 `AbortController`；窗口关闭、重试替代、组任务取消时真正 abort socket/读取；
- 标准返回 `{providerId, requestId, ok, data/error, timing}`，renderer 不解析供应商密钥或原始敏感 header；
- 系统代理、TLS/企业证书行为在安装版实测；不得通过关闭证书校验“修复”网络；
- Provider 凭据只在相应 adapter 使用，日志、错误对象、崩溃报告和 IPC 均脱敏。

### 11.4 Provider 合同测试

每个 Provider 至少覆盖：配置校验、语言检测（若支持）、普通翻译、词典（若支持）、错误凭据、超时、取消、限流、空响应、畸形响应和脱敏日志。正式端点用 mock/录制的脱敏 fixture 做确定性 CI，再用受控测试账号做 Windows 安装版 live smoke；非正式端点没有 live smoke 通过不得标记“可用”。密钥不得进入仓库或测试快照。

---

## 12. 配置、脚本与缓存迁移

### 12.1 原则

- 迁移是 **copy-only**：旧目录、文件、时间戳和内容不被修改、删除、改名或锁定；
- 首次启动先复制到新 userData 下的只读 migration staging，再从 staging 解析；
- 迁移可重复执行但结果幂等；完成标记只写新目录；
- 源定位以旧 bundle identifier `com.danger-dream.tosa` 和旧 Tauri `appConfigDir` 的实际 Windows 解析结果为准。实施 spike 要在旧安装上输出该路径并固化测试，禁止全盘搜索用户文件；
- 新应用在 `app.whenReady()` 前设置稳定 app name/userData 规则，升级不得改变路径；
- 任何失败只影响该类数据，保留 staging 和脱敏报告，旧应用仍可启动。

### 12.2 迁移步骤

1. 检测新目录是否已有用户数据；已有数据不自动覆盖；
2. 解析固定的旧目录候选，记录源路径、文件尺寸和 SHA-256（不记录内容）；
3. 将已识别的配置、`script.ahk`、缓存复制到随机 staging 目录；防符号链接/重解析点逃逸；
4. 逐类校验 schema、编码、尺寸和 Provider ID；
5. 配置映射到版本化 canonical schema；未知字段保存在 migration metadata，不注入运行时；
6. 划词助手专属字段归档但不激活；四个 action、Provider、pinup、窗口位置、超时、缓存、AHK 等保留字段映射；
7. `script.ahk` 保持原字节/换行副本，另生成 helper 运行所需的受控包装；不得改写源副本；
8. 缓存只导入可校验、未过期、键完整的记录；坏记录跳过并计数，不让一个损坏项阻断全部迁移；
9. 写入新目录后重新读取并校验，再原子发布；
10. 写迁移 marker（schema、源哈希、时间、每类成功/跳过计数），重复启动不再次覆盖用户新修改。

### 12.3 原子写

配置、脚本和缓存索引均采用同目录临时文件→flush→必要时 `fsync`/`FlushFileBuffers`→原子 replace/rename→目录/备份策略的流程。Windows 上处理杀毒软件短暂占用并做有界重试；发布失败保留旧有效文件，不留下半截 JSON。建议保留一个上一版 `.bak`，恢复后也必须经 schema 校验。

Main 是配置真源：renderer 提交带 `expectedRevision` 的 patch，Main 校验、原子持久化后增加 revision 并广播 canonical snapshot。并发窗口写同一字段发生 revision 冲突时回读/重试，不采用多个 renderer 各自 deep-watch 后互相覆盖。

### 12.4 密钥与日志

- Provider key、secret、token、自定义 Authorization、选中文本、翻译原文/结果、OCR 图片和剪贴板内容默认不写日志；
- 统一 redaction 层处理 URL query、header、JSON/form 字段和供应商原始错误，不能依赖每个 Provider 自觉脱敏；
- renderer 只获得编辑所需的临时值或掩码状态，其他窗口不广播完整密钥；
- 迁移 staging 与新配置采用仅当前用户可读的 Windows ACL；
- 支持日志中只保留 Provider ID、错误分类、HTTP status、request id、时延和已截断的非敏感消息。

---

## 13. 开机启动、托盘与单实例

### 13.1 安装版自启动

只在打包安装版管理登录项：

```ts
app.setLoginItemSettings({
  openAtLogin: enabled,
  path: process.execPath,
  args: ['--autostart']
})
```

读取时必须传入完全相同的 `path: process.execPath` 和 `args: ['--autostart']` 调用 `app.getLoginItemSettings(...)`，并以 Windows 返回的实际可启动/启用状态为 UI 真值，而不是只读配置文件中的布尔值。

要求：

- 固定安装路径下使用 `process.execPath`，不硬编码开发路径、版本号目录或 Electron.exe；
- 只识别完整参数 `--autostart`，避免前缀/任意参数触发；
- 自启动时先取得单实例锁，只创建 Main/托盘/helper，不显示 translator、setting、screen-capture，不抢焦点；
- 正常手动启动可按旧行为显示/保持托盘；第二实例把意图发送给首实例后退出；
- 开发版、未安装便携运行不修改登录项，并在 UI 明确“不支持/仅安装版可用”；
- Windows 任务管理器禁用启动项后，设置页必须回读真实 OS 状态，不得在每次启动时擅自重新启用；只有用户明确切换开关才写；
- 升级后验证 `process.execPath` 与注册项一致；卸载后不得残留启动项；
- NSIS 是首版建议安装包，安装、覆盖升级、降级拒绝策略、卸载和残留清理都做真机回归。

### 13.2 托盘与退出

- 关闭生产窗口不等于退出；托盘菜单保留显示翻译、设置和退出等旧可见能力；
- “退出”进入单一 shutdown 状态：停止接收 action→取消网络/截图/取词→停止 AHK worker/helper→销毁 tray/windows→退出；
- 系统注销/关机使用短 deadline，不弹阻塞对话框；Job Object 兜底清理；
- helper 未 ready 时托盘状态可提示，但不得让 renderer 获得重启任意进程能力。

---

## 14. 已证实缺陷：不得照搬及修复门禁

| 已证实问题 | 新实现规则 | 决定性测试 |
| --- | --- | --- |
| 并发检测结构错误 | 检测任务使用显式 request/group id；定义 first-success、majority 或 order 的终止条件；失败与取消分开 | 多 Provider 快慢/失败/取消排列，结果只完成一次，无未处理 rejection |
| detect 的 id/name/字段混用 | stable Provider ID、显示 label、语言结果字段分型；adapter 边界规范化 | 同名 label、改名 label、旧配置迁移后仍路由正确 |
| 词典 fallback 缺少 `await` | fallback 纳入同一 async/AbortSignal，错误可捕获，返回统一结果 | 主词典失败、fallback 成功/失败/取消均无 Promise 泄漏 |
| 百度 token 处理错误 | token 按凭据+服务隔离缓存；过期时间留安全余量；并发单飞；鉴权失败最多刷新重试一次 | 20 并发仅一次取 token；过期/错误凭据不死循环 |
| random OCR / auto copy 错误 | OCR 严格按 `round`/`concurrent`/`first` 配置确定性调度；auto-copy 仅配置启用且最终成功时执行一次 | 固定配置重复 100 次顺序可预测；失败/取消不改剪贴板 |
| 请求无法 abort | capture、OCR、translate、重试均接受同一取消信号；新任务/关闭窗口传播 abort | 慢服务取消后连接终止，迟到结果不改 UI、不写缓存 |
| 缓存多处错误 | Main 单一缓存服务；key 至少含 provider ID、能力、源/目标语言、规范化输入和影响结果的模型/配置版本；写入原子化 | 命中/过期/容量/天数/词典保留/并发写/损坏恢复测试 |
| 配置写入非原子 | revision patch + schema + 临时文件原子替换；失败保留上一版 | 写到一半 kill/power-failure 模拟后仅出现旧或新完整配置 |
| 剪贴板恢复不完整 | UIA 优先；fallback 使用完整 `IDataObject` 快照和 sequence 冲突保护 | 文本+HTML+图片+文件列表+自定义格式往返；用户中途复制不被覆盖 |
| DPI 重复 scale | Electron UI 全程 DIP；helper frame/ROI 物理像素；按 display 仅转换一次 | 100/125/150/200% 与混合 DPI 像素级 ROI 对照 |
| AHK 即时启停/退出残留 | helper ack 才更新状态；候选 worker ready 后切换；shutdown+Job Object | 连续启停/重载、Main crash、注销后无残留 worker/热键 |
| 设置 Provider 状态错误 | Main canonical config 为真源，Provider ID 独立 revision；表单保存后回读 | 编辑 A 不改变 B；多设置窗口冲突可检测；重启一致 |

另外：重试必须受总 deadline 和最大次数约束；不能因网络重试绕过用户取消。缓存不得保存取消、错误、空畸形响应或包含未脱敏凭据的对象。

---

## 15. Electron 安全基线

所有 BrowserWindow 默认：

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  preload: trustedAbsolutePath
}
```

并落实：

1. renderer 不使用 `remote`、`@electron/remote`、`eval`、`new Function` 或启用 Node 的 webview；
2. preload 通过 `contextBridge.exposeInMainWorld` 暴露冻结的按窗口 API；不暴露 `ipcRenderer.send/invoke/on` 本体，不接受任意 channel；
3. Main 对每个 IPC 做 schema、长度、枚举和 senderFrame/origin/window 身份校验；仅相应窗口可调用相应能力；
4. 生产 UI 只加载打包的本地资源；开发服务器仅开发模式。导航和 `window.open` 默认拒绝；确需外链时只允许固定 `https:` 域并经 Main `shell.openExternal` 二次校验；
5. 设置严格 CSP，至少以 `default-src 'self'` 为起点；按构建产物最小化增加 `style-src`/`img-src`，生产禁止 `unsafe-eval`、通配 script/connect；第三方网络由 Main 发起，不开放 renderer `connect-src *`；
6. 默认拒绝所有 permission request/check（摄像头、麦克风、通知、地理位置、USB 等），截图不通过网页媒体权限随意授权；
7. 不关闭 TLS 校验，不忽略 certificate error，不启用 mixed content；
8. 自定义协议若使用，必须标准 scheme、路径归一化、防目录穿越，且不能读取任意本地文件；
9. 机密只在 Main adapter/受限配置层存在；renderer 错误和 DevTools 不含 token；生产默认不开 DevTools；
10. Electron、Vue、构建工具依赖精确锁定并检查安全公告；移除不需要依赖；
11. ASAR 不是安全边界。helper/DLL 的外置资源通过路径、ACL、哈希/签名和打包清单保护；
12. 发布前按 Electron Security Checklist 逐项验证，特别是导航、新窗口、IPC sender、CSP、sandbox 和外部内容。

---

## 16. 分阶段实施与门禁

每阶段必须交付可运行的纵向行为或决定性 spike 证据；不能以“建立框架/adapter”替代该阶段行为验收。

### 阶段 1：Windows 高风险 spike（最先执行）

目标是在大规模 UI 迁移前消除不可逆风险：

- Electron 最终候选 stable 在 Windows 10/11 x64 的透明无边框、阴影、`setContentSize`、tray 基础验证；
- Rust x64 helper 握手、超时、取消、Job Object 清理；
- 旧 DLL 与 AutoHotkey_H 2.0.25 候选的导出/ABI/完整脚本/四 action 实测；
- UIA 常见应用取词与完整 `IDataObject` Ctrl+C 回退原型；
- helper WGC 与 Electron `desktopCapturer` 的性能/DPI/HDR/负坐标对比；
- 打包安装版 `setLoginItemSettings` 精确 path+args 写入/读回 smoke；
- 解析旧 Tauri 实际 appConfigDir，冻结迁移源路径规则。

**门禁：**DLL 方案、截图方案、DIP 映射、剪贴板保护、自启动读回均有 Windows 10/11 可复现结果；GPL-2.0 处置路径有明确责任人。任一阻断则先调整方案，不进入全面 UI。

### 阶段 2：UI 保真

- 创建安全 Main/preload/Vue 三窗口纵向链路；
- translator 450×230、透明无边框、8px 圆角、阴影、拖拽、blur/pinup、位置策略；
- `ResizeObserver`→`setContentSize` 内容自动增高；
- setting 与 screen-capture 可见 UI 迁移；
- 删除 selection-translator，保留其他可见空壳语义。

**门禁：**Windows 10/11 和四档 DPI 截图/交互基线通过，无 Node 权限、无通用 IPC。

### 阶段 3：配置与网络

- 版本化配置 schema、revision、原子写和脱敏日志；
- 11 个翻译、3 个 OCR Main adapter；
- 并发检测、词典 fallback、token、abort、Provider 状态和缓存缺陷修复；
- mock contract tests 与可用 Provider live smoke。

**门禁：**11+3 均有明确 pass/fail/unsupported 状态；非正式端点未实测不得标可用；配置 kill 测试通过。

### 阶段 4：helper、AHK 与取词

- 完成版本化 IPC、action allowlist、helper supervisor/`--hook` worker 生命周期；
- 完整 AHK 脚本兼容、即时启停/重载/退出；
- `selection_translate` UIA→完整剪贴板 Ctrl+C 回退接入 translator；
- UIPI、超时、崩溃隔离和日志脱敏。

**门禁：**四 action 全链路可触发；常见应用取词通过；异常退出无 helper/热键残留；剪贴板格式往返通过。

### 阶段 5：截图与 OCR

- 按阶段 1 决策落地 WGC 优先路径；
- transferable binary、物理 ROI 原生裁剪、Provider 边界编码；
- 取消、DPI/负坐标/HDR；
- 百度/腾讯/Custom OCR 和 screenshot translate/recognizer 全链路。

**门禁：**不存在全屏 base64/canvas 再编码；截图性能和像素级 ROI 矩阵通过；重复取消无泄漏。

### 阶段 6：打包、自启动与迁移

- 建议 NSIS x64 安装包、ASAR 外 helper/DLL/script 资源；
- copy-only 配置/script/cache 迁移；
- 安装版自启动、托盘静默、单实例；
- 安装/覆盖升级/卸载/任务管理器禁用回归；
- 第三方许可清单和 AutoHotkey_H GPL-2.0 发布门禁。

**门禁：**干净 Windows 10/11 机器可安装运行卸载，旧数据源哈希不变，自启动实际 OS 状态准确，无残留启动项/worker。

### 阶段 7：完整回归与切换

- 执行第 17 节矩阵；
- 与旧 commit 的 UI/行为基线逐项比对；
- 缺陷清单逐项关闭并保存证据；
- 明确记录受 UIPI、受保护内容、失效非正式端点等真实 unsupported；
- 只有第 18 节完成定义全部满足才可替代旧版。

---

## 17. Windows 验收矩阵

### 17.1 平台与显示矩阵

| 维度 | 用例 | 关键断言/证据 |
| --- | --- | --- |
| OS | Windows 10 x64 最新受支持补丁；Windows 11 x64 当前受支持版本 | 三窗口、helper、AHK、取词、截图、自启动均运行；记录 build number |
| DPI | 100%、125%、150%、200%，每档至少在 Win10/Win11 各一次 | 450×230 DIP 视觉一致；文本不糊；内容增高无反馈循环；ROI 像素正确 |
| 混合 DPI | 主/副屏取 100↔125、100↔150、125↔200 等代表组合 | 跨屏拖动后 scale 更新；窗口不跳；不重复 scale |
| 多屏 | 副屏在左、右、上，含负 X/负 Y；横竖屏；不同分辨率 | overlay 完整，鼠标/选区与物理像素对应，跨屏拆分正确 |
| HDR | HDR 关；HDR 主屏+SDR 副屏；HDR 跨屏 | 预览与 OCR 对比度可用，无明显洗白；记录转换格式 |
| Windows 10 窗口 | 透明、无边框、CSS 8px 圆角/阴影 | 无黑底/裁影，拖拽和输入 no-drag 正确 |

至少保存：系统/DPI/拓扑信息、窗口截图、选区坐标（DIP 与物理）、最终 ROI 尺寸与基准图 diff；证据不得包含用户真实敏感内容。

### 17.2 功能矩阵

| 领域 | 必测用例 | 通过标准 |
| --- | --- | --- |
| translator | 冷启、托盘显示、四种位置、输入、清空、pinup、blur、长结果 | 初始 450×230；自动增高/上限滚动；未 pinup 失焦隐藏，pinup 不隐藏 |
| setting | 全部旧可见非助手入口、保存/取消、并发窗口、重启 | 不静默删空壳、不扩功能；状态回读一致；Provider 互不串值 |
| 划词助手删除 | 启动、托盘、设置、热键、窗口枚举 | 不存在 `selection-translator` 及专属后台逻辑 |
| 四 action | AHK/应用内分别触发 `show_translator`、`screenshot_translate`、`selection_translate`、`screenshot_recognizer` | 路由与第 6.5 节一致；未知 action 被拒绝 |
| 完整 AHK 脚本 | 普通热键、组合键、`#HotIf`、AltTab 特殊动作、Unicode action、快速连按 | 与锁定版本预期一致；不支持组合明确报错；callback 不阻塞/崩溃 |
| AHK 生命周期 | 开/关 50 次、保存重载 50 次、坏脚本、worker crash、Main 强退、注销 | UI 状态准确，旧脚本失败回滚，无 worker/热键残留，无 crash loop |
| 取词常见应用 | Notepad、Office/Word、Chrome/Edge、Firefox、VS Code/Electron、WPF/UWP、常用 PDF 阅读器 | UIA 优先；不支持时复制回退；文本正确，主流程不挂起 |
| 取词边界 | 管理员应用、密码框、远程桌面/受保护页、空选择、目标关闭 | 成功或明确 unsupported/timeout；不提权、不伪造结果 |
| 剪贴板 | Unicode、HTML、RTF、位图、文件列表、自定义格式；复制过程中用户另行复制 | 完整往返；用户新剪贴板不被旧快照覆盖；日志无内容 |
| screenshot UI | 鼠标拖选、调整、ESC、再次触发、每个 display、跨屏 | 无坐标偏移；取消释放会话；无迟到结果 |
| screenshot action | translate 与 recognizer 各走三 OCR Provider | 前者 OCR→翻译，后者仅 OCR；不串 action |
| Provider | 11 翻译+3 OCR：正确配置、错误密钥、超时、取消、限流、畸形响应 | 每个有记录状态；错误隔离；日志脱敏；非正式端点 live smoke |
| 缓存 | 命中、不同 provider/语言/模型、TTL、数量、词典保留、并发写、损坏文件 | key 不串；清理正确；kill 后可恢复；取消/错误不缓存 |
| auto-copy/OCR 调度 | 开关、成功/失败/取消；round/concurrent/first | 仅成功且启用复制一次；调度确定、无随机漂移 |

### 17.3 截图性能门禁

在约定参考机器上分别测试 1080p、4K、双屏混合 DPI，冷/热各 30 次并报告 P50/P95：

- action→overlay 可交互：建议门槛 1080p P95 ≤350ms、4K P95 ≤700ms；若参考硬件无法达到，阶段 1 必须在编码前冻结经双方接受的新预算；
- 确认 ROI→本地 ROI bytes ready（不含网络）：P95 ≤150ms；
- 选区交互无持续掉帧，pointer 反馈目标 60fps；
- Provider 边界前不得出现整屏 base64；renderer 不从 canvas 导出 OCR 图；
- 连续截图/取消 100 次无 handle/shared memory 泄漏；结束 30 秒后私有内存回落且无持续单调增长（允许记录稳定池化基线）；
- 对比 WGC 与 desktopCapturer 的峰值内存、CPU、复制次数和颜色正确性，保存脚本、机器规格和原始测量结果。

### 17.4 自启动/安装矩阵

| 场景 | 断言 |
| --- | --- |
| 干净安装，开/关自启动 | `set` 后用同 path+args `get` 回读；重启系统结果一致 |
| `--autostart` 登录启动 | 只进托盘，不显示三窗口、不抢焦点，helper 按配置 ready |
| 手动启动 + 第二实例 | 单实例；首实例按意图显示，不产生第二 helper |
| 任务管理器禁用启动项 | 设置页反映真实不可启动/禁用状态；下次启动不擅自重启用 |
| 覆盖升级 | 配置/脚本/缓存保留；登录项指向当前 `process.execPath` |
| 卸载 | 登录项、安装资源、helper/worker 均无残留；用户数据按卸载选项策略处理且不碰旧 Tauri 数据 |
| 开发/非安装运行 | 不写登录项，UI 明确仅安装版支持 |

### 17.5 数据迁移矩阵

- 无旧数据：使用新默认，不报错误；
- 完整旧数据：11+3 Provider 配置、四 action、pinup/窗口/超时/缓存/AHK 脚本正确迁移；
- 旧划词助手字段：原始 staging 可追溯，运行时不激活；
- 损坏 JSON、截断缓存、空/非 UTF-8 脚本、超大文件、无权限、重解析点：分项失败且不越界；
- 迁移中 kill：下次可安全重试，无半成品 canonical 文件；
- 重复启动与用户已修改新配置：不覆盖新数据；
- 迁移前后计算旧源 SHA-256，必须完全一致；
- 日志/报告搜索测试密钥与样本文本，必须无泄漏。

---

## 18. 完成定义（Definition of Done）

只有同时满足以下条件，Electron 重构才算完成：

1. Windows 10/11 x64 安装版可稳定运行，最终 Electron/AHK_H/helper 版本和哈希已锁定；
2. `translator`、`setting`、`screen-capture` 三个生产窗口通过 UI/行为基线；translator 达到 450×230 DIP、透明无边框、8px 圆角、阴影、拖拽、blur/pinup 和自动增高要求；
3. `selection-translator` 划词助手已删除，其他可见空壳没有静默删除或扩成新功能；
4. 四个 action 全链路通过；尤其 `selection_translate` 保留 UIA→完整剪贴板 Ctrl+C 回退；
5. Electron Main 未加载 AutoHotkey_H、未使用 Node FFI；DLL 只在独立 x64 helper `--hook` worker 中加载；
6. 完整 AHK 脚本、AltTab/`#HotIf` 代表用例通过，启停/重载/退出无残留；
7. 截图不再走整屏 base64→canvas→base64，采用 binary/transferable、物理 ROI 原生裁剪、按 Provider 必要编码，并通过 DPI/负坐标/HDR/取消/性能矩阵；
8. 11 个翻译 Provider 与百度/腾讯/Custom OCR 均完成 contract test 和明确的 live 可用性结论；非正式端点未实测不冒充支持；
9. 配置 revision+原子写、缓存、abort、token、detect、fallback、auto-copy、Provider 状态等已证实缺陷均有回归证据；
10. copy-only 迁移通过，旧配置/script/cache 源 SHA-256 不变，密钥和用户内容未进入日志；
11. 安装版自启动固定 `process.execPath`+`--autostart`，用相同参数回读真实 OS 状态；托盘静默启动、升级、卸载、任务管理器禁用回归通过；
12. preload 最小化、sandbox/contextIsolation/CSP/sender 校验等 Electron 安全基线通过审查；
13. helper/DLL 为安全路径的 ASAR 外 x64 资源，生命周期和崩溃隔离通过；
14. AutoHotkey_H GPL-2.0 及其他第三方许可发布门禁完成；
15. 本轮没有擅自加入自动更新或新本地 OCR。

任何“主流程仍由 stub/fixture 代替”“只搭好 adapter 但真实 Provider/取词/截图未工作”“仅开发模式可运行”均不满足完成定义。

---

## 19. 主要风险与退出条件

| 风险 | 影响 | 缓解与退出条件 |
| --- | --- | --- |
| AutoHotkey_H DLL 版本/ABI 未知 | callback 崩溃、脚本不兼容 | 阶段 1 对旧 DLL 与 2.0.25 做 x64 ABI+完整脚本真机测试；锁哈希后才进入集成 |
| GPL-2.0 分发义务 | 阻断合法发布 | 发布前许可审查、来源/源码/notice 清单和履约决定完成 |
| UIA provider 或 SendInput/UIPI 受限 | 某些应用无法取词 | UIA 优先、完整复制回退、隔离超时；管理员/受保护场景明确 unsupported，不整体提权 |
| 完整 IDataObject 快照难度 | 破坏用户剪贴板 | 多格式物化和 sequence 冲突测试；不能完整快照时 fail safe，不执行 Ctrl+C |
| WGC/DPI/HDR/多屏差异 | ROI 偏移、黑图、颜色错误 | WGC vs desktopCapturer spike；每 display 单次转换；真机矩阵和像素 diff |
| 透明窗口在 Win10 表现差异 | 黑边、阴影裁切、模糊 | CSS 圆角/阴影兜底，四档 DPI/远程桌面实测 |
| 非正式 Provider 端点变化 | 部分服务不可用 | adapter 隔离、live smoke、明确降级状态；不暗换服务、不扩大范围 |
| 迁移路径或旧数据损坏 | 丢配置/覆盖新数据 | 固定标识解析、staging、copy-only、原子发布、幂等 marker、旧源哈希验证 |
| helper/worker 残留 | 热键占用、无法升级/卸载 | 明确 shutdown、deadline、Job Object、单实例、强退/注销回归 |
| Electron stable 在实施时变化 | 安全/兼容基线过期 | 开工当天复查 stable 和公告，精确锁版本后重跑阶段 1 |

---

## 20. 官方参考资料

以下 URL 用于实施时复核；“latest”页面会随时间变化，最终应同时保存锁定版本页面。

### Electron

- Electron 43.2.0 release：<https://releases.electronjs.org/release/v43.2.0>
- Electron releases / stable：<https://www.electronjs.org/releases/stable>
- Electron release cadence：<https://www.electronjs.org/docs/latest/tutorial/electron-timelines>
- Process Model：<https://www.electronjs.org/docs/latest/tutorial/process-model>
- BrowserWindow：<https://www.electronjs.org/docs/latest/api/browser-window>
- `BrowserWindow.setContentSize`：<https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentsizewidth-height-animate-macos>
- Context Isolation：<https://www.electronjs.org/docs/latest/tutorial/context-isolation>
- `contextBridge`：<https://www.electronjs.org/docs/latest/api/context-bridge>
- Electron Security Checklist：<https://www.electronjs.org/docs/latest/tutorial/security>
- `desktopCapturer`：<https://www.electronjs.org/docs/latest/api/desktop-capturer>
- `screen` 与 DIP：<https://www.electronjs.org/docs/latest/api/screen>
- `app.setLoginItemSettings` / `getLoginItemSettings`：<https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows>
- MessagePorts / transferable：<https://www.electronjs.org/docs/latest/tutorial/message-ports>
- ASAR archives：<https://www.electronjs.org/docs/latest/tutorial/asar-archives>

### Microsoft Windows

- Windows Graphics Capture 概览：<https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture>
- `IGraphicsCaptureItemInterop`：<https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nn-windows-graphics-capture-interop-igraphicscaptureiteminterop>
- Windows UI Automation 入门：<https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32>
- UI Automation TextPattern：<https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-implementingtextandtextrange>
- `SendInput`（含 UIPI 说明）：<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput>
- `IDataObject`：<https://learn.microsoft.com/en-us/windows/win32/api/objidl/nn-objidl-idataobject>
- OLE Clipboard：<https://learn.microsoft.com/en-us/windows/win32/dataxchg/ole-clipboard-operations>
- `GetClipboardSequenceNumber`：<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber>
- High DPI desktop apps：<https://learn.microsoft.com/en-us/windows/win32/hidpi/high-dpi-desktop-application-development-on-windows>
- Dynamic-link library security：<https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-security>
- Job Objects：<https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>

### AutoHotkey / AutoHotkey_H

- AutoHotkey v2 官方下载：<https://www.autohotkey.com/download/2.0/>
- AutoHotkey v2.0.26 release：<https://github.com/AutoHotkey/AutoHotkey/releases/tag/v2.0.26>
- AutoHotkey v2 Hotkeys：<https://www.autohotkey.com/docs/v2/Hotkeys.htm>
- AutoHotkey v2 `#HotIf`：<https://www.autohotkey.com/docs/v2/lib/_HotIf.htm>
- AutoHotkey_H 项目：<https://github.com/HotKeyIt/ahkdll-v2>
- AutoHotkey_H releases：<https://github.com/HotKeyIt/ahkdll-v2/releases>

### 打包建议

- electron-builder NSIS：<https://www.electron.build/nsis.html>

---

## 21. 实施启动检查表

在写应用代码前，只执行以下必要确认：

- [ ] 重新检查并锁定最新 stable Electron/Chromium/Node；
- [ ] 锁定 Windows x64、最低 Windows 10 build、Rust/Windows SDK；
- [ ] 下载/归档 AutoHotkey_H x64 的可信来源、2.0.25 候选、许可和 SHA-256；
- [ ] 在旧安装实测解析 `com.danger-dream.tosa` 的数据路径；
- [ ] 准备 Windows 10/11、四档 DPI、负坐标多屏和 HDR 测试环境；
- [ ] 准备不含真实用户数据的完整 AHK 脚本测试副本；
- [ ] 准备 11+3 Provider 的 mock fixtures 与受控 live test 凭据；
- [ ] 先完成第 16 节阶段 1，门禁通过后再全面迁移 UI；
- [ ] 确认 AutoHotkey_H GPL-2.0 发布审查责任人；
- [ ] 再次确认本轮不加入自动更新、新本地 OCR，也不实现其他空壳能力。
