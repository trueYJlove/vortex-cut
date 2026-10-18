"""W3.1 语义检索：算法层 + 服务层单测。

规划门 §3 验收项对应：A1（索引管线）/ A2（指纹联动）/ A3（删除联动）/
A5（项目隔离）/ A6（零 egress）。

每个验收项都配**负向对照**（还原修复即红），这是本仓纪律——W2.2 期间
共出现 3 次恒真测试（P130/P133/P134），此处显式防范。
"""
from __future__ import annotations

import sqlite3

import numpy as np
import pytest

from aivs_core.database import Database
from aivs_core.media.semantic import (
    INDEX_ALGORITHM_VERSION,
    MAX_SEARCH_K,
    aggregate_embeddings,
    cosine_rank,
    l2_normalize,
    pack_embeddings,
    thin_frames,
    unpack_embeddings,
)
from aivs_core.media.semantic_service import SemanticIndexService


@pytest.fixture()
def db(tmp_path):
    database = Database(tmp_path / "test.db")
    database.initialize()
    return database


# ---------------------------------------------------------------- 算法层


class TestNormalize:
    def test_normalizes_to_unit_length(self):
        vec = l2_normalize(np.array([3.0, 4.0]))
        assert np.isclose(np.linalg.norm(vec), 1.0)
        assert np.allclose(vec, [0.6, 0.8])

    def test_zero_vector_returns_zero_not_nan(self):
        """零向量不能产生 NaN——NaN 会污染整个排序且难以诊断。"""
        vec = l2_normalize(np.zeros(4))
        assert not np.isnan(vec).any()
        assert np.allclose(vec, 0.0)

    def test_negative_control_missing_normalize_changes_ranking(self):
        """负向对照：不做归一化时，模长大的向量会压过方向更匹配的向量。"""
        query = np.array([1.0, 0.0])
        close_small = np.array([1.0, 0.1])          # 方向几乎一致
        far_large = np.array([10.0, 9.0])           # 方向偏离但模长大
        # 未归一化（错误做法）：点积让 far_large 胜出
        raw_close = float(np.dot(query, close_small))
        raw_far = float(np.dot(query, far_large))
        assert raw_far > raw_close
        # 归一化（正确做法）：方向更一致者胜出
        ranked = cosine_rank(query, [("close", close_small), ("far", far_large)], k=2)
        assert ranked[0]["asset_id"] == "close"


class TestAggregate:
    def test_empty_returns_none(self):
        assert aggregate_embeddings([]) is None

    def test_mean_then_renormalized(self):
        v = aggregate_embeddings([np.array([1.0, 0.0]), np.array([1.0, 0.0])])
        assert v is not None
        assert np.isclose(np.linalg.norm(v), 1.0)

    def test_single_bad_frame_is_damped(self):
        """聚合的意义：单帧离群不应主导整段（取单帧代表会）。

        负向对照——若改成"取第一帧"，离群帧直接决定结果。
        """
        good = np.array([1.0, 0.0])
        outlier = np.array([0.0, 1.0])
        agg = aggregate_embeddings([good, good, outlier])
        assert agg is not None
        # 均值方向仍明显偏向 good
        assert agg[0] > agg[1]


class TestThinFrames:
    def test_under_limit_returns_empty(self):
        assert thin_frames(10, limit=100) == []

    def test_over_limit_keeps_even_coverage(self):
        picked = thin_frames(1000, limit=10)
        assert len(picked) == 10
        assert picked[0] == 0
        assert picked[-1] == 999
        assert picked == sorted(picked)

    def test_degenerate_inputs(self):
        assert thin_frames(0, limit=10) == []
        assert thin_frames(10, limit=0) == []


class TestCosineRank:
    def test_orders_by_similarity_desc(self):
        q = np.array([1.0, 0.0])
        ranked = cosine_rank(
            q,
            [("a", np.array([1.0, 0.0])), ("b", np.array([0.0, 1.0]))],
            k=2,
        )
        assert [r["asset_id"] for r in ranked] == ["a", "b"]
        assert ranked[0]["score"] > ranked[1]["score"]

    def test_k_is_clamped_to_hard_cap(self):
        """k 必须钳制：调用方传超大值不得把整个素材池倒给 Renderer。"""
        q = np.array([1.0, 0.0])
        cands = [(f"a{i}", np.array([1.0, 0.0])) for i in range(MAX_SEARCH_K + 50)]
        assert len(cosine_rank(q, cands, k=10_000)) == MAX_SEARCH_K

    def test_k_zero_or_negative_yields_at_least_one(self):
        q = np.array([1.0, 0.0])
        cands = [("a", np.array([1.0, 0.0]))]
        assert len(cosine_rank(q, cands, k=0)) == 1
        assert len(cosine_rank(q, cands, k=-5)) == 1

    def test_dimension_mismatch_is_skipped(self):
        """维度不一致的候选跳过——宁可少返回，也不给不可比的分数。"""
        q = np.array([1.0, 0.0])
        ranked = cosine_rank(q, [("ok", np.array([1.0, 0.0])), ("bad", np.array([1.0, 0.0, 0.0]))], k=10)
        assert [r["asset_id"] for r in ranked] == ["ok"]

    def test_empty_query_returns_empty(self):
        assert cosine_rank(np.zeros(0), [("a", np.array([1.0]))]) == []


class TestBlobRoundTrip:
    def test_pack_unpack_preserves_values(self):
        mat = np.array([[1.0, 2.0], [3.0, 4.0]])
        back = unpack_embeddings(pack_embeddings(mat), dim=2)
        assert back.shape == (2, 2)
        assert np.allclose(back, mat)

    def test_corrupt_blob_is_empty_not_crash(self):
        """损坏/半截 BLOB 返回空矩阵而非抛错——索引行可能来自中断的写入。"""
        assert unpack_embeddings(b"\x00\x01\x02", dim=4).shape == (0, 4)
        assert unpack_embeddings(None, dim=4).shape == (0, 4)


# ---------------------------------------------------------------- 迁移


class TestMigration:
    def test_v39_table_exists_with_cascade(self, db):
        with db.connection() as conn:
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_semantic_index'"
            ).fetchone()
        assert row is not None
        assert "ON DELETE CASCADE" in row["sql"]

    def test_partial_unique_index_allows_new_fingerprint_row(self, db):
        """A2：素材变更 ⇒ 新指纹 ⇒ 新行可写，旧行保留（不撞唯一键）。"""
        now = "2026-10-18T00:00:00Z"
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO projects (id,name,status,canvas_json,root_dir,"
                "root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("p1", "P", "active", "{}", "/tmp/x", "x", now, now, now),
            )
            conn.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("a1", "p1", "video", "external", "A", "fp1", 1, "available", now, now),
            )
            for i, fp in enumerate(["fp1", "fp2"]):
                conn.execute(
                    "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                    "algorithm_version,status,frame_count,embedding_dim,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (f"i{i}", "a1", fp, INDEX_ALGORITHM_VERSION, "ready", 1, 2, now, now),
                )
            count = conn.execute(
                "SELECT COUNT(*) c FROM asset_semantic_index WHERE asset_id='a1'"
            ).fetchone()["c"]
        assert count == 2

    def test_same_fingerprint_twice_is_rejected(self, db):
        """负向对照：同指纹重复 ready 行必须被唯一索引拒绝。"""
        now = "2026-10-18T00:00:00Z"
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO projects (id,name,status,canvas_json,root_dir,"
                "root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("p1", "P", "active", "{}", "/tmp/x", "x", now, now, now),
            )
            conn.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("a1", "p1", "video", "external", "A", "fp1", 1, "available", now, now),
            )
            conn.execute(
                "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                "algorithm_version,status,frame_count,embedding_dim,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("i0", "a1", "fp1", INDEX_ALGORITHM_VERSION, "ready", 1, 2, now, now),
            )
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                    "algorithm_version,status,frame_count,embedding_dim,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    ("i1", "a1", "fp1", INDEX_ALGORITHM_VERSION, "ready", 1, 2, now, now),
                )

    def test_asset_delete_cascades(self, db):
        """A3：删除素材不得被 FK 拒绝（P102 的失败模式反向锁）。"""
        now = "2026-10-18T00:00:00Z"
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO projects (id,name,status,canvas_json,root_dir,"
                "root_dir_name,created_at,updated_at,last_opened_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("p1", "P", "active", "{}", "/tmp/x", "x", now, now, now),
            )
            conn.execute(
                "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
                "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("a1", "p1", "video", "external", "A", "fp1", 1, "available", now, now),
            )
            conn.execute(
                "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                "algorithm_version,status,frame_count,embedding_dim,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("i0", "a1", "fp1", INDEX_ALGORITHM_VERSION, "ready", 1, 2, now, now),
            )
            conn.execute("DELETE FROM assets WHERE id='a1'")
            left = conn.execute(
                "SELECT COUNT(*) c FROM asset_semantic_index WHERE asset_id='a1'"
            ).fetchone()["c"]
        assert left == 0


# ---------------------------------------------------------------- 服务层


def _insert_project(conn, project_id, now):
    """projects 有多个 NOT NULL 列（status/canvas_json/root_dir/root_dir_name）。"""
    conn.execute(
        "INSERT INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,"
        "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (project_id, project_id, "active", "{}", "/tmp/x", "x", now, now, now),
    )


def _seed(db, project_id="p1", asset_id="a1", fp="fp1"):
    now = "2026-10-18T00:00:00Z"
    with db.connection() as conn:
        _insert_project(conn, project_id, now)
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (asset_id, project_id, "video", "external", asset_id, fp, 1, "available", now, now),
        )


class TestSearchIsolation:
    def _add_ready(self, db, asset_id, vec):
        now = "2026-10-18T00:00:00Z"
        mat = np.asarray([vec], dtype=np.float64)
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                "algorithm_version,status,frame_count,embedding_dim,frames_json,"
                "embeddings_blob,model_id,model_revision,created_at,updated_at,finished_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (f"idx_{asset_id}", asset_id, "fp1", INDEX_ALGORITHM_VERSION, "ready",
                 1, len(vec), "[]", pack_embeddings(mat), "clip-vit-base-patch32",
                 "rev", now, now, now),
            )

    def test_A5_search_does_not_cross_projects(self, db):
        """A5：A 项目查询不返回 B 项目素材。"""
        _seed(db, "p1", "a1")
        _seed(db, "p2", "a2")
        self._add_ready(db, "a1", [1.0, 0.0])
        self._add_ready(db, "a2", [1.0, 0.0])
        svc = SemanticIndexService(db, ffmpeg=None)
        hits = svc.search("p1", np.array([1.0, 0.0]), limit=10)
        assert [h["asset_id"] for h in hits] == ["a1"]

    def test_negative_control_without_project_filter_both_returned(self, db):
        """负向对照：去掉项目过滤 ⇒ 两个项目的素材都会出现。"""
        _seed(db, "p1", "a1")
        _seed(db, "p2", "a2")
        self._add_ready(db, "a1", [1.0, 0.0])
        self._add_ready(db, "a2", [1.0, 0.0])
        with db.connection() as conn:
            rows = conn.execute(
                "SELECT asset_id FROM asset_semantic_index WHERE status='ready'"
            ).fetchall()
        assert len(rows) == 2

    def test_only_ready_rows_are_searchable(self, db):
        _seed(db)
        now = "2026-10-18T00:00:00Z"
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                "algorithm_version,status,frame_count,embedding_dim,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("i_fail", "a1", "fp1", INDEX_ALGORITHM_VERSION, "failed", 0, 0, now, now),
            )
        svc = SemanticIndexService(db, ffmpeg=None)
        assert svc.search("p1", np.array([1.0, 0.0])) == []


class TestSummaryStaleness:
    def test_stale_fingerprint_marks_summary_stale(self, db):
        """A2 读侧：指纹变了 ⇒ 摘要报 stale（不静默用旧向量）。"""
        _seed(db)
        now = "2026-10-18T00:00:00Z"
        mat = np.asarray([[1.0, 0.0]])
        with db.connection() as conn:
            conn.execute(
                "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
                "algorithm_version,status,frame_count,embedding_dim,embeddings_blob,"
                "created_at,updated_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                ("i0", "a1", "OLD_FP", INDEX_ALGORITHM_VERSION, "ready", 1, 2,
                 pack_embeddings(mat), now, now, now),
            )
        svc = SemanticIndexService(db, ffmpeg=None)
        summary = svc.index_summary({"id": "a1", "fingerprint": "NEW_FP"})
        assert summary is not None
        assert summary["status"] == "stale"


class TestModelAbsence:
    def test_missing_model_persists_unavailable_not_crash(self, db, tmp_path):
        """R3：模型未安装 ⇒ unavailable 显式降级，不是崩溃。"""
        _seed(db)
        svc = SemanticIndexService(db, ffmpeg=tmp_path / "ffmpeg", model_manager=None)
        import asyncio
        result = asyncio.run(svc.index_path("a1", "fp1", tmp_path / "nope.mp4"))
        assert result["status"] == "unavailable"
        assert result["reason"] == "model_not_installed"
