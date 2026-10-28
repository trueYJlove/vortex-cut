"""P200 归因探针：把「长时线窗口取数慢」拆到可判定的层。

背景：P196 记录 `window_fetch` p50 2512ms / p95 8733ms，并推断「退化由时间线
长度驱动」。本探针的目的是验证该推断，而不是复述它。

做法：在**隔离副本**（`.tmp/probe-db/`）上用真实素材拼一条 ~15 分钟时间线，
分别测三层：
  1. Core 逻辑（直接调 RenderCoordinator，绕过 HTTP）
  2. HTTP/ASGI（真实 FastAPI 路由 + JSONResponse 编码）
  3. 冷/热对照（清空 preview_ir_v2_cache）

为什么必须用隔离副本：`timeline_revisions` 有 BEFORE DELETE/UPDATE 触发器
（"timeline revisions are immutable"），探针造出的 revision **无法删除**；
写真实库会永久留下一条测试时间线。

用法：
    uv run --locked --extra dev python tools/probe_p200_window_attribution.py
    AIVS_PROBE_TARGET_US=540000000 uv run ...   # 目标时长（默认 15 分钟）
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))

SOURCE_DIR = Path(os.path.expanduser("~/AppData/Roaming/@aivideo/desktop/data-v2"))
DATA_DIR = ROOT / ".tmp" / "probe-db"
PROJECT = os.environ.get("AIVS_PROBE_PROJECT", "project_50fafd9cf28140138d99bc7dd75c9464")
TARGET_US = int(os.environ.get("AIVS_PROBE_TARGET_US", str(15 * 60 * 1_000_000)))
RATIO, COUNT = "169", 300


def prepare_isolated_copy() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("app.db", "stage0.db"):
        source = SOURCE_DIR / name
        if source.is_file():
            shutil.copy2(source, DATA_DIR / name)


def build_long_timeline(state) -> tuple[str, float]:
    """把现有时间线的首个片段重复到目标时长（真实素材、真实解码参数）。"""
    con = sqlite3.connect(DATA_DIR / "app.db")
    try:
        base_rev, doc_json = con.execute(
            "SELECT current_timeline_revision_id, document_json FROM projects p "
            "JOIN timeline_revisions r ON r.id=p.current_timeline_revision_id WHERE p.id=?",
            (PROJECT,),
        ).fetchone()
    finally:
        con.close()
    document = json.loads(doc_json)
    base_clip = document["clips"][0]
    clip_len = int(base_clip["timeline_end_us"]) - int(base_clip["timeline_start_us"])
    repeats = max(1, TARGET_US // max(clip_len, 1))
    built = copy.deepcopy(document)
    built["clips"] = []
    for index in range(repeats):
        clip = copy.deepcopy(base_clip)
        clip["clip_id"] = f"clip_probe_{index}"
        clip["timeline_start_us"] = index * clip_len
        clip["timeline_end_us"] = (index + 1) * clip_len
        built["clips"].append(clip)
    with state.db.connection() as db:
        db.execute("BEGIN")
        try:
            created = state.timelines.create_revision_from_document(
                db, PROJECT, base_rev, built, "P200 归因探针")
            db.execute("COMMIT")
        except Exception:
            db.execute("ROLLBACK")
            raise
    return created["timeline_revision_id"], repeats * clip_len / 1e6


async def measure_core(coordinator, revision: str) -> None:
    print("\n== 第 1 层：Core 逻辑（绕过 HTTP）==")
    for label, clear in (("冷（清空 preview_ir_v2_cache）", True), ("热（缓存命中）", False)):
        timings = []
        for index in range(4):
            if clear:
                coordinator.preview_ir_v2_cache.clear()
            t0 = time.perf_counter()
            payload = await coordinator.preview_ir_window(PROJECT, revision, RATIO, index * COUNT, COUNT)
            timings.append(round((time.perf_counter() - t0) * 1000, 1))
        print(f"  {label}: " + ", ".join(f"{v}ms" for v in timings)
              + f"  (每窗 {len(payload.get('frames') or [])} 帧)")


async def measure_http(app, state, revision: str) -> None:
    import httpx

    print("\n== 第 2 层：HTTP/ASGI（真实路由 + 序列化）==")
    token = state.auth.create_ui_token()
    path = (f"/api/v1/projects/{PROJECT}/preview-ir-v2/window"
            f"?start_frame=0&frame_count={COUNT}&timeline_revision_id={revision}&output_ratio={RATIO}")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://core",
                                 headers={"Authorization": f"Bearer {token}"}) as client:
        state.render_coordinator.preview_ir_v2_cache.clear()
        t0 = time.perf_counter()
        first = await client.get(path)
        cold = (time.perf_counter() - t0) * 1000
        hot = []
        for _ in range(5):
            t0 = time.perf_counter()
            await client.get(path)
            hot.append(round((time.perf_counter() - t0) * 1000, 1))
        body = first.content
        frames = len(json.loads(body).get("frames") or [])
        print(f"  冷（缓存空）: {cold:.1f}ms  status={first.status_code}  bytes={len(body)}")
        print(f"  热（缓存命中）: " + ", ".join(f"{v}ms" for v in hot))
        print(f"  单窗载荷: {frames} 帧 / {len(body)} bytes（每帧均值 "
              f"{len(body) // max(frames, 1)} bytes）")


async def main() -> None:
    from aivs_core.config import Settings
    from aivs_core.app import create_app

    prepare_isolated_copy()
    settings = Settings(
        data_dir=DATA_DIR,
        ffmpeg=ROOT / "resources" / "ffmpeg" / "win-x64" / "ffmpeg.exe",
        ffprobe=ROOT / "resources" / "ffmpeg" / "win-x64" / "ffprobe.exe",
    )
    app = create_app(settings)
    async with app.router.lifespan_context(app):
        state = app.state.core
        revision, seconds = build_long_timeline(state)
        print(f"隔离副本长时线：revision={revision}  {seconds:.1f}s  (~{int(seconds * 30)} 帧 @30fps)")
        await measure_core(state.render_coordinator, revision)
        await measure_http(app, state, revision)
        print("\n结论见 docs/STATUS.md §4 P200 的 2026-10-28 归因补记。")


if __name__ == "__main__":
    asyncio.run(main())
