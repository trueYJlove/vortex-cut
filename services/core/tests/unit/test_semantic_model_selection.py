"""W3.1 语义检索：**模型选择**与**索引隔离**（中文优先）。

为什么单列一个测试文件：811b616 接入了中文分词器与清单，但服务层**从未使用**
中文模型 —— `ZH_MODEL_ID» 曾是死代码，`_model_paths()» / `_persist()» 各自
写死英文 `MODEL_ID»，`search()» 的 SQL 也**不按 model_id 过滤**。

最后一条是最危险的：两个模型的 embedding **同为 512 维**（onnxruntime 实测），
混在一起不会抛 shape 错误，只会把两个向量空间的向量做 cosine —— 返回一堆
看似正常、实际无意义的排序。它是**静默错误**，只有回归锁能拦住。

本文件覆盖：
- 四条选择路径（只英文 / 只中文 / 两者都装 ⇒ 中文优先 / 都没有）；
- context length 随模型分派（77 vs 52），且与分词器类型无关；
- `search()» 不返回其他模型的索引行（**静默错误的回归锁**）；
- `_persist()» 写入的 model_id / model_revision 与 active model 一致；
- 模型切换后旧索引在摘要里报 stale（既有读时状态词汇，不新造 reason）。

用**合成小件**（tmp_path 下的空目录 + 假 encoder），不碰 754 MB 真模型。
"""
from __future__ import annotations

import asyncio
import json

import numpy as np
import pytest

from aivs_core.database import Database
from aivs_core.media import semantic_service as svc_mod
from aivs_core.media.semantic import INDEX_ALGORITHM_VERSION, cosine_rank, pack_embeddings
from aivs_core.media.semantic_service import (
    MODEL_ID,
    ZH_CONTEXT_LEN,
    ZH_MODEL_ID,
    SemanticError,
    SemanticIndexService,
)

EN_REVISION = "xenova-clip-vit-base-patch32"
ZH_REVISION = "zh-export-2026-10-19"

# 两个模型的 embedding 都是 512 维（真实 I/O 签名）——本文件的假矩阵用小维度
# 表达同一事实：**维度不能用来区分归属**，只能靠 model_id / model_revision。
DIM = 4


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
    `_active_model()» 靠这条分支回退。
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


def _seed_asset(db, project_id="p1", asset_id="a1", fp="fp1") -> None:
    now = "2026-10-19T00:00:00Z"
    with db.connection() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO projects (id,name,status,canvas_json,root_dir,root_dir_name,"
            "created_at,updated_at,last_opened_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (project_id, project_id, "active", "{}", "/tmp/x", "x", now, now, now),
        )
        conn.execute(
            "INSERT INTO assets (id,project_id,kind,storage_mode,display_name,fingerprint,"
            "size_bytes,availability,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (asset_id, project_id, "video", "external", asset_id, fp, 1, "available", now, now),
        )


def _insert_index(db, asset_id, model_id, model_revision, vec, *, status="ready") -> None:
    now = "2026-10-19T00:00:00Z"
    mat = np.asarray([vec], dtype=np.float64)
    with db.connection() as conn:
        conn.execute(
            "INSERT INTO asset_semantic_index (id,asset_id,source_fingerprint,"
            "algorithm_version,status,frame_count,embedding_dim,frames_json,"
            "embeddings_blob,model_id,model_revision,created_at,updated_at,finished_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"idx_{asset_id}_{model_id}", asset_id, "fp1", INDEX_ALGORITHM_VERSION,
                status, 1, DIM, "[]", pack_embeddings(mat),
                model_id, model_revision, now, now, now,
            ),
        )


# ------------------------------------------------------- 1. 三条选择路径


class TestActiveModelSelection:
    def test_only_english_ready_selects_english_context_77(self, db, tmp_path):
        active = _service(db, tmp_path, (MODEL_ID,))._active_model()
        assert active is not None
        assert active.model_id == MODEL_ID
        assert active.revision == EN_REVISION
        assert active.context_len == 77

    def test_only_chinese_ready_selects_chinese_context_52(self, db, tmp_path):
        active = _service(db, tmp_path, (ZH_MODEL_ID,))._active_model()
        assert active is not None
        assert active.model_id == ZH_MODEL_ID
        assert active.revision == ZH_REVISION
        assert active.context_len == ZH_CONTEXT_LEN == 52

    def test_both_ready_prefers_chinese(self, db, tmp_path):
        """中文优先（用户 2026-10-19 裁决）—— 两者都装必须选中文。"""
        active = _service(db, tmp_path, (MODEL_ID, ZH_MODEL_ID))._active_model()
        assert active is not None
        assert active.model_id == ZH_MODEL_ID

    def test_neither_installed_raises_semantic_model_not_installed(self, db, tmp_path):
        svc = _service(db, tmp_path, ())
        assert svc._active_model() is None
        with pytest.raises(SemanticError) as exc:
            svc.search_text("p1", "红色跑车")
        assert exc.value.code == "SEMANTIC_MODEL_NOT_INSTALLED"

    def test_no_model_manager_raises_semantic_model_not_installed(self, db, tmp_path):
        svc = SemanticIndexService(db, ffmpeg=tmp_path / "ffmpeg", model_manager=None)
        with pytest.raises(SemanticError) as exc:
            svc.search_text("p1", "红色跑车")
        assert exc.value.code == "SEMANTIC_MODEL_NOT_INSTALLED"


# ------------------------------------------------- 2. context length 分派


class _FakeEncoder:
    """记录 encode_text 收到的序列长度，返回固定向量（跳过真 ONNX）。"""

    seen: list[int] = []

    def __init__(self, vision_path, text_path, **kwargs) -> None:
        self.vision_path = vision_path
        self.text_path = text_path

    def encode_text(self, input_ids, mask):
        _FakeEncoder.seen.append(int(np.asarray(input_ids).shape[-1]))
        return np.ones(DIM) / np.sqrt(DIM)


def _stub_tokenize(monkeypatch) -> None:
    monkeypatch.setattr(svc_mod, "ClipEncoder", _FakeEncoder)
    monkeypatch.setattr(
        svc_mod, "clip_tokenize",
        lambda text, path, max_len: (
            np.zeros((1, max_len), dtype=np.int64),
            np.ones((1, max_len), dtype=np.int64),
        ),
    )


class _FakeImageEncoder(_FakeEncoder):
    """在 _FakeEncoder 基础上补 encode_image（用于落 ready 行，避开真 ONNX）。"""

    def encode_image(self, frames):
        return np.tile(np.ones(DIM) / np.sqrt(DIM), (len(frames), 1))


def _index_ready(svc, tmp_path, monkeypatch, asset_id="a1"):
    """让 index_path 走完「抽帧 → 编码 → 落库」，但不碰 ffmpeg / ONNX。

    抽帧与模型无关，替换掉；编码返回固定向量，但其形状说明这些向量确实由
    **active model** 产生 —— 落库归属因此有可断言的内容。
    """
    monkeypatch.setattr(svc_mod, "ClipEncoder", _FakeImageEncoder)

    async def _fake_decode(self, input_path, cancel_event):
        return [np.zeros((224, 224, 3), dtype=np.uint8)]

    monkeypatch.setattr(SemanticIndexService, "_decode_frames", _fake_decode)
    return asyncio.run(svc.index_path(asset_id, "fp1", tmp_path / "fake.mp4"))


class TestContextLengthDispatch:
    def test_chinese_model_uses_52(self, db, tmp_path, monkeypatch):
        _FakeEncoder.seen = []
        _stub_tokenize(monkeypatch)
        _service(db, tmp_path, (ZH_MODEL_ID,)).search_text("p1", "红色跑车")
        assert _FakeEncoder.seen == [ZH_CONTEXT_LEN]

    def test_english_model_uses_77(self, db, tmp_path, monkeypatch):
        """负向对照的另一半：英文塔是动态维度，必须仍传 77。"""
        _FakeEncoder.seen = []
        _stub_tokenize(monkeypatch)
        _service(db, tmp_path, (MODEL_ID,)).search_text("p1", "red car")
        assert _FakeEncoder.seen == [77]

    def test_context_length_follows_model_not_tokenizer(self, db, tmp_path, monkeypatch):
        """判据必须**同源**。两套判据（分词器类型 / 模型 id）各自漂移就会出现
        「中文模型 + BPE 分词器 ⇒ 误传 77 ⇒ ONNX shape 错误」。

        这里把中文模型的 tokenizer.json 伪造成 BPE：context length 仍必须是 52,
        证明判据已收敛到模型而非分词器。
        """
        _FakeEncoder.seen = []
        _stub_tokenize(monkeypatch)
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        active = svc._active_model()
        assert active is not None
        (active.text_path.parent / "tokenizer.json").write_text(
            json.dumps({"model": {"type": "BPE"}}), encoding="utf-8"
        )
        svc.search_text("p1", "红色跑车")
        assert _FakeEncoder.seen == [ZH_CONTEXT_LEN]


# --------------------------------- 3. 静默错误的回归锁：不许跨模型检索


class TestCrossModelIsolation:
    def test_english_index_not_returned_for_chinese_query(self, db, tmp_path):
        """核心用例：英文模型产生的索引行 + 中文模型查询 ⇒ 必须返回空。

        为什么这条必需而非锦上添花：两模型同为 512 维，缺了 model_id 过滤时
        cosine 会算出**看起来正常**的分数（下面第一段先证明它确实非零），
        不报错、不丢行 —— 只能靠断言「不返回」来锁住。
        """
        _seed_asset(db)
        _insert_index(db, "a1", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0])
        query = np.array([1.0, 0.0, 0.0, 0.0])

        # 前提：同一批向量本来就能算出非零分数（否则本用例会恒真）。
        assert cosine_rank(query, [("a1", query)], k=1)[0]["score"] == pytest.approx(1.0)

        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        assert svc.search("p1", query, limit=10) == []

    def test_chinese_index_is_returned_for_chinese_query(self, db, tmp_path):
        """正对照：同一查询、同一维度，换成本模型的行必须能检索到。没有这条，
        上一条可能因「过滤写成永假」而恒真。"""
        _seed_asset(db)
        _insert_index(db, "a1", ZH_MODEL_ID, ZH_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        hits = svc.search("p1", np.array([1.0, 0.0, 0.0, 0.0]), limit=10)
        assert [h["asset_id"] for h in hits] == ["a1"]

    def test_revision_change_invalidates_previous_rows(self, db, tmp_path):
        """同 model_id 但 revision 不同（重新导出）同样是「别的向量空间」，
        必须按不同模型对待。"""
        _seed_asset(db)
        _insert_index(db, "a1", ZH_MODEL_ID, "zh-export-OLD", [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        assert svc.search("p1", np.array([1.0, 0.0, 0.0, 0.0]), limit=10) == []

    def test_both_models_indexed_only_chinese_rows_ranked(self, db, tmp_path):
        """两模型的索引共存时，检索只吃当前 active 的那一半。"""
        # 指纹（不是 asset id）参与唯一键：两个素材必须给不同的 fingerprint。
        _seed_asset(db, "p1", "a_en", "fp_en")
        _seed_asset(db, "p1", "a_zh", "fp_zh")
        _insert_index(db, "a_en", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0])
        _insert_index(db, "a_zh", ZH_MODEL_ID, ZH_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (MODEL_ID, ZH_MODEL_ID))
        hits = svc.search("p1", np.array([1.0, 0.0, 0.0, 0.0]), limit=10)
        assert [h["asset_id"] for h in hits] == ["a_zh"]
        # 反过来（只有英文可用时）同一批行里只能取到英文那一条。
        svc_en = _service(db, tmp_path, (MODEL_ID,))
        hits_en = svc_en.search("p1", np.array([1.0, 0.0, 0.0, 0.0]), limit=10)
        assert [h["asset_id"] for h in hits_en] == ["a_en"]


# ------------------------------------------- 4. 摘要不把别人的索引当自己


class TestSummaryModelOwnership:
    def test_other_model_index_reports_stale_without_new_reason(self, db, tmp_path):
        """模型切换后旧索引不可用 —— 用既有读时状态 stale，不新造 reason 字符串。"""
        _seed_asset(db)
        _insert_index(db, "a1", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        summary = svc.index_summary({"id": "a1", "fingerprint": "fp1"})
        assert summary is not None
        assert summary["status"] == "stale"
        assert summary["reason"] is None
        assert summary["model_id"] == MODEL_ID

    def test_own_model_index_reports_ready(self, db, tmp_path):
        _seed_asset(db)
        _insert_index(db, "a1", ZH_MODEL_ID, ZH_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        summary = svc.index_summary({"id": "a1", "fingerprint": "fp1"})
        assert summary is not None
        assert summary["status"] == "ready"

    def test_latest_index_ignores_other_model_rows(self, db, tmp_path):
        _seed_asset(db)
        _insert_index(db, "a1", MODEL_ID, EN_REVISION, [1.0, 0.0, 0.0, 0.0])
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        assert svc.latest_index("a1") is None


# ------------------------------------------------ 5. 落库归属与 active 一致


class TestPersistOwnership:
    def _row(self, db, index_id):
        with db.connection() as conn:
            return conn.execute(
                "SELECT model_id, model_revision FROM asset_semantic_index WHERE id=?",
                (index_id,),
            ).fetchone()

    def test_persist_records_active_model_id_and_revision(self, db, tmp_path, monkeypatch):
        """中文 ready ⇒ 落库必须记中文 id + revision（修复前写死英文）。"""
        _seed_asset(db)
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        result = _index_ready(svc, tmp_path, monkeypatch)
        assert result["status"] == "ready"
        row = self._row(db, result["index_id"])
        assert row["model_id"] == ZH_MODEL_ID
        assert row["model_revision"] == ZH_REVISION

    def test_persist_records_english_when_english_active(self, db, tmp_path, monkeypatch):
        _seed_asset(db)
        svc = _service(db, tmp_path, (MODEL_ID,))
        result = _index_ready(svc, tmp_path, monkeypatch)
        assert result["status"] == "ready"
        row = self._row(db, result["index_id"])
        assert row["model_id"] == MODEL_ID
        assert row["model_revision"] == EN_REVISION

    def test_persisted_ready_row_is_retrievable_by_same_model(self, db, tmp_path, monkeypatch):
        """闭环：本模型写的行，本模型必须检索得到（否则上面两条可能是「写了但谁也读不到」）。"""
        _seed_asset(db)
        svc = _service(db, tmp_path, (ZH_MODEL_ID,))
        _index_ready(svc, tmp_path, monkeypatch)
        assert svc.latest_index("a1") is not None

    def test_persist_without_model_records_no_owner(self, db, tmp_path):
        """未安装时仍要落一行（unavailable 是显式降级信号），但归属必须为空 ——
        否则它会被后续同 revision 的模型误认领。"""
        _seed_asset(db)
        svc = _service(db, tmp_path, ())
        result = asyncio.run(svc.index_path("a1", "fp1", tmp_path / "nope.mp4"))
        assert result["reason"] == "model_not_installed"
        row = self._row(db, result["index_id"])
        assert row["model_id"] is None
        assert row["model_revision"] is None
