"""W2.2 降级交付（D3）：质量标注的存储/契约回归（设计门 2026-10-14 §3 A1–A3/A5）。

背景：S3 判精度门三项全不过（门 §5.20），§5.21 又否决了「只交付高置信区间」
⇒ 采纳 D3「输出不变，只标注」。本套件钉死三件事：

  A1 三条标注字段**随每次落库写出**（不依赖列默认值）
  A2 标注**不可静默缺省**——历史行回填 `unvalidated`（默认安全侧）
  A3 标注必须**透出到摘要 DTO**（只存表里等于下游看不见）
  A5 **不得**出现「部分可用」语义（`usable_for` 不含 `multicam_switch`）

负向对照（实施时实跑，见提交信息）：
  - 去掉 INSERT 里的三列 ⇒ A1 红；
  - 去掉 summary 的三字段 ⇒ A3 红；
  - 把 `USABLE_FOR_REFERENCE_ONLY` 改成含 `multicam_switch` ⇒ A5 红。
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database, json_dumps, utc_now
from aivs_core.media import speaker_service as svc
from aivs_core.media.speaker_service import SpeakerDiarizationService

from test_speaker_storage import _StubEmbedder, _asset_row, _pcm, _service


class TestQualityAnnotation:
    """A1/A2/A3/A5：标注的写入、回填、透出与取值约束。"""

    def test_annotation_is_written_on_every_insert(self, tmp_path: Path) -> None:
        """A1：三字段随落库写出，且**不依赖列默认值**。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 1, 1])
        result = service.analyze_pcm(
            "a1", "sha256:aaa", pcm, voiced=voiced, embedder=_StubEmbedder([0, 0, 1, 1]),
            threshold=0.5)
        with db.connection() as con:
            row = dict(con.execute(
                "SELECT quality_status,quality_basis,usable_for FROM speaker_diarizations "
                "WHERE id=?", (result["speaker_diarization_id"],)).fetchone())
        assert row["quality_status"] == "unvalidated"
        assert row["quality_basis"] == svc.QUALITY_GATE_BASIS
        assert json.loads(row["usable_for"]) == ["reference"]

    def test_annotation_default_is_safe_side_for_existing_rows(self, tmp_path: Path) -> None:
        """A2：直接以 SQL 插入（绕过服务）时，列默认值必须是**未验证**而不是已验证。

        这条钉的是「静默缺省」这一失败模式：下游若把缺省当已验证，
        比精度不过本身更危险。
        """
        db, _ = _service(tmp_path)
        now = utc_now()
        with db.connection() as con:
            con.execute(
                "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                "algorithm_version,status,turns_json,windows_json,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("r1", "a1", "sha256:aaa", 1, "ready", "[]", "[]", now, now),
            )
            row = dict(con.execute(
                "SELECT quality_status,usable_for FROM speaker_diarizations WHERE id=?",
                ("r1",)).fetchone())
        assert row["quality_status"] == "unvalidated"
        assert json.loads(row["usable_for"]) == ["reference"]

    def test_annotation_is_surfaced_in_summary(self, tmp_path: Path) -> None:
        """A3：摘要必须带出三字段（只存表里等于下游看不见）。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 1, 1])
        service.analyze_pcm(
            "a1", "sha256:aaa", pcm, voiced=voiced, embedder=_StubEmbedder([0, 0, 1, 1]),
            threshold=0.5)
        summary = service.summary(_asset_row(db))
        assert summary is not None
        assert summary["quality_status"] == "unvalidated"
        assert summary["quality_basis"] == svc.QUALITY_GATE_BASIS
        assert summary["usable_for"] == ["reference"]

    def test_summary_never_claims_multicam_switch(self, tmp_path: Path) -> None:
        """A5：`multicam_switch` **恒不在**允许用途里（本门最硬的下游约束）。"""
        db, service = _service(tmp_path)
        pcm, voiced = _pcm([0, 0, 1, 1])
        service.analyze_pcm(
            "a1", "sha256:aaa", pcm, voiced=voiced, embedder=_StubEmbedder([0, 0, 1, 1]),
            threshold=0.5)
        summary = service.summary(_asset_row(db))
        assert "multicam_switch" not in summary["usable_for"]
        assert summary["quality_status"] != "validated"

    def test_quality_status_check_constraint_rejects_unknown_value(self, tmp_path: Path) -> None:
        """结构锁：`quality_status` 只接受两个取值（防拼写漂移）。

        ⚠️ 本用例的初版**恒真**（2026-10-16 修正）：它用 `raise AssertionError` 表达
        "INSERT 不该成功"，却把该断言交给同一个 `except Exception` 捕获——
        于是"CHECK 被移除"这一失败模式反而让用例**通过**（实测：移除 CHECK 后
        `'bogus'` 可入库、用例仍绿）。现改为 `pytest.raises(sqlite3.IntegrityError)`：
        约束缺失时**异常类型不符**，用例必红（复验见实施记录 §4）。
        """
        db, _ = _service(tmp_path)
        now = utc_now()
        with db.connection() as con:
            with pytest.raises(sqlite3.IntegrityError) as excinfo:
                con.execute(
                    "INSERT INTO speaker_diarizations(id,asset_id,source_fingerprint,"
                    "algorithm_version,status,turns_json,windows_json,quality_status,"
                    "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("r2", "a1", "fp", 1, "ready", "[]", "[]", "bogus", now, now),
                )
        # 断言的是**约束名**，不是"message 里恰好出现 quality_status"——
        # 后者会把任何提到该列的错误都算通过。
        assert "quality_status" in str(excinfo.value)
