"""W2.2 验收语料下载器（S0 ②）：AMI test 16 场 + AISHELL-4 test 20 场。

**为什么按 Range 分段并行**（2026-10-11 本机实测，同一 URL 同一时段）：

| 方式 | 聚合速率 | 剩余 ~3.7 GB 预计 |
|---|---|---|
| hf-mirror 单流（原 `s0_corpora.py`） | 44–134 KB/s | 8–24 h |
| 4 路并行 Range | 574 KB/s | ~1.8 h |
| 8 路并行 Range | 952 KB/s | ~1.1 h |

⇒ 单流是"下不完"的真正原因，不是语料不可得。故本工具按 Range 分段并行，
逐段断点续传（`<name>.chunks/NNNNN`），**全段齐了才组装**，组装时同步算 sha256。

**校验**：逐场 Content-Length + sha256；`--write-sha256` 输出与
`evidence/*/audio.sha256` 同格式（`sha256sum` 二进制标记 `*`）。
语料**不入库**（仓外 `.tmp/`）；仓库内只放派生结果与哈希（Design Gate §5）。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

UA = {"User-Agent": "aivs-w22-corpus-fetcher/1.0"}
AMI_BASE = "https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/"
A4_BASE = "https://hf-mirror.com/datasets/shenyunhang/AISHELL-4/resolve/main/"
# VoxConverse（**O6 缺口档语料**）：真实对话、CC BY 4.0、**说话人数 1–21 覆盖**，
# 而 AMI/AISHELL-4 只覆盖 3–7。整包 zip（dev 2.0 GB / test 4.3 GB），非逐场 URL。
VC_BASE = "https://www.robots.ox.ac.uk/~vgg/data/voxconverse/data/"
VC_ARCHIVES = {
    "dev": f"{VC_BASE}voxconverse_dev_wav.zip",
    "test": f"{VC_BASE}voxconverse_test_wav.zip",
}
# RTTM 在 GitHub 仓库里（很小），与音频分开取
VC_RTTM_TARBALL = "https://codeload.github.com/joonson/voxconverse/tar.gz/refs/heads/master"

AMI_TEST = [
    "EN2002a", "EN2002b", "EN2002c", "EN2002d",
    "ES2004a", "ES2004b", "ES2004c", "ES2004d",
    "IS1009a", "IS1009b", "IS1009c", "IS1009d",
    "TS3003a", "TS3003b", "TS3003c", "TS3003d",
]
# AMI **dev**（18 场，全部 K=4）：ADR-0008 D3-a 指定的**定参集**。
# 本仓此前只接触过 test，故 dev 是干净的参数选择集。
# ⚠️ 它的职责只是"把参数冻结下来"——**不得**用它判定（判定集另有其物）。
AMI_DEV = [
    "ES2011a", "ES2011b", "ES2011c", "ES2011d",
    "IB4001", "IB4002", "IB4003", "IB4004", "IB4010", "IB4011",
    "IS1008a", "IS1008b", "IS1008c", "IS1008d",
    "TS3004a", "TS3004b", "TS3004c", "TS3004d",
]
A4_TEST = [
    "L_R003S01C02", "L_R003S02C02", "L_R003S03C02", "L_R003S04C02",
    "L_R004S01C01", "L_R004S02C01", "L_R004S03C01", "L_R004S06C01",
    "M_R003S01C01", "M_R003S02C01", "M_R003S04C01", "M_R003S05C01",
    "S_R003S01C01", "S_R003S02C01", "S_R003S03C01", "S_R003S04C01",
    "S_R004S01C01", "S_R004S02C01", "S_R004S03C01", "S_R004S04C01",
]


def _opener(proxy: str):
    """显式构造 opener：proxy 为空串时**禁用**环境代理，保证行为可复现。"""
    handler = urllib.request.ProxyHandler({"http": proxy, "https": proxy} if proxy else {})
    return urllib.request.build_opener(handler)


def total_size(url: str, proxy: str) -> int:
    """Range: bytes=0-0 → 从 Content-Range 读总长度（同时确认服务端支持 Range）。"""
    req = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-0"})
    with _opener(proxy).open(req, timeout=120) as r:
        cr = r.headers.get("Content-Range")
        r.read(1)
    if not cr or "/" not in cr:
        raise OSError("server did not honour Range (no Content-Range)")
    return int(cr.rsplit("/", 1)[1])


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(1 << 20)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def _fetch_chunk(url: str, proxy: str, start: int, end: int, path: Path,
                 attempts: int = 6) -> None:
    expect = end - start + 1
    if path.exists() and path.stat().st_size == expect:
        return
    last: Exception | None = None
    for k in range(attempts):
        try:
            req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={start}-{end}"})
            tmp = path.with_suffix(".tmp")
            got = 0
            with _opener(proxy).open(req, timeout=300) as r, open(tmp, "wb") as f:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    f.write(b)
                    got += len(b)
            if got != expect:
                tmp.unlink(missing_ok=True)
                raise OSError(f"short chunk {got}/{expect}")
            tmp.replace(path)
            return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(2 ** k, 20))
    raise OSError(f"chunk {start}-{end} failed after {attempts} attempts: {last}")


def fetch_file(url: str, dest: Path, *, proxy: str, streams: int, chunk_mb: int) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = total_size(url, proxy)
    if dest.exists() and dest.stat().st_size > 0:
        # **已存在也要校验**（S0 要求"逐场校验"）：长度不符 ⇒ 视作残件重下，
        # 否则会把上一轮单流下载的截断文件当完整件写进 sha256 清单。
        if dest.stat().st_size == total:
            return {"size": total, "sha256": _sha256(dest), "how": "cached"}
        dest.unlink()
    step = chunk_mb * 1024 * 1024
    ranges = [(s, min(s + step - 1, total - 1)) for s in range(0, total, step)]
    cdir = dest.with_suffix(dest.suffix + ".chunks")
    cdir.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=streams) as ex:
        futs = [
            ex.submit(_fetch_chunk, url, proxy, a, b, cdir / f"{i:05d}")
            for i, (a, b) in enumerate(ranges)
        ]
        for f in concurrent.futures.as_completed(futs):
            f.result()
    tmp = dest.with_suffix(dest.suffix + ".part")
    h = hashlib.sha256()
    size = 0
    with open(tmp, "wb") as out:
        for i in range(len(ranges)):
            with open(cdir / f"{i:05d}", "rb") as f:
                while True:
                    b = f.read(1 << 20)
                    if not b:
                        break
                    out.write(b)
                    h.update(b)
                    size += len(b)
    if size != total:
        tmp.unlink(missing_ok=True)
        raise OSError(f"assembled {size} != Content-Length {total}")
    tmp.replace(dest)
    shutil.rmtree(cdir, ignore_errors=True)
    return {"size": size, "sha256": h.hexdigest(), "how": "downloaded"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", choices=["ami", "ami-dev", "aishell4", "both"], default="both")
    ap.add_argument("--root", default=".tmp", help="仓外语料根（默认 .tmp）")
    ap.add_argument("--streams", type=int, default=8)
    ap.add_argument("--chunk-mb", type=int, default=8)
    ap.add_argument("--ami-proxy", default="http://127.0.0.1:10809",
                    help="AMI 官方镜像走本机代理（实测 ~420 KB/s）；空串 = 直连")
    ap.add_argument("--aishell-proxy", default="",
                    help="AISHELL-4 走 hf-mirror 直连（实测最快）；空串 = 不走代理")
    ap.add_argument("--only", nargs="*", default=None, help="只下这些场次（调试用）")
    ap.add_argument("--manifest", default=".tmp/corpora-manifest.json")
    ap.add_argument("--write-sha256", default=None,
                    help="输出 sha256sum 格式清单（evidence 目录用）")
    args = ap.parse_args()

    root = Path(args.root)
    jobs: list[tuple[str, str, Path, str]] = []  # (corpus, meeting, dest, url)
    if args.corpus in ("ami", "both"):
        for m in AMI_TEST:
            jobs.append(("ami", m, root / "ami" / "audio" / f"{m}.Mix-Headset.wav",
                         f"{AMI_BASE}{m}/audio/{m}.Mix-Headset.wav"))
    if args.corpus == "ami-dev":
        for m in AMI_DEV:
            jobs.append(("ami", m, root / "ami" / "audio" / f"{m}.Mix-Headset.wav",
                         f"{AMI_BASE}{m}/audio/{m}.Mix-Headset.wav"))
    if args.corpus in ("aishell4", "both"):
        for m in A4_TEST:
            jobs.append(("aishell4", m, root / "aishell4" / "audio" / f"{m}.flac",
                         f"{A4_BASE}test/wav/{m}.flac"))
    if args.only:
        jobs = [j for j in jobs if j[1] in set(args.only)]

    report: dict = {"ami": {}, "aishell4": {}}
    lines: list[str] = []
    for corpus, meeting, dest, url in jobs:
        proxy = args.ami_proxy if corpus == "ami" else args.aishell_proxy
        t0 = time.perf_counter()
        try:
            info = fetch_file(url, dest, proxy=proxy, streams=args.streams,
                              chunk_mb=args.chunk_mb)
        except Exception as e:  # noqa: BLE001
            report[corpus][meeting] = {"error": str(e)[:200]}
            print(f"[{corpus}] {meeting} FAIL: {e}", flush=True)
            continue
        report[corpus][meeting] = info
        rel = dest.as_posix()
        lines.append(f"{info['sha256']} *{rel}")
        dt = time.perf_counter() - t0
        rate = info["size"] / dt / 1024 if dt > 0 and info["how"] == "downloaded" else 0
        print(f"[{corpus}] {meeting}: {info['size']/1048576:.1f} MiB "
              f"({info['how']}, {dt:.0f}s, {rate:.0f} KB/s) sha256={info['sha256'][:16]}",
              flush=True)
        Path(args.manifest).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    done = sum(1 for c in ("ami", "aishell4") for v in report[c].values() if "size" in v)
    fail = sum(1 for c in ("ami", "aishell4") for v in report[c].values() if "error" in v)
    print(f"\ndone: {done} ok / {fail} failed of {len(jobs)}", flush=True)
    if args.write_sha256:
        Path(args.write_sha256).write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"wrote {args.write_sha256}")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
