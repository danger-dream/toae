# TOAE

**Translate OCR AutoHotkey Electron** — 面向 Windows 的翻译、OCR、截图与 AutoHotkey 桌面工具。

TOAE 是原 [Tosa](https://github.com/danger-dream/tosa) 的 Electron 重构版。界面与主要使用习惯保持不变，移除了低频的划词助手浮窗，同时保留 Windows 取词、截图翻译、截图识别、翻译服务、OCR 服务和 AutoHotkey 改键能力。

## 功能

- 文本翻译与多翻译服务配置
- Windows UI Automation 取词，失败时回退到 `Ctrl+C`
- Rust 原生截图 Overlay，支持多屏、框选和快速取消
- 截图识别与图片直译
- 截图标注：矩形、椭圆、箭头、画笔、马赛克
- 译图覆盖选区，可再次点击取消翻译
- 截图复制、保存、撤销
- AutoHotkey v2 脚本与 `rust_callback(...)` 动作
- 托盘、透明窗口、内容自适应高度与开机自启

## 默认快捷键

默认脚本定义了以下 TOAE 动作：

| 快捷键 | 动作 |
| --- | --- |
| `Win+A` | 显示或隐藏翻译窗口 |
| `Win+S` | 截图翻译 |
| `Win+D` | 取词翻译 |
| `Win+F` | 截图识别 |

快捷键和改键规则均可在 AutoHotkey 设置中修改。

## 下载与运行

从 [Releases](https://github.com/danger-dream/toae/releases) 下载 Windows x64 免安装 ZIP：

1. 解压完整目录；
2. 运行根目录中的 `TOAE.exe`；
3. 不要直接在压缩包内运行。

resources 增量包用于覆盖同版本现有程序。更新前请从托盘完全退出 TOAE，然后将压缩包解压到 `TOAE.exe` 所在目录并合并覆盖 `resources`，不要解压成 `resources/resources/...`。

## 本地开发

### 前置环境

- Node.js 20+
- npm
- Rust stable
- Windows x64 helper 交叉构建目标：`x86_64-pc-windows-gnu`
- MinGW-w64
- Wine（在 Linux 上生成 Windows Electron 包时需要）

### 安装与检查

```bash
npm ci
npm test
npm run typecheck
npm run helper:fmt
cargo test --locked --manifest-path native-helper/Cargo.toml
```

### 开发运行

```bash
npm run dev
```

### 构建 Windows x64 免安装 ZIP

```bash
npm run dist:win:zip
```

输出位于 `release/`。

## 架构

- `src/`：Vue renderer
- `electron/main/`：Electron Main、窗口、Provider、截图流程和配置
- `electron/preload/`：安全 IPC bridge
- `native-helper/`：Rust Windows helper，负责 AutoHotkey_H、UIA 取词和原生截图 Overlay
- `resources/`：默认脚本、图标与 Windows 原生运行资源
- `tests/`：行为和 UI 保真测试
- `docs/REFACTOR_PLAN.md`：从 Tosa 迁移到 TOAE 的重构说明

## 数据迁移

TOAE 会兼容读取旧 Tosa 配置并采用 copy-only 迁移，不修改旧程序数据。旧应用标识仅保留在迁移兼容代码中。

## License

[MIT](LICENSE)
