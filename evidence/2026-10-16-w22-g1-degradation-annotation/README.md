# G1 降级交付 —— 独立复核证据（2026-10-16）

对应实施记录：`docs/W2_2_DEGRADATION_IMPLEMENTATION_2026-10-16.md`
对应登记：`docs/STATUS.md` §4 P130（本切片）/ P132（A4 下游拒绝测试）

## 为什么有这份证据

`dd3dffd` 的提交信息与 STATUS 里写了三组负向对照（"去掉 INSERT 三列 ⇒ 3 红"等），
但**没有留下可复现的脚本与读数**，且**没有实施记录**（Rule 3 要求关门行附验收交叉核对表）。
本目录把"判据是否真有区分力"变成可重跑的东西，而不是复述自我陈述。

## 内容

| 文件 | 用途 |
|---|---|
| `nc_reproduce.py` | 三组负向对照：临时改写生产文件 → 跑测试 → 回滚 → 复绿。补丁逐项断言命中数，失效即中止（防"没打上却报通过"） |
| `verify_check_fix.py` | 复验 `CHECK` 用例的区分力：移除 v38 的 `CHECK` 后必须变红 |
| `nc_result.txt` | 上面第一个脚本的读数（含 HEAD、日期） |
| `check_fix_result.txt` | 上面第二个脚本的读数（含 HEAD、日期） |

两份 `*_result.txt` 由脚本重定向生成；重跑会覆盖，因此归档时同时记录了 `HEAD`。

## 读数（2026-10-16，HEAD `dd3dffd` + 本次测试修正）

基线 **31 passed** → NC1 **2 failed** → NC2 **2 failed** → NC3 **3 failed** → 回滚 **31 passed**。

`CHECK` 用例：基线 **1 passed** → 移除约束 **1 failed** → 回滚 **1 passed**。

## ⚠️ 与实现时自我陈述的两处不一致（如实记录）

1. **NC1 是 2 红，不是 3 红。** 差异源于补丁窗口口径：把 `SUMMARY_COLUMNS` 一并改掉可打红更多
   用例（本轮实测 11 红），但那是**另一个失败模式**，不构成 A1 的对照。以精确窗口的 **2 红**为准。
2. **`CHECK` 用例初版恒真。** 直接观察（`sqlite3` 内存库重放列定义）：`CHECK` 在位时 `'bogus'`
   被拒；移除后 `'bogus'` **成功入库**，而用例因 `except Exception` 吞掉自己的
   `raise AssertionError` 仍然通过 ⇒ 该用例此前不提供任何保护。已改为
   `pytest.raises(sqlite3.IntegrityError)`，负向对照复验为红。

## 复现方式

```bash
# 仓库根目录
.venv/Scripts/python.exe evidence/2026-10-16-w22-g1-degradation-annotation/nc_reproduce.py
.venv/Scripts/python.exe evidence/2026-10-16-w22-g1-degradation-annotation/verify_check_fix.py
```

两个脚本都会在 `finally` 中回滚被改写的文件；跑完应确认 `git status` 无意外改动
（`nc_reproduce.py` 只改 `speaker_service.py`，`verify_check_fix.py` 只改 `database_v38.py`）。
