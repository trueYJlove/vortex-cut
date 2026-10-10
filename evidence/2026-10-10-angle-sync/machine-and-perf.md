# W2.1 机位同步 —— 环境与性能口径（2026-10-10）

- 机型：11th Gen Intel(R) Core(TM) i7-1165G7 @ 2.80GHz
- 内存：31.6 GB
- 系统：Microsoft Windows 11 专业版
- ffmpeg：ffmpeg version n8.0.1-66-g27b8d1a017-20260228（gcc 15.2.0, crosstool-NG 1.28.0.1）
- 采样：48kHz / 单声道 / f32le，单遍流式窗口解码（不用 audio_chunks 的块路径）

## 性能门（Planning Gate §3.7：2×60s ≤ 30s）

```
seconds: 60 | elapsed_s: 0.6
   ready 0 1.0
   ready 687000 0.894
```

- 口径：**单次冷态运行**（无 derived_cache 命中依赖）、**并发度 1**（未做重复测量，也未测并发/多组并行——复核 M-d 指出，属已知取证边界），
  素材为 pink noise + mpeg4 视频、成员侧 adelay 687ms。
- 实测 0.60s ⇒ 门槛余量 50×；真机 Electron e2e 整轮 6.5–8.9s（含 App + sidecar 启动）。
