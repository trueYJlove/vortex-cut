# 品牌图标资产（Vortex Cut Logo）

来源素材：`C:\Users\trueY\Desktop\图标素材\Vortex Cut`（`Vortex Cut.ico` + 16/24/32/48/64/128/256/512.png）。
参考实现：`C:\DataFolder\codes\hello-halo`（resources 图标布局 + 托盘管理 + electron-builder 图标配置）。

## 资产落点

| 路径 | 内容 | 用途 |
| --- | --- | --- |
| `apps/desktop/build/icon.ico` | 多尺寸 .ico | electron-builder `buildResources`：exe 图标、NSIS 安装包/卸载程序图标、开始菜单与桌面快捷方式图标 |
| `apps/desktop/src/renderer/public/icons/*.png` | 16–512 PNG | 界面内品牌图（标题栏 logo）；打包后经 `out/renderer/icons` 进入 asar，供主进程运行时读取 |
| `apps/desktop/src/renderer/public/icons/icon.ico` | 多尺寸 .ico | 运行时窗口/托盘图标（Windows） |
| `apps/desktop/src/renderer/public/favicon.ico` | 多尺寸 .ico | 页面 favicon（dev 浏览器场景） |

## 使用位置

| 场景 | 取值 | 代码/配置位置 |
| --- | --- | --- |
| 软件左上角（自绘标题栏 brand-lockup） | `./icons/256.png` | `src/app/App.tsx`（`.brand-mark`）+ `src/styles.css` |
| 窗口图标（Alt-Tab、任务栏窗口按钮） | Windows `icon.ico`，其余 `256.png` | `electron/main/app-icons.ts` → `electron/main/index.ts`（BrowserWindow `icon`） |
| 任务栏身份（固定/分组/通知） | `app.setAppUserModelId("io.github.trueyjlove.vortexcut")` | `electron/main/index.ts` |
| Windows 右下角系统托盘 | Windows `icon.ico`，其余 `16.png`；菜单「显示主窗口 / 退出 Vortex Cut」 | `electron/main/tray.ts` |
| 安装包（VortexCut-Setup-*.exe） | `build/icon.ico`（`nsis.installerIcon`） | `apps/desktop/electron-builder.yml` + `scripts/package-win.mjs` |
| 桌面/开始菜单快捷方式 | 随 exe 图标（`win.icon`） | 同上（`nsis.createDesktopShortcut: true`） |
| 卸载入口 | `build/icon.ico`（`nsis.uninstallerIcon`） | 同上 |
| favicon | `favicon.ico` + `icons/32.png` | `src/renderer/index.html` |

## 注意事项

1. **双配置同步**：`electron-builder.yml` 与 `scripts/package-win.mjs` 内的 `builderConfig` 必须同步维护；
   实际打包走 `package-win.mjs`（生成的 JSON 配置位于 tmpdir，图标路径必须是绝对路径）。
   `tests/package-script-safety.test.ts` 对 `win.icon` / `nsis.installerIcon` / `nsis.uninstallerIcon` 有固定断言。
2. **图标走 `out` 打包**：运行时图标放在 `src/renderer/public/icons`，经构建进入 `out/renderer/icons`，
   因此不改动被测试固定的 `files: ["out", "package.json"]`。主进程通过 `app-icons.ts` 解析
   （打包：`<asar>/out/renderer/icons`；开发：`src/renderer/public/icons`）。
3. **托盘可关闭**：设置 `AIVS_DISABLE_TRAY=1` 可禁用托盘（E2E/诊断场景）。
4. **换 logo**：替换上述两处资产后，`build/icon.ico` 必须是包含 16/24/32/48/64/128/256 的多尺寸 .ico，
   否则任务栏/快捷方式会模糊。macOS（.icns）/Linux（png 目录）目标当前未配置，需要时再补。
