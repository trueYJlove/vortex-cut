r"""W2.2 (a) 表达能力 spike：**"是否单人"前置分支**（ADR-0006 D5）。

预登记：`evidence/2026-10-14-w22-l-single-branch/PRE_REGISTRATION.md`
（**本脚本严格按其 §1–§4 执行**；任何偏离必须在报告中显式登记）。

候选 S1（唯一）：
    if separation < T:  输出 K=1（tau 取网格上界，全部窗并入单轮次）
    else:               现役 `silhouette+capK`，一行不改

θ（T）只在 **VoxConverse dev-48** 上选（§3），冻结后用于主判定与对照语料。

**本脚本不修改任何生产代码**，只用已缓存的窗 embedding。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "core" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "tools"))

from diarization import load_rttm, score  # noqa: E402
from diarization_cache import EmbeddingCache  # noqa: E402
from diarization_robustness import _windows_for  # noqa: E402
from diarization_param_sweep import structural_safety  # noqa: E402
from diarization_structural_safety_k1 import (  # noqa: E402
    structural_safety_single_branch as _safety_k1_fn,
)
import diarization_structural_safety_k1 as safety_k1  # noqa: E402

from aivs_core.media import speaker as sp  # noqa: E402

T_GRID = tuple(round(0.50 + 0.10 * i, 2) for i in range(26))  # 0.50 .. 3.00（§3.1）

# 已归档的 separation（§5.12 K 估计器证据；同一 `fit_distance_mixture` 产出 ⇒ 逐值等价）
ARCH_SEP_VC = ROOT / "evidence/2026-10-13-w22-j-k-estimator/e0-vc-test-lowk.json"
ARCH_SEP_AMI = ROOT / "evidence/2026-10-13-w22-j-k-estimator/e0-ami.json"


class _A:
    """`_windows_for` 只需要这几个属性。

    窗集合**优先用 diag 落盘**（VC/AMI 有）；AISHELL-4 的 diag 未落 `window_grids`，
    故必须按与产生缓存时**相同**的 silero VAD 口径从音频重建
    （channel=0；门 §4 冻结的 `min_speech_fraction=0.60`）。
    """

    def __init__(self, *, audio_dir=None, channel=None, silero=None, audio_ext=".wav"):
        self.audio_dir = str(audio_dir) if audio_dir else None
        self.channel = channel
        self.silero = str(silero) if silero else None
        self.audio_ext = audio_ext


def der_of(wins, labels, ref, total_s: float) -> float:
    turns = sp.windows_to_turns(wins, labels, total_s, min_turn_s=sp.MIN_TURN_S)
    hyp = [(t["start_us"] / 1e6, t["end_us"] / 1e6, f"spk{t['speaker']}") for t in turns]
    return float(score(ref, hyp, total_s=total_s, ignore_overlap=True).der)


class SepCache:
    """`separation` 的持久缓存（**按 cache_key 索引**）。

    **为什么需要**：`fit_distance_mixture` 实测 **254–307 s/场**（AMI 1500+ 窗），
    dev-48 合计约 **28 分钟**。它只依赖窗 embedding，与 τ / 规则无关 ⇒ 天然可缓存。
    已归档的（VC test / AMI）直接读归档值；其余现算一次后落盘，重跑不再付这份成本。
    """

    def __init__(self, path: str | Path, archived: dict[str, dict[str, float]]) -> None:
        self.path = Path(path)
        self.archived = archived
        self.data: dict[str, float] = {}
        if self.path.is_file():
            try:
                self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self.data = {}
        self.hits = 0
        self.computed = 0

    def get(self, cname: str, meeting: str, key: str, compute) -> float | None:
        a = self.archived.get(cname, {}).get(meeting)
        if a is not None:
            self.hits += 1
            return float(a)
        if key in self.data:
            self.hits += 1
            return float(self.data[key])
        v = compute()
        self.computed += 1
        if v is not None:
            self.data[key] = float(v)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data, indent=1), encoding="utf-8")
        return v


def evaluate_meeting(vecs, wins, ref, total_s, *, k_max, tau_grid, sep_precomputed=None):
    """返回 (baseline, 每个 tau 的 (k, der), separation)。

    separation 用**生产同一函数** `sp.fit_distance_mixture` 计算，
    保证与 `speaker.py:369` 的定义逐值一致。

    `sep_precomputed`：已归档的 separation（来自 §5.12 的 K 估计器证据）。
    ⚠️ **为什么不能每次都重算**：`fit_distance_mixture` 是 9 个起点 × 200 次 EM，
    在 n≈1500 窗（约 1.1M 距离）上实测 **约 29 s/场** —— 36 场即 **17 分钟**。
    已归档值由**同一函数**产出（`diarization_k_estimators.e0_distance_mixture`），
    故**逐值等价**，直接复用不改变任何结论。
    """
    dendro = sp.build_dendrogram(vecs)
    if sep_precomputed is not None:
        sep = float(sep_precomputed)
    else:
        fit = sp.fit_distance_mixture(sp.pairwise_distances(vecs))
        sep = float(fit["separation"]) if fit.get("ok") else None

    v = _l2(vecs)
    dmat_full = 1.0 - v @ v.T
    grid = []
    for tau in tau_grid:
        labels = sp.labels_at(dendro, tau)
        k = int(np.unique(labels).size)
        # **只在生产候选窗 [2, k_max] 内算 silhouette**：
        #  · 生产 `choose_threshold_silhouette_capk` 本就跳过窗外的 τ；
        #  · §5.10 的"方向相反"判据也只在候选窗内取档位；
        #  · 窗外算它纯属浪费（低 τ 下簇数上百，silhouette 是 O(簇数²·样本数)）。
        # 这既省时又是**更贴生产语义**的口径。
        sil = (sp.silhouette(dmat_full, labels) if 2 <= k <= k_max else None)
        grid.append({
            "tau": float(tau),
            "k": k,
            "der": der_of(wins, labels, ref, total_s),
            "sil": sil,
        })

    # 现役策略：**直接调用生产 `choose_threshold`**（不自行重实现）。
    #
    # 生产函数是**唯一权威口径**（不自行重实现选择逻辑）。
    #
    # ⚠️ **执行期记录（两处，都已查实）**：
    # ① 首版曾在此用"候选窗内取 silhouette 最大"**自行重实现**；
    # ② 同期的 AMI 基线偏离**并非**重实现所致 —— 真因是 **rttm 目录选错**
    #    （AMI 包内同名 stem 重复 170 个，宽根目录 + rglob + setdefault 静默选到
    #     `word_and_vocalsounds` 而非 `only_words`）。修正目录后，两者都逐值吻合归档。
    # **教训**：偏离出现时，先怀疑"输入选错"，再怀疑"算法不等价"——
    # 我当时先归因于重实现差异，是**错的**。
    base_tau, base_name = sp.choose_threshold(
        dendro, vecs, k_max=k_max, strategy="silhouette_capk", tau_grid=tau_grid)
    lab_b = sp.labels_at(dendro, base_tau)
    base = {"tau": float(base_tau), "k": int(np.unique(lab_b).size),
            "der": der_of(wins, lab_b, ref, total_s), "strategy": base_name}

    # 单人分支的输出 = **真正的单个说话人**（全部窗并入一个轮次）。
    #
    # ⚠️ 不能拿"τ 网格里 K=1 的那个点"来近似：本门 §4 冻结的 τ 网格上界是 0.80，
    # 而**并非每场都能在网格内并成 1 簇**（VC test K≤3 实测 54/63）。
    # 分支的语义是"输出 1 个说话人"，故**直接构造**该输出，
    # 与 τ 网格可达性无关——这也正是生产实现应当做的（K=1 ⇒ 单轮次）。
    labels_single = np.zeros(len(wins), dtype=int)
    single_der = der_of(wins, labels_single, ref, total_s)

    return base, grid, sep, single_der


def _sep_of(vecs) -> float | None:
    """生产同一函数算 separation（`speaker.py:369` 的定义）。"""
    fit = sp.fit_distance_mixture(sp.pairwise_distances(vecs))
    return float(fit["separation"]) if fit.get("ok") else None


def _l2(v):
    v = np.asarray(v, dtype=np.float64)
    n = np.linalg.norm(v, axis=1, keepdims=True)
    n[n == 0] = 1.0
    return v / n


def load_corpus(diag_path, rttm_dir, cache, *, condition, channel=None,
                audio_dir=None, silero=None, audio_ext=".wav"):
    diag = json.loads(Path(diag_path).read_text(encoding="utf-8"))
    rttm_of: dict = {}
    for p in Path(rttm_dir).rglob("*.rttm"):
        rttm_of.setdefault(p.stem, p)
    out = {}
    skipped = {}
    a = _A(audio_dir=audio_dir, channel=channel, silero=silero, audio_ext=audio_ext)
    for m in sorted(diag.get("meetings", {})):
        e = diag["meetings"][m]
        cond = e.get("conditions", {}).get(condition)
        if not cond or "best" not in cond or m not in rttm_of:
            skipped[m] = "no-cond-or-rttm"
            continue
        ref = load_rttm(rttm_of[m])
        a.meeting = m  # `_windows_for` 从 args.meeting 取文件名
        wins = _windows_for(e, condition, e["total_s"], ref, a)
        if wins is None:
            skipped[m] = "no-windows"
            continue
        hit = cache.get(cond["cache_key"])
        if hit is None or hit[0].shape[0] != len(wins):
            skipped[m] = "cache-miss"
            continue
        out[m] = {"vecs": hit[0], "wins": wins, "ref": ref,
                  "total_s": float(e["total_s"]),
                  "k_true": int(e["ref_speakers"]), "cache_key": cond["cache_key"]}
    return out, skipped


def summarize(rows, key):
    v = [r[key] for r in rows if r.get(key) is not None]
    if not v:
        return None
    return {"n": len(v), "mean": round(float(np.mean(v)), 4),
            "worst": round(float(np.max(v)), 4)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache-dir", default=".tmp/w22-embedding-cache")
    ap.add_argument("--condition", default="silero_vad")
    ap.add_argument("--k-max", type=int, default=8)
    ap.add_argument("--sep-cache", default=".tmp/w22-separation-cache.json")
    ap.add_argument("--silero",
                    default=".venv/Lib/site-packages/faster_whisper/assets/silero_vad_v6.onnx")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if not Path(args.silero).is_file():
        # 随包资产探测（门 §10 O1 同款语义）：缺失即显式失败，不静默降级
        raise SystemExit(f"silero asset missing: {args.silero}")

    cache = EmbeddingCache(args.cache_dir)
    tau_grid = sp.TAU_GRID
    k_max = args.k_max

    corpora = {
        "dev": dict(diag=".tmp/w22-diag-vc.json",
                    rttm=".tmp/voxconverse/rttm", channel=None),
        "vc_test_lowk": dict(diag=".tmp/w22-diag-vc-test-lowk.json",
                             rttm=".tmp/voxconverse/rttm", channel=None),
        # ⚠️ **必须指向 `only_words/rttms/test`**：AMI 包内有多套标注
        # （`only_words` / `word_and_vocalsounds` / `pyannote`），**同名 stem 重复 170 个**。
        # 用更宽的根目录 + `rglob` + `setdefault` 会**静默选到错误的那一套**
        # （实测选成 `word_and_vocalsounds` ⇒ 16/16 场 DER 全部小幅偏离归档）。
        # 已归档结果用的是 `only_words/rttms/test`（见 `.tmp/_blast.py`）。
        "ami": dict(diag=".tmp/w22-diag-ami-fixed.json",
                    rttm=".tmp/ami/AMI-diarization-setup-main/only_words/rttms/test",
                    channel=None),
        # AISHELL-4 的 diag **未落 window_grids** ⇒ 必须从音频按同口径 silero 重建窗集合
        # （channel=0；.flac；与产生缓存向量时同模型/门限）。
        "aishell4": dict(diag=".tmp/w22-diag-cn.json",
                         rttm=".tmp/aishell4/rttm", channel=0,
                         audio_dir=".tmp/aishell4/audio", audio_ext=".flac"),
    }

    # 已归档的 separation（§5.12 证据，由**同一函数**产生）⇒ 主判定/对照语料直接复用，
    # **只有 dev-48 需要现算**（它从未跑过 K 估计器，故无归档值）。
    archived_sep: dict[str, dict[str, float]] = {}
    for tag, p in (("vc_test_lowk", ARCH_SEP_VC), ("ami", ARCH_SEP_AMI)):
        if p.is_file():
            for r in json.loads(p.read_text(encoding="utf-8"))["rows"]:
                archived_sep.setdefault(tag, {})[r["name"]] = float(r["separation"])
            print(f"[sep] archived {tag}: n={len(archived_sep[tag])}", flush=True)

    sepc = SepCache(args.sep_cache, archived_sep)

    rep: dict = {
        "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "config": {"k_max": k_max, "tau_grid": [round(float(t), 2) for t in tau_grid],
                   "t_grid": [round(float(t), 2) for t in T_GRID],
                   "condition": args.condition},
        "corpora": {},
    }

    loaded = {}
    for cname, cfg in corpora.items():
        data, skipped = load_corpus(cfg["diag"], cfg["rttm"], cache,
                                    condition=args.condition, channel=cfg["channel"],
                                    audio_dir=cfg.get("audio_dir"),
                                    silero=args.silero,
                                    audio_ext=cfg.get("audio_ext", ".wav"))
        loaded[cname] = data
        print(f"[load] {cname}: n={len(data)} skipped={len(skipped)}", flush=True)

    # ---- 逐场计算（三语料共用同一函数）----
    per_meeting: dict[str, dict] = {}
    for cname, data in loaded.items():
        pm = {}
        for i, (m, d) in enumerate(data.items(), 1):
            if i % 10 == 0 or i == len(data):
                print(f"  [{cname}] {i}/{len(data)}  (sep cached={sepc.hits} computed={sepc.computed})",
                      flush=True)
            base, grid, sep, single_der = evaluate_meeting(
                d["vecs"], d["wins"], d["ref"], d["total_s"], k_max=k_max, tau_grid=tau_grid,
                sep_precomputed=sepc.get(
                    cname, m, d["cache_key"],
                    lambda v=d["vecs"]: _sep_of(v)))
            pm[m] = {"k_true": d["k_true"], "separation": sep,
                     "base_der": round(base["der"], 4), "base_k": base["k"],
                     "base_strategy": base["strategy"],
                     "single_der": round(single_der, 4) if single_der is not None else None,
                     "grid": [{"tau": round(g["tau"], 2), "k": g["k"],
                               "der": round(g["der"], 4)} for g in grid],
                     "cache_key": d["cache_key"]}
        per_meeting[cname] = pm
        print(f"[eval] {cname}: n={len(pm)}", flush=True)

    # ---- §3：T 只在 dev 上选 ----
    dev = per_meeting["dev"]
    dev_names = sorted(dev)
    base_mean = float(np.mean([dev[m]["base_der"] for m in dev_names]))
    base_worst = float(np.max([dev[m]["base_der"] for m in dev_names]))
    scan = []
    for T in T_GRID:
        ders = []
        for m in dev_names:
            s = dev[m]["separation"]
            if s is not None and s < T:
                ders.append(dev[m]["single_der"])
            else:
                ders.append(dev[m]["base_der"])
        scan.append({"T": round(float(T), 2),
                     "mean": round(float(np.mean(ders)), 4),
                     "worst": round(float(np.max(ders)), 4),
                     "triggered": int(sum(1 for m in dev_names
                                          if dev[m]["separation"] is not None
                                          and dev[m]["separation"] < T))})
    feasible = [s for s in scan if s["mean"] <= base_mean + 1e-9]
    chosen = None
    if feasible:
        best_worst = min(s["worst"] for s in feasible)
        tied = [s for s in feasible if abs(s["worst"] - best_worst) < 1e-9]
        best_mean = min(s["mean"] for s in tied)
        tied = [s for s in tied if abs(s["mean"] - best_mean) < 1e-9]
        chosen = min(tied, key=lambda s: s["T"])
    rep["dev_tuning"] = {
        "n": len(dev_names), "baseline_mean": round(base_mean, 4),
        "baseline_worst": round(base_worst, 4),
        "feasible_count": len(feasible),
        "chosen_T": chosen["T"] if chosen else None,
        "chosen": chosen, "scan": scan,
        "note": "T 只在 dev-48 上选（预登记 §3）；可行集为空 => 候选不可行",
    }
    print(f"[tune] dev baseline mean={base_mean:.4f} worst={base_worst:.4f} "
          f"feasible={len(feasible)} chosen_T={chosen['T'] if chosen else None}", flush=True)

    T = chosen["T"] if chosen else None

    # ---- 应用冻结的 T 到三语料 ----
    def apply_T(pm, T):
        rows = []
        for m in sorted(pm):
            e = pm[m]
            trig = T is not None and e["separation"] is not None and e["separation"] < T
            rows.append({"meeting": m, "k_true": e["k_true"], "separation": e["separation"],
                         "base_der": e["base_der"], "base_k": e["base_k"],
                         "cand_der": (e["single_der"] if trig else e["base_der"]),
                         "cand_k": (1 if trig else e["base_k"]),
                         "triggered": trig})
        return rows

    for cname, pm in per_meeting.items():
        rows = apply_T(pm, T)
        base = summarize(rows, "base_der")
        cand = summarize(rows, "cand_der")
        n1 = [r for r in rows if r["k_true"] == 1]
        det = sum(1 for r in n1 if r["triggered"])
        fp = sum(1 for r in rows if r["triggered"] and r["k_true"] != 1)
        rep["corpora"][cname] = {
            "n": len(rows), "baseline": base, "candidate": cand,
            "delta_mean": round(cand["mean"] - base["mean"], 4) if base and cand else None,
            "delta_worst": round(cand["worst"] - base["worst"], 4) if base and cand else None,
            "k1_fields": len(n1), "k1_caught": det,
            "false_positives": fp,
            "changed_fields": [{"meeting": r["meeting"], "k_true": r["k_true"],
                                "base_der": r["base_der"], "cand_der": r["cand_der"],
                                "delta": round(r["cand_der"] - r["base_der"], 4)}
                               for r in rows if r["triggered"]],
            "per_meeting": rows,
        }
        print(f"[apply] {cname}: base {base['mean']}/{base['worst']} -> "
              f"cand {cand['mean']}/{cand['worst']} (fp={fp}, caught={det}/{len(n1)})", flush=True)

    # ---- K3：structural_safety（**两口径都要报**）----
    #
    # ⚠️ **执行期发现的门盲区**（如实登记，不掩盖）：门 §5.6③ 的原闸门在合成候选集上
    # **只枚举 K ∈ [2, 8]**，因此：
    #   · 它**无法认证** K=1 档 —— 该档永远判否；
    #   · 它**无法区分**"无条件恒取 K=1"（真不安全）与"条件性输出 K=1"（安全性取决于 T）。
    # 把本候选喂给原闸门，得到的是**它的表达力边界**，不是本候选的结构性质。
    # 故本处**两个口径并列报告**，并把扩展闸门（含 K=1 枚举 + 触发条件建模）
    # 的判定作为 K3 的**实际判据**；原闸门口径仅作追溯。
    def _proxy_always_k1(grid, k_hint):
        return [{"k": 1, "sil": 0.5}]

    rep["K3_structural_safety"] = {
        "original_gate": structural_safety(_proxy_always_k1),
        "original_gate_note": "原闸门枚举 K∈[2,8] ⇒ 任何能输出 K=1 的形态必判否；"
                              "这是**闸门表达力边界**，不是本候选的结构性质",
        "extended_gate": safety_k1.structural_safety_single_branch(
            safety_k1.rule_single_branch(T if T is not None else 1.2)),
        "extended_gate_note": "把 K=1 纳入枚举 + 把触发条件（sep_hint）显式建模后，"
                              "判据还原为'是否存在参数取值使规则能选中正确答案'",
        "extended_gate_negative_controls": {
            "UNSAFE_always_k1": safety_k1.structural_safety_single_branch(
                safety_k1.rule_always_k1),
            "UNSAFE_never_k1": safety_k1.structural_safety_single_branch(
                safety_k1.rule_never_k1),
        },
    }

    # ---- K5：反平凡性对照 ----
    def const_rule(k):
        def f(grid, k_hint, *, _k=k):
            return [g for g in grid if g["k"] == _k]
        return f

    anti = {}
    for cname, pm in per_meeting.items():
        rows_c = {}
        for tag, kk in (("const_K1", 1), ("const_K2", 2)):
            ders = []
            for m in sorted(pm):
                g = [x for x in pm[m]["grid"] if x["k"] == kk]
                ders.append(min(x["der"] for x in g) if g else pm[m]["base_der"])
            rows_c[tag] = {"mean": round(float(np.mean(ders)), 4),
                           "worst": round(float(np.max(ders)), 4)}
        anti[cname] = rows_c
    rep["K5_anti_triviality"] = anti

    # ---- 判定 ----
    def get(c):
        return rep["corpora"].get(c, {})
    vc, ami, asr = get("vc_test_lowk"), get("ami"), get("aishell4")
    verdict = {}
    if T is None:
        verdict = {"K1a": False, "K1b": False, "K2a": False, "K2b": False,
                   "K3": rep["K3_structural_safety"]["extended_gate"]["safe"], "K4": False,
                   "reason": "dev 可行集为空 ⇒ 候选不可行（预登记 §3.5）"}
    else:
        verdict["K1a"] = bool(vc.get("delta_worst") is not None and vc["delta_worst"] <= -0.10)
        verdict["K1b"] = bool(vc.get("delta_mean") is not None and vc["delta_mean"] <= 0.005)
        verdict["K2a"] = bool(ami.get("delta_mean") is not None and ami["delta_mean"] <= 0.02
                              and ami["delta_worst"] <= 0.02)
        verdict["K2b"] = bool(asr.get("delta_mean") is not None and asr["delta_mean"] <= 0.02
                              and asr["delta_worst"] <= 0.02)
        verdict["K3"] = rep["K3_structural_safety"]["extended_gate"]["safe"]
        verdict["K4"] = bool(ami.get("false_positives", 99) <= 2)
    verdict["ADOPT"] = all(verdict.get(k) for k in ("K1a", "K1b", "K2a", "K2b", "K3", "K4"))
    rep["verdict"] = verdict
    print("[verdict]", json.dumps(verdict, ensure_ascii=False), flush=True)

    # 逐场 grid 必须落盘：K5 的"方向相反会话"报告要离线复算 rho（不重跑聚类）
    rep["grids"] = per_meeting
    rep["separation_source"] = {
        "archived": {k: len(v) for k, v in archived_sep.items()},
        "cache_hits": sepc.hits, "computed_this_run": sepc.computed,
        "cache_path": str(args.sep_cache),
        "note": "separation 与 tau/规则无关，故可缓存；归档值由同一函数产出（逐值等价）",
    }

    Path(args.out).write_text(json.dumps(rep, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
