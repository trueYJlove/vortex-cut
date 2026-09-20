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
    pythonpath = str(REPO / "services/core/src")
    # spike 网络桥：sidecar httpx trust_env=False 不走系统代理，境外网关
    # 直连超时——经 sitecustomize monkey-patch 注入代理（临时桥，产品正解
    # = PROXY_SUPPORT 工作单）。
    proxy = os.environ.get("AIVS_VALIDATION_PROXY", "")
    if proxy:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        bridge = DATA_DIR / "sitecustomize.py"
        bridge.write_text(
            "import os as _os\n"
            "if _os.environ.get('AIVS_SPIKE_PROXY'):\n"
            "    import httpx as _httpx\n"
            "    _orig = _httpx.AsyncClient.__init__\n"
            "    def _patched(self, *a, **kw):\n"
            "        kw.pop('trust_env', None)\n"
            "        kw.setdefault('proxy', _os.environ['AIVS_SPIKE_PROXY'])\n"
            "        _orig(self, *a, **kw)\n"
            "    _httpx.AsyncClient.__init__ = _patched\n",
            encoding="utf-8",
        )
        env["AIVS_SPIKE_PROXY"] = proxy
        pythonpath = f"{DATA_DIR};{pythonpath}"
    proc = subprocess.Popen(
        [
            sys.executable, "-m", "aivs_core.bootstrap",
            "--data-dir", str(DATA_DIR),
            "--ffmpeg", str(FFMPEG), "--ffprobe", str(FFPROBE),
            "--log-level", "warning",
        ],
        cwd=REPO,
        env={**env, "PYTHONPATH": pythonpath},
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


def _provider_env() -> dict[str, str]:
    """读取 AIVS_REAL_PROVIDER_* 配置（与 opt-in 测试同一来源）。

    优先从注册表 User 环境变量直读（绕过进程启动时的环境快照——用户
    修改配置后旧 shell/新启动的脚本会读到旧值）；失败回退进程环境。
    ENABLED 门与 opt-in 测试一致：必须显式 =1 才执行真 provider 实验。
    """
    names = (
        "AIVS_REAL_PROVIDER_BASE_URL",
        "AIVS_REAL_PROVIDER_MODEL",
        "AIVS_REAL_PROVIDER_API_KEY",
        "AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION",
        "AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION",
    )
    values: dict[str, str] = {}
    if sys.platform == "win32":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER, "Environment"
            ) as key:
                for name in names:
                    try:
                        values[name] = str(winreg.QueryValueEx(key, name)[0])
                    except FileNotFoundError:
                        values[name] = ""
                enabled = winreg.QueryValueEx(key, "AIVS_REAL_PROVIDER_ENABLED")[0]
                values["AIVS_REAL_PROVIDER_ENABLED"] = str(enabled)
        except OSError:
            pass
    for name in names:
        if not values.get(name):
            values[name] = os.environ.get(name, "")
    # ENABLED 优先级：进程环境显式 1（显式意图，如命令行前缀）> 注册表 > 缺省 0。
    process_enabled = os.environ.get("AIVS_REAL_PROVIDER_ENABLED", "")
    if process_enabled == "1" or not values.get("AIVS_REAL_PROVIDER_ENABLED"):
        values["AIVS_REAL_PROVIDER_ENABLED"] = process_enabled or values.get(
            "AIVS_REAL_PROVIDER_ENABLED", "0"
        )
    return values


def _proxy_patched_factory():
    """httpx 显式代理注入（provider_factory 注入点，与测试替身同机制）。

    sidecar 出网 httpx 用 trust_env=False（不读环境），而本机 provider
    需走系统代理——验证脚本经此 factory 传入 proxy。仅 spike 用，
    产品侧"sidecar 尊重系统代理"是独立工作单（验证报告已登记）。
    """
    import httpx

    proxy = os.environ.get("AIVS_VALIDATION_PROXY", "")
    if not proxy:
        return OpenAICompatibleTextProvider()

    class _ProxyProvider(OpenAICompatibleTextProvider):
        def __init__(self) -> None:
            super().__init__(
                client_factory=lambda **kwargs: httpx.AsyncClient(
                    proxy=proxy, trust_env=False, **kwargs
                )
            )

    return _ProxyProvider()


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-bc", action="store_true", help="只跑实验 A（无需 API key）")
    args = parser.parse_args()

    provider_env = _provider_env()
    enabled = provider_env["AIVS_REAL_PROVIDER_ENABLED"] == "1"
    has_key = bool(provider_env["AIVS_REAL_PROVIDER_API_KEY"])
    if args.skip_bc:
        api_key = ""
    elif enabled and has_key:
        api_key = provider_env["AIVS_REAL_PROVIDER_API_KEY"]
        print(f"使用 AIVS_REAL_PROVIDER_* 配置：{provider_env['AIVS_REAL_PROVIDER_BASE_URL']} "
              f"模型 {provider_env['AIVS_REAL_PROVIDER_MODEL']}")
    else:
        api_key = ""
        print("AIVS_REAL_PROVIDER_* 未就绪（需 ENABLED=1 且 API_KEY 非空）——"
              "将跳过实验 B/C（真 provider）。")
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

        # ---- 实验 B/C：真 provider（AIVS_REAL_PROVIDER_* 配置组） ----
        if api_key:
            provider = _request(
                "POST", f"{base}/api/v1/providers", token=ui,
                payload={
                    "kind": "openai_compatible_text",
                    "display_name": "validation-provider",
                    "base_url": provider_env["AIVS_REAL_PROVIDER_BASE_URL"],
                    "model": provider_env["AIVS_REAL_PROVIDER_MODEL"],
                    "input_price_per_million": float(
                        provider_env["AIVS_REAL_PROVIDER_INPUT_PRICE_PER_MILLION"] or 0
                    ),
                    "output_price_per_million": float(
                        provider_env["AIVS_REAL_PROVIDER_OUTPUT_PRICE_PER_MILLION"] or 0
                    ),
                },
            )
            provider_id = provider["provider_config_id"]
            # 凭据走 admin 内部端点（vault 进程内，不落盘）。
            _request("PUT", f"{base}/api/v1/internal/provider-secrets/{provider_id}", token=admin,
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

            if cap_candidate.get("candidate_capability_status") != "supported":
                print("candidate 能力不支持——跳过实验 B")
            else:
                # ---- 实验 B：CV 召回（无转录）→ 三候选 ----
                try:
                    _request("PUT", f"{base}/api/v1/projects/{project_id}/brief", token=ui,
                             payload={
                                 "schema_version": 1, "topic": "舞蹈", "audience": "短视频观众",
                                 "target_platform": "generic_vertical",
                                 "target_duration_us": 30_000_000,
                                 "narrative_goal": "保留最有活力的舞蹈片段", "style_notes": "",
                                 "must_keep": [], "forbidden": [],
                                 "original_audio_policy": "preserve",
                                 "caption_policy": "none",
                                 "caption_preset_id": "default-bottom",
                                 "default_layout": "fit",
                             })
                    dance_asset = report["assets"].get("dance", {}).get("asset_id")
                    preview = _request(
                        "POST", f"{base}/api/v1/projects/{project_id}/candidate-generations/prepare",
                        token=ui,
                        payload={
                            "provider_config_id": provider_id,
                            "recipe_id": "balanced-narrative-v1",
                            "transcript_ids": [],
                            "candidate_source": "cv",
                        },
                    )
                    created = _request(
                        "POST", f"{base}/api/v1/projects/{project_id}/candidate-generations",
                        token=ui,
                        payload={"egress_preview_id": preview["egress_preview_id"],
                                 "payload_sha256": preview["payload_sha256"]},
                    )
                    job = wait_job(base, ui, created["job"]["job_id"], timeout_s=600)
                    if job["status"] != "succeeded":
                        raise RuntimeError(f"生成失败: {job.get('error')}")
                    plans = _request("GET", f"{base}/api/v1/projects/{project_id}/candidate-plans",
                                     token=ui)["items"]
                    experiment_b = {"candidates": []}
                    for plan in plans:
                        detail = _request("GET", f"{base}/api/v1/candidate-plans/{plan['candidate_plan_id']}",
                                          token=ui)
                        experiment_b["candidates"].append({
                            "variant": detail["variant"],
                            "title": detail["title_suggestion"],
                            "duration_s": round(detail["duration_us"] / 1_000_000, 1),
                            "clips": [
                                {"range": f"{c['source_start_us']/1e6:.0f}-{c['source_end_us']/1e6:.0f}s",
                                 "reason": c["reason"][:80]}
                                for c in detail["clips"]
                            ],
                        })
                    report["experiment_b"] = experiment_b
                    print("实验B: 三候选生成成功")
                    for c in experiment_b["candidates"]:
                        print(f"  [{c['variant']}] {c['title']} | {c['duration_s']}s")
                except Exception as exc:
                    report["experiment_b"] = {"error": str(exc)[:300]}
                    print("实验B 异常:", str(exc)[:200])

            if cap_patch.get("timeline_patch_capability_status") != "supported":
                print("patch 能力不支持——跳过实验 C")
            else:
                # ---- 实验 C：AI-1 多步 agent 会话 ----
                try:
                    dance_asset = report["assets"].get("dance", {}).get("asset_id")
                    timeline = _request(
                        "POST", f"{base}/api/v1/projects/{project_id}/timelines", token=ui,
                        payload={"schema_version": 1,
                                 "source": {"kind": "full_asset", "asset_id": dance_asset},
                                 "default_layout": "fit",
                                 "caption_preset_id": "default-bottom"},
                    )
                    state = _request("GET", f"{base}/api/v1/projects/{project_id}/timeline", token=ui)
                    revision_id = state["current_revision"]["timeline_revision_id"]
                    preview = _request(
                        "POST", f"{base}/api/v1/projects/{project_id}/agent-sessions/prepare",
                        token=ui,
                        payload={"base_revision_id": revision_id,
                                 "provider_config_id": provider_id,
                                 "instruction": "把视频剪短一点，保留最精彩的部分"},
                    )
                    created = _request(
                        "POST", f"{base}/api/v1/projects/{project_id}/agent-sessions", token=ui,
                        payload={"agent_session_egress_preview_id": preview["agent_session_egress_preview_id"],
                                 "payload_sha256": preview["payload_sha256"]},
                    )
                    job = wait_job(base, ui, created["job"]["job_id"], timeout_s=900)
                    session = _request("GET", f"{base}/api/v1/agent-sessions/{created['agent_session_id']}",
                                       token=ui)
                    report["experiment_c"] = {
                        "status": session["status"],
                        "steps": [{"ordinal": s["ordinal"], "status": s["status"],
                                   "summary": s.get("summary"),
                                   "error": (s.get("error") or {}).get("code")}
                                  for s in session.get("steps", [])],
                    }
                    print(f"实验C: 会话 {session['status']}, "
                          f"{len([s for s in session.get('steps', []) if s['status'] == 'succeeded'])} 步成功")
                except Exception as exc:
                    report["experiment_c"] = {"error": str(exc)[:300]}
                    print("实验C 异常:", str(exc)[:200])

        with (DATA_DIR / "report.json").open("w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print("报告：", DATA_DIR / "report.json")
    finally:
        proc.terminate()


if __name__ == "__main__":
    main()
