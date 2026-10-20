"""W3.1 语义检索：**模型切换 ⇒ 旧索引必须重建** 的回归锁。

为什么单列一个文件：ab56002 把检索改为按 active model 隔离 —— `search()` /
`latest_index()` 按 `model_id` + `model_revision` 过滤，`index_summary()` 对
「别的模型产的行」返回读时状态 `stale`。端点（`app.py` 的
`if request.generate and status not in {"ready","queued","running","unavailable"}`
）因此会为 stale 登记重建作业 —— **这是正确行为**：模型换了，旧向量空间作废。

退化方式极隐蔽：把 `stale` 加进那个集合，代码不会报错、现有测试也不会变红，
但旧模型的行会一直当 stale 返回、**永远没人重建**，用户永远检索不到。所以这里
用**端点级**用例把它钉死（把 stale 加进集合 ⇒ 用例 C 必红）。

约定：stale 只在读侧计算，`asset_semantic_index.status` 的 CHECK 集合不含它
（`database_v39.py`），与 cv_signals / speaker_service 同构。

用合成小件（tmp_path + 假 model_manager），不碰 754 MB 真模型、零 egress。
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import numpy as np
import pytest

from aivs_core.database import Database, sha256_file
from aivs_core.media import semantic_service as svc_mod
from aivs_core.media.semantic import INDEX_ALGORITHM_VERSION, pack_embeddings
from aivs_core.media.semantic_service import (
    MODEL_ID,
    ZH_MODEL_ID,
    SemanticIndexService,
)
from aivs_core.projects import modified_iso

EN_REVISION = "xenova-clip-vit-base-patch32"
ZH_REVISION = "zh-export-2026-10-19"

# 两个模型的 embedding 同为 512 维：维度不能用来区分归属，只能靠 model_id /
# model_revision。本文件的假矩阵用小维度表达同一事实。
DIM = 4

NOW = "2026-10-19T00:00:00Z"

# 端点判定「无需重建」的状态集合：**stale 必须在外**。
# 忠实转录自 `app.py` 的 `post_asset_semantic_index`（见下面用例 C 的说明）。
NO_REINDEX_STATUSES = frozenset({"ready", "queued", "running", "unavailable"})


# ------------------------------------------------------------------ 合成件


class _FakeManifest:
    def __init__(self, revision: str) -> None:
        self.revision = revision


class _FakeRegistry:
    """只提供 registry.get(model_id).revision（与真实 ModelRegistry 同形）。"""

    def __init__(self, revisions: dict[str, str]) -> None:
        self._revisions = revisions

    def get(self, model_id: str) -> _FakeManifest:
        if model_id not in self._revisions:
            raise KeyError(model_id)
        return _FakeManifest(self._revisions[model_id])


class _FakeModelManager:
    """只提供 ready_path + registry，与真实 ModelManager 的最小接口一致。

    ready_path 对未安装的模型抛异常（真实实现抛 ModelError），
    `_active_model()` 靠这条分支回退。
    """

    def __init__(self, root, ready: tuple[str, ...] = ()) -> None:
        self.registry = _FakeRegistry({MODEL_ID: EN_REVISION, ZH_MODEL_ID: ZH_REVISION})
        self._dirs: dict[str, object] = {}
        for model_id in ready:
            directory = root / model_id
            directory.mkdir(parents=True, exist_ok=True)
            (directory / svc_mod.VISION_FILE).write_bytes(b"not-a-real-onnx")
            (directory / svc_mod.TEXT_FILE).write_bytes(b"not-a-real-onnx")
            (directory / "tokenizer.json").write_text(
                json.dumps({"model": {"type": "BPE"}}), encoding="utf-8"
            )
            self._dirs[model_id] = directory

    def ready_path(self, model_id: str):
        if model_id not in self._dirs:
            raise RuntimeError(f"{model_id} 尚未安装")
        return self._dirs[model_id]


@pytest.fixture()
def db(tmp_path):
    database = Database(tmp_path / "test.db")
    database.initialize()
    return database


def _service(db, tmp_path, ready=()) -> SemanticIndexService:
    manager = _FakeModelManager(tmp_path / "models", ready)
    return SemanticIndexService(db, ffmpeg=tmp_path / "ffmpeg", model_manager=manager)


def _seed_project(conn, project_id: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,"
        "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
        (project_id, project_id, "active", "{}", "/tmp/x", "x", NOW, NOW, NOW),
    )


def _seed_asset(db, project_id="p1", asset_id="a1", fp="fp1") -> None:
    with db.connection() as conn:
        _seed_project(conn, project_id)
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (asset_id, project_id, "video", "external", asset_id, fp, 1, "available", NOW, NOW),
        )


def _insert_index(db, asset_id, model_id, model_revision, vec, *, status="ready",
                  source_fingerprint="fp1") -> str:
    index_id = f"idx_{asset_id}_{model_id}_{status}"
    mat = np.asarray([vec], dtype=np.float64)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
            "algorithm_version,status,frame_count,embedding_dim,frames_json,"
            "embeddings_blob,model_id,model_revision,created_at,updated_at,finished_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                index_id, asset_id, source_fingerprint, INDEX_ALGORITHM_VERSION,
                status, 1, DIM, "[]", pack_embeddings(mat),
                model_id, model_revision, NOW, NOW, NOW,
            ),
        )
    return index_id


# ------------------------------------------------ A/B. 读侧 stale 的双向对照


class TestStaleReport:
    def test_model_switch_reports_stale(self, db, tmp_path):
        """A：库里只有**英文**模型产的 ready 行，当前 active 是中文 ⇒ stale。"""
        _seed_asset(db)
        _insert_index(db, "a1", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        summary = svc.index_summary({"id": "a1", "fingerprint": "fp1"})
        assert summary is not None
        assert summary["status"] == "stale"
        # 归属仍是旧模型：摘要如实报告这行是谁产的，不伪装成本模型的行。
        assert summary["model_id"] == MODEL_ID
        assert summary["model_revision"] == EN_REVISION

    def test_same_model_reports_ready(self, db, tmp_path):
        """B：正对照 —— 行与 active 同 model_id + revision 必须仍是 ready。

        没有这条，A 可能因「摘要恒报 stale」而恒真。
        """
        _seed_asset(db)
        _insert_index(db, "a1", ZH_MODEL_ID, ZH_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        summary = svc.index_summary({"id": "a1", "fingerprint": "fp1"})
        assert summary is not None
        assert summary["status"] == "ready"

    def test_same_model_id_but_other_revision_is_stale(self, db, tmp_path):
        """同 model_id、revision 变了（重新导出）同样是「别的向量空间」。"""
        _seed_asset(db)
        _insert_index(db, "a1", ZH_MODEL_ID, "zh-export-OLD", [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        assert svc.index_summary({"id": "a1", "fingerprint": "fp1"})["status"] == "stale"


# ------------------------------------- C. 核心回归锁：stale ⇒ 必须登记重建


def test_stale_is_outside_the_no_reindex_status_set():
    """C-1：端点判定「无需重建」的集合里**不许**出现 stale。

    这条把 `app.py` 那行集合的**契约**写下来：集合中的状态都是终态或在途
    （ready 可用 / queued·running 在途 / unavailable 显式降级），而 stale 是
    「旧向量空间作废、必须重建」的中间态。若有人把 stale 加进集合，旧模型的
    行会一直当 stale 返回却永远没人重建 —— 不报错、不丢行，只是永远搜不到。
    """
    assert "stale" not in NO_REINDEX_STATUSES
    # 与之对称：failed（可重建）同样在集合外，说明集合不是「所有已知状态」。
    assert "failed" not in NO_REINDEX_STATUSES


def _build_app(tmp_path):
    """构造真实 app（**不跑 lifespan**：跳过 jobs 调度循环，作业保持 queued 可断言）。"""
    from fastapi.testclient import TestClient

    from aivs_core.app import create_app
    from aivs_core.config import Settings

    app = create_app(
        Settings(
            data_dir=tmp_path / "data",
            ffmpeg=Path("ffmpeg-x"),
            ffprobe=Path("ffprobe-x"),
        )
    )
    state = app.state.core
    state.db.initialize()
    # 模型解析换成本文件的假 manager：零 egress、不碰 754 MB 真件。
    state.semantic.model_manager = _FakeModelManager(tmp_path / "app-models", (ZH_MODEL_ID,))
    headers = {"Authorization": f"Bearer {state.auth.create_ui_token()}"}
    return TestClient(app), state, headers


def _seed_real_asset(state, tmp_path, project_id="p1", asset_id="a1"):
    """端点路径要 resolve_asset_path：素材必须是**真实文件**且指纹/stat 对得上。"""
    media = tmp_path / f"{asset_id}.mp4"
    media.write_bytes(b"synthetic-media-bytes")
    with state.db.connection() as conn:
        _seed_project(conn, project_id)
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,modified_at,availability,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                asset_id, project_id, "video", "external", media.name,
                sha256_file(media), media.stat().st_size, modified_iso(media),
                "available", NOW, NOW,
            ),
        )
        conn.execute(
            "INSERT INTO asset_locations (asset_id,uri,last_verified_at) VALUES (?,?,?)",
            (asset_id, media.as_uri(), NOW),
        )
    with state.db.connection() as conn:
        return conn.execute(
            "SELECT fingerprint FROM assets WHERE id=?", (asset_id,)
        ).fetchone()["fingerprint"]


class TestEndpointReindexOnStale:
    """C-2：**直接覆盖端点**（`app.py` 的 `post_asset_semantic_index`）。

    敏感性：把 `"stale"` 加进 `status not in {...}` 那个集合，本类必红 ——
    响应会变成 `status="stale"` / `job_id=None`，且 jobs 表不会多出一行。
    """

    def test_stale_index_registers_reindex_job(self, tmp_path):
        client, state, headers = _build_app(tmp_path)
        fingerprint = _seed_real_asset(state, tmp_path)
        stale_id = _insert_index(
            state.db, "a1", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0],
            source_fingerprint=fingerprint,
        )

        response = client.post(
            "/api/v1/projects/p1/assets/a1/semantic-index",
            json={"generate": True},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        # generate=True + stale（不在「无需重建」集合内）⇒ 必须登记重建。
        assert payload["status"] == "queued"
        assert payload["job_id"], "stale 未登记重建作业 —— 僵尸索引永不重建"
        # 摘要仍如实指向旧行（重建是**新增**一行，不是改写别人的行）。
        assert payload["index_id"] == stale_id
        assert payload["model_id"] == MODEL_ID

        with state.db.connection() as conn:
            jobs = conn.execute(
                "SELECT id,kind,type,status FROM jobs WHERE project_id='p1' ORDER BY created_at"
            ).fetchall()
        assert [row["id"] for row in jobs] == [payload["job_id"]]
        assert jobs[0]["kind"] == "semantic_index"
        assert jobs[0]["status"] == "queued"

    def test_stale_is_reported_as_stale_when_generate_false(self, tmp_path):
        """对照：不要求生成时，端点如实返回 stale —— 旧行没有被藏起来。

        与上一条同读：stale 既是**读侧可见状态**，又是**重建触发条件**。
        """
        client, state, headers = _build_app(tmp_path)
        fingerprint = _seed_real_asset(state, tmp_path)
        _insert_index(
            state.db, "a1", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0],
            source_fingerprint=fingerprint,
        )
        response = client.post(
            "/api/v1/projects/p1/assets/a1/semantic-index",
            json={"generate": False},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["status"] == "stale"
        assert payload["job_id"] is None


# ------------------------------------------- D. 未装模型 ⇒ NULL 归属不匹配


class TestUninstalledModelOwnership:
    def _row(self, db, index_id):
        with db.connection() as conn:
            return conn.execute(
                "SELECT status,model_id,model_revision FROM asset_semantic_index WHERE id=?",
                (index_id,),
            ).fetchone()

    def test_index_path_without_model_writes_null_ownership(self, db, tmp_path):
        """D-1：模型未装仍要落行（unavailable = 显式降级），但归属为 NULL。"""
        _seed_asset(db)
        svc = _service(db, tmp_path, ())
        result = asyncio.run(svc.index_path("a1", "fp1", tmp_path / "nope.mp4"))
        assert result["status"] == "unavailable"
        assert result["reason"] == "model_not_installed"
        row = self._row(db, result["index_id"])
        assert row["model_id"] is None
        assert row["model_revision"] is None

    def test_null_owned_ready_row_matches_no_active_model(self, db, tmp_path):
        """D-2：NULL 归属的行**不被任何** active model 的 search() 命中。

        用 `_persist` 直接落一条 **ready** 行（带真向量）：这样「检索不到」
        才说明是归属过滤生效，而不是被 status 过滤挡掉。
        """
        _seed_asset(db, "p1", "a_null", "fp_null")
        _seed_asset(db, "p1", "a_zh", "fp_zh")
        vec = np.asarray([[1.0, 0.0, 0.0, 0.0]], dtype=np.float64)
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))

        null_row = svc._persist(
            "a_null", "fp_null", "ready", reason=None, frames=[0],
            matrix=vec, active=None,
        )
        owned_row = svc._persist(
            "a_zh", "fp_zh", "ready", reason=None, frames=[0],
            matrix=vec, active=svc._active_model(),
        )
        assert self._row(db, null_row["index_id"])["model_id"] is None
        assert self._row(db, owned_row["index_id"])["model_id"] == ZH_MODEL_ID

        hits = svc.search("p1", np.array([1.0, 0.0, 0.0, 0.0]), limit=10)
        # 正对照：本模型的行必须检索得到（否则上面「不命中」是恒真的空库假象）。
        assert [hit["asset_id"] for hit in hits] == ["a_zh"]

        # 换成英文 active：NULL 行同样不匹配任何 model_id（NULL != 任何值）。
        hits_en = _service(db, tmp_path, (MODEL_ID,)).search(
            "p1", np.array([1.0, 0.0, 0.0, 0.0]), limit=10
        )
        assert "a_null" not in [hit["asset_id"] for hit in hits_en]
