# S1 小修包实施报告(2026-09-12)

依据:`PERFORMANCE_C20T_B11D_PLANNING_GATE_2026-09-12.md` §2 S1(已批准)。
次序:S1 先行清障,T1/T2/D 随后。

## 1. S1.1 input-pool-protocol 测试 unhandled rejection 清偿

**根因**(B13-R 报告 §4 登记,HEAD 既有):`compositor-worker.ts` 的
`terminate()` 会 reject 全部在途 pending ack(行 267);测试
`tests/input-pool-protocol.test.ts` "generation 递增语义"用例连续两次
`registerInput` 不消费返回 promise,`client.terminate()` 后两条拒绝
无人接 → 恰好 2 个 unhandled rejection。

**修复**:用例改为显式持有两条 ack promise,terminate 后断言
`rejects.toThrow("compositor worker disposed")`——既消费掉拒绝,又把
"terminate 拒绝全部在途 ack"的处置语义升级为回归锁(与 A01 生命周期
回归风格一致)。生产代码零改动。

## 2. S1.2 failure.json 持久化脱敏错误文本

**背景**:runner `performance-editor.spec.ts` 失败路径此前只持久化
status/error_type,错误文本按"解码失败可能含媒体票据/路径"策略整体
不落盘(C20 A/B §6.1 勘误的可诊断性缺口)——F02 低频崩溃待查因此
无诊断输入。

**修复**(单一政策源,不另起炉灶):

1. `electron/main/logging.ts` `redact()` URI 规则补上应用自有 scheme
   `restricted-media://`(原规则只覆盖 file/https/wss,desktop.log 对
   票据同样存在该缺口,本次一并闭合);
2. `logging.ts` 新增 `sanitizeErrorDetail(error)`:name 原样,
   message/stack 一律过 `redact()` 后截断(600/4000 字符封顶),
   非 Error 回退 `unknown`;
3. runner 失败路径改写 failure.json 为
   `error_type / error_message / error_stack`(均为脱敏后文本),
   其余字段与状态码不变;`summarize_results.py` 只读
   `results-*.json`,无消费方兼容风险。

单测新增 4 项(restricted-media 票据擦除、票据/路径脱敏、截断封顶、
非 Error 回退),计入 `tests/logging.test.ts`。

## 3. 验证

| 项 | 判定 |
|---|---|
| Desktop 单测 | **69 文件 622 项全过**(619+4 新增 -1 改写,B13-R 遗留的 2 个 unhandled rejection 归零) |
| typecheck | 通过 |
| 隐私口径 | failure.json 新字段全部经 `redact()`;票据/URI/路径/token 规则与 desktop.log 同源 |
| 如实登记 | 首轮全量跑出现过 1 例失败,后续 3 轮连跑全绿未复现且输出未留存,无法定位用例名——登记为偶发未复现,不掩盖 |

## 4. 遗留

- F02 低频崩溃待查:本报告落地后具备"failure.json 含脱敏错误文本 +
  栈"的诊断前提,待下次复现取证(不在 S1 范围)。
- 偶发测试闪失:若再次出现,按用例名另行登记修复。
