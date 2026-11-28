# Vortex Cut 品牌基线与图标资产

> 状态：正式冻结（品牌元数据于 2026-08-14 定稿）；当前交付与打包验收状态统一见 [`../STATUS.md`](../STATUS.md)。

---

## 1. 用户可见品牌

| 项目 | 冻结值 |
| --- | --- |
| 母品牌 | Vortex |
| 产品名 | Vortex Cut |
| GitHub 仓库 | `trueYJlove/vortex-cut` |
| 对用户描述 | 本地优先、AI 驱动的视频剪辑与多平台创作工具 |
| Windows 新安装身份 | `io.github.trueyjlove.vortexcut` |

- Vortex Cut 为独立新安装身份：不迁移旧 AIVideo Studio 开发安装数据，不要求覆盖安装兼容，也不主动卸载旧版本或清理旧数据。
- 对外说明只能覆盖 [`../STATUS.md`](../STATUS.md) §3「能力边界（已交付，可对外）」中列出的能力，不得宣传仍在规划中的能力。

---

## 2. 内部兼容标识（保留）

以下内部兼容标识仍在代码中生效，不得在无兼容策略与独立验收时隐式替换：

- npm workspace package names：`@aivideo/*`
- Python distribution name：`aivideo-core`
- 运行时与构建标识：`aivs_core`、`aivs-core`、`AIVS_*`、`AIVS_READY`、`aivideo://`
- 既有 SQLite schema / protocol / API 与既有历史 ADR / 验收记录正文

---

## 3. 图标资产落点与使用位置

多尺寸品牌源素材（`icon.ico` 与 `16/24/32/48/64/128/256/512.png`）统一托管在以下仓库路径：

| 路径 | 内容 | 用途 |
| --- | --- | --- |
| `apps/desktop/build/icon.ico` | 多尺寸 `.ico` | `electron-builder` exe 图标、NSIS 安装/卸载程序图标、开始菜单与桌面快捷方式图标 |
| `apps/desktop/src/renderer/public/icons/*.png` | 16–512 PNG | 界面标题栏 brand-lockup（`./icons/256.png`）及运行时读取（经 `out/renderer/icons` 进 asar） |
| `apps/desktop/src/renderer/public/icons/icon.ico` | 多尺寸 `.ico` | Windows 运行时窗口图标（`app-icons.ts` → `BrowserWindow`）与系统托盘图标（`tray.ts`） |
| `apps/desktop/src/renderer/public/favicon.ico` | 多尺寸 `.ico` | dev 浏览器模式页面 favicon（`src/renderer/index.html`） |

### 打包与运行时注意事项

1. **双配置同步**：`apps/desktop/electron-builder.yml` 与 `apps/desktop/scripts/package-win.mjs` 内的 `builderConfig` 必须同步维护；`tests/package-script-safety.test.ts` 对 `win.icon` / `nsis.installerIcon` / `nsis.uninstallerIcon` 有固定断言。
2. **图标随 `out` 打包**：运行时图标保持放在 `src/renderer/public/icons`，不改动测试锁定的 `files: ["out", "package.json"]`；`app-icons.ts` 自动按打包/开发态解析路径。
3. **托盘开关与换标**：设置 `AIVS_DISABLE_TRAY=1` 可禁用系统托盘（E2E/诊断）；替换 `build/icon.ico` 须包含 `16/24/32/48/64/128/256` 多尺寸。
