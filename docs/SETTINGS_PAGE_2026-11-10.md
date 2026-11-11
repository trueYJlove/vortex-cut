# 设置页重构记录（2026-11-10 · Round 9）

## 交付
设置页由「单页 fieldset 堆叠」改为**左侧导航 + 右侧内容**，与 OpenFilm 的
SettingsModal 同构。

### 结构
- 弹窗宽度 `min(880px, 100vw - 32px)`，最大高 82vh
- 左栏固定 264px：顶部搜索框（40px）+ 分区项（40px，18px 图标 + 15px 文字）
- 四个分区：通用（外观 + Provider 配置）/ 网络代理 / 预览播放 / 诊断
- 搜索按分区名实时过滤导航项；无匹配时显示「没有匹配的分区」
- 选中项：`bg var(--ctl-bg-hover)` + 文字提亮，`aria-current="page"`

### 保留
所有原有控件与 `aria-label` 原样保留（代理模式、自定义代理地址、主题、
预览代理、代理分辨率、打开 Provider 设置、重启内核）。
11 个直接挂载 App 并按可访问名称取元素的测试全部通过。

## 踩到并修复的四个问题

### 1. `.modal label { display: grid }` 把搜索框拆成竖排
全局规则（styles.css:1131）覆盖了我在 `.settings-search` 上的 flex，
搜索图标被推到输入框上方。修法：`.modal.settings-dialog-nav .settings-search`
提高特异性重写为 flex。

### 2. `.modal button` 的 min-height 把导航项压成 34px
导航项设 40px 但实测 34px。修法：同前缀覆盖 `height/min-height: 40px`。

### 3. `.modal button` 的 border 在导航项之间画出横线
只清 `border: 0` 不够，hover 规则又带回来。修法：显式 `border-width: 0;
border-style: none; box-shadow: none`，且覆盖 hover/focus 三态。

### 4. Provider 配置移入分区后破坏了既有测试
测试 `app.test.tsx` 断言「打开设置后直接能看到 Provider 说明与按钮」。
这暴露了真实的可用性问题：Provider 配置是高频入口，藏进二级分区会让用户
多点一次。**改回「通用」分区**（而非改测试）。

## 验证（真实软件）
| 项 | 值 |
|---|---|
| 弹窗宽 | 880px |
| 导航项高 | 40px |
| 搜索框高 | 40px |
| 导航项 border | 0 / none |
| 搜索过滤「预览」 | 只剩「预览播放」 |
| 网络代理分区 | 代理模式控件可见 |

桌面 143 文件 / 1327 测试通过，typecheck 通过。

## 未完成
1. 时间线视觉规格对齐（标尺 20 / 轨高 56-44 / 行间隙 2 / 留白 10）
2. 时间线交互补齐（吸附提示 / 热光标 / 滚轮缩放 / 框选 / 轨道排序）
3. 区间选取与标记（新功能）