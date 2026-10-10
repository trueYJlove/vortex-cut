# W2.1 机位同步 —— Verification Gate 负向对照（2026-10-10）

验证门（LiuKeAi）要求「有区分力验证」：证明测试不是恒真。以下两组由实施方实跑并归档。

## NC1｜去掉「同键同指纹不重复写」的幂等保护

改动：`angle_sync.py` 中 `if status in ("ready","unavailable"):` → `if False and ...`

```
=== NEGATIVE CONTROL 1: 去掉幂等写入保护 ===
FAILED services/core/tests/integration/test_angle_sync_api.py::test_resync_after_member_fingerprint_change_succeeds
1 failed, 6 deselected, 1 warning in 4.27s
--- restored: 0 处改动 ---
```

结论：变红 ⇒ M1（参考机位 ready 行撞部分唯一索引 ⇒ 作业崩）的修复与用例都有区分力。

## NC2｜漂移阈值放大到失效（等价于没做漂移检查）

改动：`if abs(drift_us) > DRIFT_TOLERANCE_US:` → `> DRIFT_TOLERANCE_US * 1e9`

```
=== NEGATIVE CONTROL 2: 漂移检查失效 ===
FAILED services/core/tests/unit/test_angle_sync_algorithm.py::test_clock_drift_is_rejected_not_silently_averaged
FAILED services/core/tests/unit/test_angle_sync_algorithm.py::test_drift_branch_is_locked
2 failed, 1 passed, 15 deselected in 1.15s
--- restored: 0 处改动 ---
... 3 passed, 15 deselected in 0.95s
```

结论：漂移两例变红、**无漂移对照仍绿**（不是一刀切失败）⇒ 漂移分支锁有区分力。

## 真机 e2e（合成素材，本机）

```
ok 1 e2e\angle-sync.electron.spec.ts:58:1 › W2.1 机位同步：真机面板全链路（建组 → 同步 → 偏移表 → 人工偏移） (6.5s)
1 passed (7.1s)
```

> 真实**多机位素材**（同场次双机位）尚未提供 ⇒ 验收 9 标记「未取证」，不以合成素材顶替（P84）。
