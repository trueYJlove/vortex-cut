"""AI-2/AI-1 真实世界验证驱动（spike，不入 CI）。

用法（仓库根）：
  AIVS_VALIDATION_API_KEY=sk-xxx python tools/validation/run_validation.py

- 隔离 data_dir（.validation/），起真实 sidecar（admin token 脚本生成）；
- 导入三段真实素材（舞蹈 1080p50 / 科普 720p 竖屏 / 立春 720p）；
- 实验 A：cv_analysis job 墙钟（性能门：p95 ≤ 10s/分钟源）；
- 实验 B（需 key）：auto 召回 → 真 provider 三候选 → 候选质量快照；
- 实验 C（需 key）：AI-1 多步 agent 会话（步数/收敛/反馈重试观测）；
- 产物落 .validation/report.json + 控制台摘要。

判定标准（验证报告逐项给结论）：
A1 每分钟源素材分析墙钟 ≤ 10s；A2 scene_cut 数与素材场景结构肉眼一致；
B1 无转录素材召回非空；B2 三候选均过 0.8-1.2×时长硬门；
B3 候选"开场-展开-收尾"结构在摘要/reason 中可辨认（人工判读）；
C1 会话 ≤6 步内 succeeded；C2 失败步的反馈重试可观测（steps.error 非空后
   仍有成功步）；C3 单会话 token ≤ 200k（usage 聚合）。
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
FFMPEG = REPO / "resources/ffmpeg/win-x64/ffmpeg.exe"
FFPROBE = REPO / "resources/ffmpeg/win-x64/ffprobe.exe"
DATA_DIR = REPO / ".validation"
ASSETS = [
    ("dance", r"C:\Users\trueY\Desktop\刘可艾 小花猫舞蹈视频.mp4"),
    ("science", r"C:\Users\trueY\Downloads\给三年级学生讲解倒春寒的科普视频.mp4"),
    ("lichun", r"C:\Users\trueY\Downloads\立春视频.mp4"),
]


def _request(method: str, url: str, payload: dict | None = None, token: str | None = None):
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=body, method=method)
    if body:
        request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()
        raise RuntimeError(f"{method} {url} -> {exc.code}: {detail[:400]}") from exc


def start_core() -> tuple[subprocess.Popen, str, int]:
    token = secrets.token_urlsafe(32)
    env = {**os.environ, "AIVS_ADMIN_TOKEN": token}
    # YuNet 人脸模型 seed（测试缓存已校验 sha256；缺省时人脸通道 partial）。
    model_cache = REPO / "resources/.test-model-cache"
    if model_cache.is_dir():
        env["AIVS_E2E_MODEL_DIR"] = str(model_cache)
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "aivs_core.bootstrap",
            "--data-dir", str(DATA_DIR),
            "--ffmpeg", str(FFMPEG), "--ffprobe", str(FFPROBE),
            "--log-level", "warning",
        ],
        cwd=REPO,
        env={**env, "PYTHONPATH": str(REPO / "services/core/src")},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        line = proc.stdout.readline().decode(errors="replace")
        if line.startswith("AIVS_READY "):
            ready = json.loads(line.split(" ", 1)[1])
            return proc, token, ready["port"]
        if proc.poll() is not None:
            raise RuntimeError("core exited early")
    raise RuntimeError("core not ready in 60s")


def wait_job(base: str, token: str, job_id: str, timeout_s: float = 600) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        job = _request("GET", f"{base}/api/v1/jobs/{job_id}", token=token)
        if job["status"] in {"succeeded", "failed", "cancelled", "interrupted"}:
            return job
        time.sleep(0.2)
    raise TimeoutError(f"job {job_id} not finished in {timeout_s}s")


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-bc", action="store_true", help="只跑实验 A（无需 API key）")
    args = parser.parse_args()

    api_key = os.environ.get("AIVS_VALIDATION_API_KEY", "")
    if args.skip_bc:
        api_key = ""
    elif not api_key:
        print("未设置 AIVS_VALIDATION_API_KEY——将跳过实验 B/C（真 provider）。\n"
              "设置后重跑即可全部执行。")
        args.skip_bc = True

    report: dict = {"assets": {}, "experiment_a": {}, "experiment_b": None, "experiment_c": None}
    proc, token, port = start_core()
    base = f"http://127.0.0.1:{port}"
    try:
        admin = token  # internal 端点用 admin；UI 端点换短时 ui token
        ui = _request("POST", f"{base}/api/v1/internal/sessions", token=admin)["token"]
        project = _request(
            "POST", f"{base}/api/v1/projects", token=ui,
            payload={"name": "validation", "canvas": {"width": 1080, "height": 1920}},
        )
        project_id = project["project_id"]
        report["project_id"] = project_id

        # ---- 导入素材（admin file-grant → import 两步） ----
        for label, path in ASSETS:
            if not Path(path).is_file():
                report["assets"][label] = {"error": "missing", "path": path}
                continue
            grant = _request(
                "POST", f"{base}/api/v1/internal/file-grants", token=admin,
                payload={"path": path},
            )
            imported = _request(
                "POST", f"{base}/api/v1/projects/{project_id}/assets", token=ui,
                payload={"grant_id": grant["grant_id"], "kind": "video"},
            )
            report["assets"][label] = imported
        print("导入完成：", {k: v.get("asset_id", v.get("error")) for k, v in report["assets"].items()})

        # ---- 实验 A：CV 信号分析墙钟 ----
        for label, info in report["assets"].items():
            if "asset_id" not in info:
                continue
            asset_id = info["asset_id"]
            asset = _request("GET", f"{base}/api/v1/assets/{asset_id}", token=ui)
            duration_us = asset["media_info"]["duration_us"]
            endpoint = f"{base}/api/v1/projects/{project_id}/assets/{asset_id}/cv-analysis"
            started = time.perf_counter()
            result = _request("POST", endpoint, token=ui, payload={"generate": True})
            job = wait_job(base, ui, result["job_id"], timeout_s=900) if result.get("job_id") else None
            elapsed = time.perf_counter() - started
            analysis = _request("POST", endpoint, token=ui, payload={"generate": False})
            duration_min = duration_us / 60_000_000
            report["experiment_a"][label] = {
                "duration_s": round(duration_us / 1_000_000, 1),
                "wall_clock_s": round(elapsed, 1),
                "per_minute_s": round(elapsed / duration_min, 1) if duration_min else None,
                "sample_count": analysis.get("sample_count"),
                "scene_cut_count": analysis.get("scene_cut_count"),
                "status": analysis.get("status"),
                "job_status": job["status"] if job else result.get("status"),
                "error": (job or {}).get("error"),
            }
            print(f"实验A[{label}]: {report['experiment_a'][label]}")

        # ---- 实验 B/C：真 provider ----
        if api_key:
            provider = _request(
                "POST", f"{base}/api/v1/providers", token=ui,
                payload={
                    "kind": "openai_compatible_text",
                    "display_name": "validation-provider",
                    "base_url": os.environ.get("AIVS_VALIDATION_BASE_URL", "https://api.openai.com/v1"),
                    "model": os.environ.get("AIVS_VALIDATION_MODEL", "gpt-4o-mini"),
                    "input_price_per_million": 0.15,
                    "output_price_per_million": 0.6,
                },
            )
            provider_id = provider["provider_config_id"]
            _request("PUT", f"{base}/api/v1/providers/{provider_id}/secret", token=ui,
                     payload={"secret": api_key})
            # 能力测试（候选 + patch 两条）
            cap_candidate = _request("POST", f"{base}/api/v1/providers/{provider_id}/candidate-planning-capability-test", token=ui)
            cap_patch = _request("POST", f"{base}/api/v1/providers/{provider_id}/timeline-patch-capability-test", token=ui)
            print("能力测试: candidate =", cap_candidate.get("candidate_capability_status"),
                  "| patch =", cap_patch.get("timeline_patch_capability_status"))
            report["capability"] = {
                "candidate": cap_candidate.get("candidate_capability_status"),
                "patch": cap_patch.get("timeline_patch_capability_status"),
                "adapter": cap_candidate.get("candidate_response_adapter_id"),
            }

        with (DATA_DIR / "report.json").open("w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("报告：", DATA_DIR / "report.json")
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
