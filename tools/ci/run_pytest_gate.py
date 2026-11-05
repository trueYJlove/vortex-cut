"""pnpm test:python 的唯一入口：定义 pytest 目标 → 跑 pytest → 跑 skip 守卫。

目标清单**只在这里定义一处**，由 Python 展开 glob 后传给 pytest。
为什么不写进 package.json：Windows 上 pnpm 用 cmd.exe 执行 script，不做 glob 展开，
直接把 services/core/tests/integration/test_*_routes.py 当字面量传给 pytest 会
报 "file or directory not found"（就算匹配非空也一样）。

匹配为空是**红**，不是绿：
  - glob 一个文件都没匹配到 → 直接非零退出（防止规则失效后静默少收集）；
  - 即便侥幸继续，check_pytest_skips.py 的收集数 floor 也会兜住。
"""

from __future__ import annotations

import glob
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# windows-latest 的控制台代码页不是 UTF-8（cp437/cp1252），直接 print 中文会
# UnicodeEncodeError 把一步正常的运行判成红。固定在入口处改 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")

# 全量的 unit 目录：范围仅 unit。integration 下 46 个文件会生成 10GB+ 真实媒体
# 夹具（见 pyproject.toml 的 tmp 策略注释），一律不进管道。
TEST_ROOTS = [
    "services/core/tests/unit",
]

# 额外的规则化目标：路由层回归锁（装配级缺陷只有走真实 HTTP 路由才抓得到，
# 见 services/core/tests/integration/test_keyframe_routes.py 文件头）。
# 用规则而不是写死文件名，新增同类 *_routes.py 会自动纳入。
EXTRA_TARGET_GLOBS = [
    "services/core/tests/integration/test_*_routes.py",
]

JUNIT_PATH = REPO_ROOT / ".tmp" / "ci" / "pytest-junit.xml"
# 单轮运行的临时根：固定在仓库内（.gitignore 已忽略 /.tmp/），
# 避免落到系统 %TEMP% 并跨轮累积 —— 见下方 --basetemp 处的事故记录。
BASETEMP = REPO_ROOT / ".tmp" / "ci" / "pytest-tmp"
CHECKER = REPO_ROOT / "tools" / "ci" / "check_pytest_skips.py"


def _targets() -> list[str]:
    targets = [str(REPO_ROOT / root) for root in TEST_ROOTS]
    for pattern in EXTRA_TARGET_GLOBS:
        matched = sorted(glob.glob(str(REPO_ROOT / pattern)))
        if not matched:
            raise SystemExit(
                f"[pytest-gate] FAIL 规则 {pattern} 没有匹配到任何文件："
                "路由锁被改名/删除后不允许静默变绿，请检查 EXTRA_TARGET_GLOBS"
            )
        for path in matched:
            if any(Path(path).is_relative_to(REPO_ROOT / root) for root in TEST_ROOTS):
                continue  # 已在 TEST_ROOTS 里，避免重复收集
            targets.append(path)
    return targets


def _cleanup_basetemp() -> None:
    """回收 pytest 夹具（单次全量约 22GB）。

    为什么必须自己做：pytest 的 tmp_path 保留策略只在其管理编号子目录时生效，
    本仓固定 basetemp 且用默认策略，因此**从不回收**——实测两轮各留 22GB，
    把系统盘从 23GB 打到 1.4GB，并以 ENOSPC 的形式伪装成「测试红」。
    只在整轮通过后调用（失败要留现场），且任何 OSError 只告警不失败——
    回收是维护动作，不该把一次通过的回归判成红。
    """
    if not BASETEMP.exists():
        return
    try:
        shutil.rmtree(BASETEMP)
    except OSError as exc:
        print(f"[pytest-gate] WARN 夹具回收失败（不影响本轮判定）: {exc}", file=sys.stderr)
        return
    print(f"[pytest-gate] 已回收夹具 {BASETEMP}")


def main() -> int:
    try:
        targets = _targets()
    except SystemExit as exc:
        print(exc, file=sys.stderr)
        return 1

    JUNIT_PATH.parent.mkdir(parents=True, exist_ok=True)

    rel = [str(Path(t).relative_to(REPO_ROOT).as_posix()) for t in targets]
    print(f"[pytest-gate] targets ({len(rel)}): {', '.join(rel)}")

    cmd = [
        sys.executable,
        "-m",
        "pytest",
        *targets,
        "-q",
        "-p",
        "no:cacheprovider",
        # xunit1 才有 testcase 的 file 属性，check_pytest_skips.py 按 file 建白名单。
        "-o",
        "junit_family=xunit1",
        # 固定 basetemp：默认策略会保留最近 3 次全量运行的临时目录，而本仓集成测试
        # 会生成真实媒体夹具（pyproject.toml 注释记录单次 10+GB）。实测 2026-10-23
        # 本门连续跑两轮就把系统盘写满两次（ENOSPC 直接打断 pytest，连 junit 都写不出，
        # 表现为一片假的 F/E —— 那是盘满，不是用例红）。
        # **更正（2026-11-04）**：此处原写「固定到仓库内 .tmp 后，每轮运行开头 pytest
        # 会自行清空它，不会跨轮累积」——**该结论是错的**。pytest 只在启用 tmp_path
        # 保留策略时管理 <basetemp>/pytest-N 编号子目录；本仓用固定 basetemp + 默认策略，
        # 它既不编号也不回收。实测两轮各留下 22.06GB/21.92GB，磁盘两次降到 1.4–1.7GB
        # （第二次同样以 ENOSPC 表现，只是发生在 junit 写入前，容易被误读成用例红）。
        # 所以清理必须由本脚本自己做（见下方 _cleanup_basetemp），不能靠 pytest。
        f"--basetemp={BASETEMP}",
        f"--junitxml={JUNIT_PATH}",
    ]
    print(f"[pytest-gate] run: {' '.join(cmd[1:])}")
    code = subprocess.call(cmd)
    if code != 0:
        print(f"[pytest-gate] pytest 退出码 {code}", file=sys.stderr)
        return code

    print("[pytest-gate] pytest 通过，开始 skip/收集数守卫")
    guard = subprocess.call([sys.executable, str(CHECKER), "--junit", str(JUNIT_PATH)])
    # 仅在整轮通过后回收夹具：失败时保留现场供排查（ENOSPC 时也走不到这里）。
    if guard == 0:
        _cleanup_basetemp()
    return guard


if __name__ == "__main__":
    raise SystemExit(main())
