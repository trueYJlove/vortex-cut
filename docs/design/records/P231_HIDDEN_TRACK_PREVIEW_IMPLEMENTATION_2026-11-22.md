# P231 隐藏轨预览补充实现记录（2026-11-22）

> 本记录只保存本次增补的实现与验收证据；项目当前状态与未完成项以 [`STATUS.md`](../../STATUS.md) 为准。

## 范围

真实 Electron 验收发现：Core 将 `track_hidden` 当作整个实时合成预览不支持的语义，导致隐藏一条视频轨后，其他可见轨也一并回退到交互预览。该行为与 P231「可见视觉段进入 layers、隐藏段排除」的设计不一致。

本次将隐藏段从合成白名单检查中跳过，并从 IR 帧层排除；时间线总帧数仍按所有视觉段的输出尾点计算。投影版本从 7 升到 8，避免沿用旧投影缓存。

## 验收交叉检查

| 验收项 | 判据 | 证据 | 结果 |
|---|---|---|---|
| A11-a | 隐藏段不进入帧 `layers`，隐藏段上的倒放不阻止可见段合成 | `services/core/tests/unit/test_render_ir.py::test_hidden_visual_track_is_omitted_without_shortening_timeline` | 通过 |
| A11-b | 隐藏段仍保留时间线尾长；可见段结束后输出黑帧 | 同上 | 通过 |
| A11-c | 隐藏 V2 轨时 manifest/window 可读、首帧为黑且 layers 为空，Electron 界面没有合成回退提示 | `apps/desktop/e2e/m6-multi-track.electron.spec.ts` | 通过（1 passed，真实素材） |
| UI-1 | 合成回退提示不再列举已支持的蒙版、抠像和图片素材 | `apps/desktop/tests/fallback-notice.test.ts` | 通过（4 passed） |

## 验收记录

- Core IR、窗口、缓存及状态一致性定向回归：74 passed（包含 `test_render_ir.py` 38 passed）。
- `apps/desktop/tests/fallback-notice.test.ts`：4 passed。
- Desktop TypeScript typecheck：通过。
- `apps/desktop/e2e/m6-multi-track.electron.spec.ts`：1 passed（真实 Electron + 真实视频素材）。
- 整窗截图：`test-results/m6-multi-track-33712-1795350332861/multi-track-real-media.png`。

