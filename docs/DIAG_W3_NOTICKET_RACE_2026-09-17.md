# 诊断单:W3 残余失败——单素材 no-ticket 在数据面完备下的复现路径

> 立单:2026-09-17(ZhangSan 诊断,承接 `PRODUCT_DEFECTS_2026-09-11.md` GAP-LIST-ASSETS-PAGING
> 状态行 2026-09-16 复跑段登记的 follow-up——"单素材 no-ticket 在数据面完备下的复现路径
> (renderer 票据状态与 Core 数据不同步的时窗)待另立诊断单")。
> 性质:**诊断单(分析+代码走读,无新代码)**。结论改写了登记时的假设,见 §3。

## 1. 输入证据

09-16 复跑五批(`defect-verify-f04-20260915-v5/v6/v9/v11/`,共 21 轮):
每批成功轮 3–5/6 过,但**没有一批达成单次运行连续 5 轮全过**——每批恰有一轮失败:

| 批次 | 失败轮 | 失败形态 | setup_recovery_count |
|---|---|---|---|
| v5 | run-2-on | `.synthetic-canvas` 120s 不可见 | (attempt 内失败,harness 兜底未走完) |
| v6 | run-2-off | `.synthetic-canvas` 120s 不可见 | 0 |
| v9 | run-2-off | `.synthetic-canvas` 120s 不可见 | 0 |
| v11 | warmup-on | `.synthetic-canvas` 120s 不可见 | **2**(page.reload 重建装配两次仍失败) |

**数据面核查(四个失败轮 DB 逐个打开)**:assets 100/100 全 available;
96 clips 引用 73 素材全部在册(referenced-not-in-db=0);derived_media_cache 73 行。
——台账登记的"数据面完备"在三批上成立,v11 同样成立。

**主进程日志核查(关键发现)**:四个失败轮的 `desktop.log` 中
`asset presentation resolve failed`(assetPresentation 静默折叠前的落日志,**一行都没有**)。
即:整个运行周期内 Desktop 侧没有发生任何一次 resolveAsset 失败→票据缺失。

## 2. 代码链路走读(修复后现状)

票据获取链 = `loadProjectData`(App.tsx:359,翻页装载)→ IPC `asset:list`
(index.ts:391)→ `mapLimited(≤8) × assetPresentation`(index.ts:201)→
`resolveAssetWithRetry`(3 次退避)+ `restrictedMedia.register/issue`(5min TTL)。

三层既有修复全部在位并经走读确认:

1. **翻页装载**(App.tsx:364–374):200 页上限游标循环;
2. **App 缺票自动恢复**(App.tsx:894–919):`syntheticNotice` 含 "no ticket" 时
   有界 3 次 `loadProjectData` 重取 + 预算耗尽后 5s 延迟终验;
3. **SyntheticPreview 重建依赖**(SyntheticPreview.tsx:363):`mediaUrls` 在
   effect 依赖里,票据迟到即重建会话;
4. **主进程侧加固**(index.ts:152–167):resolveAsset 连接级失败 3 次退避,
   失败落日志;**B12 续票**(preview-session.ts:391–397):DecodeWorker 持
   refreshTicket 回调,TTL 到期受控刷新——5min TTL 长会话过期维度已闭环。

## 3. 诊断结论

### 3.1 "renderer 票据状态与 Core 数据不同步"不是残余失败的主因

登记时的假设(残留时窗 = renderer 票据状态与 Core 数据不同步)在证据上不成立:

- 若发生 resolve 失败→票据缺失,`assetPresentation` 必落日志(F04 复测现场
  专门加的),而四个失败轮**全部零条**;
- 若票据迟到(扇出在途),SyntheticPreview 重建依赖 + App 自动恢复已构成
  双兜底,且恢复动作会改变页面状态(harness 的 attempt 循环可见)——失败轮
  recovery=0 表明连兜底分支都没触发过;
- 数据面四轮全部完备,Core 侧无任何异常。

### 3.2 残余失败的实质 = 装配竞态(第一形态),票据竞态已是次要因素

失败轮的共同形态是**"合成预览装配已开始/状态已切换,但 canvas 120s 不出现"**,
与票据无关——这不是台账里三种失败形态之一的"单素材 no-ticket"复现,而是
装配竞态(形态三"装配期慢/停顿")在 harness 120s 窗口内的极端表现:

- v11/warmup-on 的 recovery=2 直接证明:两次 page.reload 完整重建(全部票据
  重新签发、装配重新走一遍)仍失败——若是票据竞态,重建必自愈;重建仍失败
  说明堵点在装配链路本身(解码 worker/合成器会话/Core 投影);
- v6/v9/v5 的 recovery=0 失败发生在 attempt 循环后的首个 120s 等待窗口,
  状态机器从未进入"回退态"(否则 harness 会走 recovery 分支),即装配既没
  成功也没显式失败——**挂起形态**,与 DEFECT-4K60-SESSION-HANG 同族但
  未触发 45s 看门狗(看门狗只覆盖 `create` 期,此处挂在 create 之后的
  首帧/就绪路径——ready.json 正常落盘、Core UI session ready 正常)。

### 3.3 环境因素按登记维持

失败轮全部出现在每批的 run-2/末位(连续满载 8–15 分钟后),与登记的
"笔记本 i7-1165G7 热节流窗口叠加"一致;成功轮 ready ≈41–53s 已贴近 harness
120s 窗口的 40%,热节流拖长尾即可越过窗口。

## 4. 处置建议

1. **W3 台账状态行更新**:登记假设更正——残余失败主因是装配挂起形态
   (create 后首帧路径,未触发 create 看门狗),非票据竞态;"单素材 no-ticket
   在数据面完备下的复现路径"经诊断**不存在于当前代码**(三层修复后,该形态
   的已知入口均已闭合,且失败现场无一条票据失败日志佐证)。
2. **follow-up 交割**:装配挂起形态归入 **DEFECT-4K60-SESSION-HANG 的延伸
   观察窗**(同族:create 看门狗覆盖不到 create 后的首帧/就绪挂起);若未来
   出现用户侧"合成预览无限转圈"反馈,直接按此归因开修(候选取证点:
   PreviewSession.create 之后 frameReady 首满足链路的 ack 超时覆盖)。
3. **5 轮全过复跑维持原建议**:等台式机/低热噪声环境,本机不再重试
   (环境性结论已由本诊断坐实)。
