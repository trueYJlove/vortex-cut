"""W2.2 派生 embedding 缓存（S0 ③）—— pytest 形态。

Design Gate §6 S0 ③ 要求：目录 + 以（素材指纹，模型 id，算法版本）为键 +
缓存文件 sha256 + 复算清单。本文件钉死三件事：
1. 键对**每一维输入**敏感（改模型/改参数/改指纹都必须换键）——否则会静默复用错向量；
2. 读时 **sha256 校验**：损坏的缓存必须视为未命中，不得返回脏数据；
3. **复算清单**能区分 verified / unverified。
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
QE = ROOT / "tools" / "quality_eval"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


cache_mod = _load("quality_eval_diarization_cache", QE / "diarization_cache.py")

PARAMS = {"window_s": 2.0, "hop_s": 1.0, "min_speech_fraction": 0.60}


class TestKeySensitivity:
    """键必须对每一维输入敏感——任何一维变了都必须换键。"""

    def test_same_inputs_same_key(self):
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        b = cache_mod.embedding_cache_key("fp1", "campplus", 1, dict(PARAMS))
        assert a == b

    def test_fingerprint_changes_key(self):
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        b = cache_mod.embedding_cache_key("fp2", "campplus", 1, PARAMS)
        assert a != b

    def test_model_changes_key(self):
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        b = cache_mod.embedding_cache_key("fp1", "resnet34", 1, PARAMS)
        assert a != b

    def test_algorithm_version_changes_key(self):
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        b = cache_mod.embedding_cache_key("fp1", "campplus", 2, PARAMS)
        assert a != b

    def test_window_params_change_key(self):
        # **这一条最关键**：改窗长却复用旧向量会让精度结论完全错位
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        b = cache_mod.embedding_cache_key("fp1", "campplus", 1, {**PARAMS, "window_s": 3.0})
        assert a != b

    def test_key_is_path_independent(self):
        # 键里不得含路径成分 ⇒ 同一素材换目录仍命中（内容寻址）
        k = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        assert "/" not in k and "\\" not in k and len(k) == 64


class TestSelectionFingerprintRegression:
    """**回归锁（2026-10-12 实测缺陷）**：缓存键必须包含"选了哪些窗"。

    本实现首版只把 window_s/hop_s/min_speech_fraction 放进 params，于是
    "silero 选的窗"与"参考标注选的窗（oracle_vad）"算出**同一个键** ⇒
    后者静默复用前者的向量，使"分离 VAD 与聚类"的诊断得出**错误结论**。
    该同键已在 2026-10-12 实测确认。本用例防它复发。
    """

    def test_selection_field_changes_key(self):
        # 同一素材/模型/窗参数，仅"窗集合"不同 ⇒ 必须换键
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, {**PARAMS, "selection": "aaa"})
        b = cache_mod.embedding_cache_key("fp1", "campplus", 1, {**PARAMS, "selection": "bbb"})
        assert a != b, "窗选取不同却同键 ⇒ 会静默复用错向量"

    def test_vad_model_field_changes_key(self):
        # 换 VAD 模型（v5/v6）必须换键
        a = cache_mod.embedding_cache_key("fp1", "campplus", 1, {**PARAMS, "vad_model": "v5"})
        b = cache_mod.embedding_cache_key("fp1", "campplus", 1, {**PARAMS, "vad_model": "v6"})
        assert a != b

    def test_eval_harness_includes_selection_and_vad_in_params(self):
        """**端到端锁**：评测 harness 构造的 params 必须含 selection 与 vad_model。

        直接读源码断言，防止将来有人"简化"掉这两项（那会静默恢复该缺陷）。
        """
        src = (QE / "diarization_eval.py").read_text(encoding="utf-8")
        assert '"selection": sel_fingerprint' in src
        assert '"vad_model": Path(silero_model).name' in src
        assert "_selection_fingerprint" in src


class TestRoundTrip:
    def test_put_then_get(self, tmp_path: Path):
        c = cache_mod.EmbeddingCache(tmp_path / "cache")
        vecs = np.arange(12, dtype=np.float32).reshape(6, 2)
        key = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        c.put(key, vecs, asset_fingerprint="fp1", model_id="campplus", params=PARAMS)
        hit = c.get(key)
        assert hit is not None
        got, meta = hit
        assert np.array_equal(got, vecs)
        assert meta["shape"] == [6, 2] and meta["model_id"] == "campplus"

    def test_miss_returns_none(self, tmp_path: Path):
        c = cache_mod.EmbeddingCache(tmp_path / "cache")
        assert c.get("0" * 64) is None

    def test_get_or_compute_skips_second_compute(self, tmp_path: Path):
        c = cache_mod.EmbeddingCache(tmp_path / "cache")
        calls = {"n": 0}

        def compute():
            calls["n"] += 1
            return np.ones((3, 4), dtype=np.float32)

        key = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        v1, cached1 = c.get_or_compute(
            key, compute, asset_fingerprint="fp1", model_id="campplus", params=PARAMS
        )
        v2, cached2 = c.get_or_compute(
            key, compute, asset_fingerprint="fp1", model_id="campplus", params=PARAMS
        )
        assert calls["n"] == 1  # **重聚类不重跑推理**的基础
        assert cached1 is False and cached2 is True
        assert np.array_equal(v1, v2)


class TestIntegrity:
    def test_corrupted_npz_is_a_miss(self, tmp_path: Path):
        """负向对照：篡改缓存字节 ⇒ 必须视为未命中，不得返回脏数据。"""
        c = cache_mod.EmbeddingCache(tmp_path / "cache")
        key = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        c.put(
            key, np.ones((4, 3), dtype=np.float32),
            asset_fingerprint="fp1", model_id="campplus", params=PARAMS,
        )
        assert c.get(key) is not None
        p = c.npz_path(key)
        p.write_bytes(p.read_bytes() + b"tampered")
        assert c.get(key) is None

    def test_manifest_flags_corruption(self, tmp_path: Path):
        c = cache_mod.EmbeddingCache(tmp_path / "cache")
        key = cache_mod.embedding_cache_key("fp1", "campplus", 1, PARAMS)
        c.put(
            key, np.ones((4, 3), dtype=np.float32),
            asset_fingerprint="fp1", model_id="campplus", params=PARAMS,
        )
        m = c.write_manifest(tmp_path / "manifest.json")
        assert m["total"] == 1 and m["verified"] == 1 and m["unverified"] == 0
        # 破坏后再算清单：必须报 unverified（复算清单的意义）
        p = c.npz_path(key)
        p.write_bytes(b"broken")
        m2 = c.write_manifest(tmp_path / "manifest2.json")
        assert m2["unverified"] == 1 and m2["entries"][0]["verified"] is False
        assert json.loads((tmp_path / "manifest2.json").read_text(encoding="utf-8"))["total"] == 1

    def test_file_fingerprint_is_content_based(self, tmp_path: Path):
        a = tmp_path / "a.bin"
        a.write_bytes(b"hello")
        b = tmp_path / "b.bin"
        b.write_bytes(b"hello")
        assert cache_mod.file_fingerprint(a) == cache_mod.file_fingerprint(b)
        b.write_bytes(b"world")
        assert cache_mod.file_fingerprint(a) != cache_mod.file_fingerprint(b)


class TestNoPathEscape:
    def test_entry_dir_is_under_root(self, tmp_path: Path):
        root = tmp_path / "cache"
        c = cache_mod.EmbeddingCache(root)
        d = c.entry_dir("ab" + "0" * 62)
        assert root.resolve() in d.resolve().parents
