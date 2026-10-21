"""W3.3 Layer 2：帧级外传预览服务（S2，零网络）。

设计门 §3.2 / 规划门 §3.1。照 captions_provider_egress.py 的三段式：
prepare → (逐张审阅/移除) → create → claim_for_runner。

四条不变量的落点：
  I-1 未消费 consent 不得发网络 → claim_for_runner 是唯一放行点。
  I-2 payload 必须可复算      → 哈希由实际帧字节决定，移除一帧即变。
  I-3 移除生效于真实载荷      → create 依 excluded 过滤后再算最终载荷。
  I-4 审计保真                → frames_json 的哈希/字节取自实际外传字节。

本模块不发任何网络请求，也不编码（编码在 keyframe_encode）。
"""
from __future__ import annotations

import hashlib
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .media.keyframe_encode import EncodedFrame, total_payload_bytes
from .media.keyframe_sampling import SamplingPlan
from .projects import DomainError

# 预览有效期。与既有 captions egress 的 15 分钟同量级：足够审阅，
# 又不至于让载荷长期躺在磁盘上。
PREVIEW_TTL_MINUTES = 15

FRAME_TAGS_ALGORITHM_VERSION = 1


def _expires_at() -> str:
    moment = datetime.now(UTC) + timedelta(minutes=PREVIEW_TTL_MINUTES)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def compute_payload_sha256(frames: list[EncodedFrame], *, excluded: set[int]) -> str:
    """由实际将外传的帧字节算集合哈希。

    为什么逐帧散列后拼接而不是散列整个拼接流：拼接流要把几十 MB 字节
    拼进内存再散列；逐帧散列（长度前缀防歧义）结果等价，内存是 O(1)。

    必须包含帧序号：否则「交换两帧顺序」会产生同一哈希，而顺序对
    审阅与播放语义是有意义的。
    """
    digest = hashlib.sha256()
    for index, frame in enumerate(frames):
        if index in excluded:
            continue
        digest.update(index.to_bytes(4, "big"))
        digest.update(len(frame.payload_bytes).to_bytes(8, "big"))
        digest.update(frame.payload_bytes)
    return digest.hexdigest()


def frame_meta(index: int, frame: EncodedFrame) -> dict[str, Any]:
    """逐帧元数据（S1a 的 to_meta + index）。"""
    meta = frame.to_meta()
    meta["frame_index"] = index
    return meta


class KeyframeEgressService:
    def __init__(self, db: Database, *, cache_root: Path | None = None) -> None:
        self.db = db
        if cache_root is None:
            # 独立目录，不复用 derived_media_cache：那个模块的 LRU
            # （media/derived_cache.py:319-340）会独立删字节，使 A14
            # 「到期后字节数 >0 即红」因 LRU 抢先清理而假绿。
            # 此处清理责任单一：只有 purge_expired 会删它。
            cache_root = db.path.parent / "keyframe-cache"
        self.cache_root = Path(cache_root)

    # ── 载荷文件 ──

    def _preview_dir(self, preview_id: str) -> Path:
        return self.cache_root / preview_id

    def _write_payloads(self, preview_id: str, frames: list[EncodedFrame]) -> None:
        directory = self._preview_dir(preview_id)
        directory.mkdir(parents=True, exist_ok=True)
        for index, frame in enumerate(frames):
            (directory / f"payload_{index:03d}.jpg").write_bytes(frame.payload_bytes)
            (directory / f"thumb_{index:03d}.jpg").write_bytes(frame.thumbnail_bytes)

    def payload_dir_bytes(self, preview_id: str) -> int:
        """该预览在磁盘上的载荷字节数（A14 断言用）。"""
        directory = self._preview_dir(preview_id)
        if not directory.exists():
            return 0
        return sum(p.stat().st_size for p in directory.iterdir() if p.is_file())

    def load_payload(self, preview_id: str, frame_index: int) -> bytes:
        """读回将要外传的那一帧字节（A12 比对基准）。"""
        path = self._preview_dir(preview_id) / f"payload_{frame_index:03d}.jpg"
        if not path.exists():
            raise DomainError("VISION_FRAMES_UNMAPPED", "预览载荷缺失")
        return path.read_bytes()

    # ── 三段式 ──

    def prepare(
        self,
        project_id: str,
        asset_row: dict[str, Any],
        provider: dict[str, Any],
        frames: list[EncodedFrame],
        plan: SamplingPlan,
    ) -> dict[str, Any]:
        """落预览行 + 载荷文件。无网络。"""
        if not frames:
            raise DomainError("VISION_FRAMES_UNMAPPED", "没有可用帧")
        preview_id = new_id()
        self._write_payloads(preview_id, frames)
        metas = [frame_meta(i, f) for i, f in enumerate(frames)]
        now = utc_now()
        expires = _expires_at()
        payload_sha = compute_payload_sha256(frames, excluded=set())
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO keyframe_egress_previews ("
                "id,project_id,asset_id,provider_config_id,source_fingerprint,"
                "model_id,model_revision,payload_sha256,frames_json,excluded_frames_json,"
                "sampling_mode,covered_scene_cuts,total_frame_bytes,expires_at,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    preview_id, project_id, asset_row["id"],
                    provider["provider_config_id"], str(asset_row["fingerprint"]),
                    provider.get("model"), None, payload_sha,
                    json_dumps(metas), "[]",
                    plan.sampling_mode, plan.covered_scene_cuts,
                    total_payload_bytes(frames), expires, now, now,
                ),
            )
        return self.get_preview(project_id, preview_id)

    def exclude_frames(self, project_id: str, preview_id: str,
                       frame_indices: list[int]) -> dict[str, Any]:
        """把帧加入排除集并重算 payload 哈希（I-2 / I-3）。

        只增不改（D4 审计）：已排除的帧不会被「取消排除」悄悄复活。
        """
        row = self._require_preview(project_id, preview_id)
        excluded = set(json_loads(row["excluded_frames_json"]) or [])
        metas = json_loads(row["frames_json"]) or []
        valid = {int(m["frame_index"]) for m in metas}
        unknown = [i for i in frame_indices if i not in valid]
        if unknown:
            raise DomainError("VISION_FRAMES_UNMAPPED", f"未知帧序号: {unknown}")
        excluded.update(frame_indices)
        new_sha = self._recompute_hash(preview_id, metas, excluded)
        with self.db.connection() as db:
            db.execute(
                "UPDATE keyframe_egress_previews SET excluded_frames_json=?,"
                "payload_sha256=?,updated_at=? WHERE id=? AND project_id=?",
                (json_dumps(sorted(excluded)), new_sha, utc_now(), preview_id, project_id),
            )
        return self.get_preview(project_id, preview_id)

    def _recompute_hash(self, preview_id: str, metas: list[dict[str, Any]],
                        excluded: set[int]) -> str:
        """按磁盘上的真实字节复算，而不是信任 frames_json 里的旧哈希。

        这一点是 A3「可复算」的实质：若只对元数据算，载荷被换掉也不会被发现。
        """
        digest = hashlib.sha256()
        for meta in metas:
            index = int(meta["frame_index"])
            if index in excluded:
                continue
            data = self.load_payload(preview_id, index)
            digest.update(index.to_bytes(4, "big"))
            digest.update(len(data).to_bytes(8, "big"))
            digest.update(data)
        return digest.hexdigest()

    def create(self, project_id: str, preview_id: str, payload_sha256: str,
               jobs: Any = None) -> dict[str, Any]:
        """校验哈希与时效后建 consent + generation。无网络。"""
        row = self._require_preview(project_id, preview_id)
        if row["payload_sha256"] != payload_sha256:
            raise DomainError("KEYFRAME_PREVIEW_EXPIRED", "预览内容已变化，请重新审阅")
        if row["payloads_purged_at"] is not None:
            raise DomainError("KEYFRAME_PREVIEW_EXPIRED", "预览载荷已清理，请重新生成")
        now = utc_now()
        consent_id = f"keyframe_consent_{new_id()}"
        generation_id = f"keyframe_gen_{new_id()}"
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO keyframe_egress_consents VALUES (?,?,?,?,?)",
                (consent_id, preview_id, payload_sha256, now, None),
            )
            db.execute(
                "INSERT INTO keyframe_generations VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    generation_id, project_id, preview_id, consent_id,
                    row["provider_config_id"], row["source_fingerprint"],
                    "queued", payload_sha256, now, None,
                ),
            )
        return {"keyframe_generation_id": generation_id, "status": "queued",
                "consent_id": consent_id}

    def claim_for_runner(self, project_id: str, generation_id: str) -> dict[str, Any]:
        """原子消费 consent 并把 generation 置 running。

        这是唯一的放行点（I-1）：runner 拿不到 claim 就不得发起网络调用。
        """
        now = utc_now()
        with self.db.connection() as db:
            row = db.execute(
                "SELECT g.*, c.consumed_at, p.frames_json, p.excluded_frames_json,"
                "p.expires_at, p.source_fingerprint, p.asset_id "
                "FROM keyframe_generations g "
                "JOIN keyframe_egress_consents c ON c.id=g.egress_consent_id "
                "JOIN keyframe_egress_previews p ON p.id=g.egress_preview_id "
                "WHERE g.id=? AND g.project_id=?",
                (generation_id, project_id),
            ).fetchone()
            if row is None:
                raise DomainError("KEYFRAME_PREVIEW_EXPIRED", "生成记录不存在")
            if row["consumed_at"] is not None:
                raise DomainError("KEYFRAME_EGRESS_CONSENT_REQUIRED", "同意书已被消费")
            if db.execute(
                "UPDATE keyframe_egress_consents SET consumed_at=? "
                "WHERE id=? AND consumed_at IS NULL",
                (now, row["egress_consent_id"]),
            ).rowcount != 1:
                raise DomainError("KEYFRAME_EGRESS_CONSENT_REQUIRED", "同意书消费失败")
            db.execute(
                "UPDATE keyframe_generations SET status=? WHERE id=?",
                ("running", generation_id),
            )
        excluded = set(json_loads(row["excluded_frames_json"]) or [])
        return {
            "generation_id": generation_id,
            "preview_id": row["egress_preview_id"],
            "provider_config_id": row["provider_config_id"],
            "payload_sha256": row["payload_sha256"],
            "excluded_frames": sorted(excluded),
            "frames_json": row["frames_json"],
            # 打标落库需要素材归属与指纹（否则无法写 asset_frame_tags）。
            # 二者来自预览行——预览建立时已冻结，不会与当前素材状态漂移。
            "asset_id": row["asset_id"],
            "source_fingerprint": row["source_fingerprint"],
        }

    # ── 查询与清理 ──

    def _require_preview(self, project_id: str, preview_id: str) -> Any:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT * FROM keyframe_egress_previews WHERE id=? AND project_id=?",
                (preview_id, project_id),
            ).fetchone()
        if row is None:
            raise DomainError("KEYFRAME_PREVIEW_EXPIRED", "预览不存在")
        return row

    def get_preview(self, project_id: str, preview_id: str) -> dict[str, Any]:
        row = self._require_preview(project_id, preview_id)
        return {
            "keyframe_egress_preview_id": row["id"],
            "frames": json_loads(row["frames_json"]) or [],
            "excluded_frames": json_loads(row["excluded_frames_json"]) or [],
            "sampling_mode": row["sampling_mode"],
            "covered_scene_cuts": row["covered_scene_cuts"],
            "total_frame_bytes": row["total_frame_bytes"],
            "payload_sha256": row["payload_sha256"],
            "expires_at": row["expires_at"],
        }

    def purge_expired(self) -> int:
        """到期后真删载荷字节，保留元数据与哈希（A14 / R10）。

        保留元数据的原因：审计追溯要能回答「当时发了什么」；字节本身
        在到期后已无用途，继续留着只是扩大泄露面。
        """
        now = utc_now()
        with self.db.connection() as db:
            rows = db.execute(
                "SELECT id FROM keyframe_egress_previews "
                "WHERE expires_at < ? AND payloads_purged_at IS NULL",
                (now,),
            ).fetchall()
        purged = 0
        for row in rows:
            directory = self._preview_dir(row["id"])
            if directory.exists():
                shutil.rmtree(directory, ignore_errors=True)
            with self.db.connection() as db:
                db.execute(
                    "UPDATE keyframe_egress_previews SET payloads_purged_at=? "
                    "WHERE id=? AND payloads_purged_at IS NULL",
                    (now, row["id"]),
                )
            purged += 1
        return purged

    def detach_asset(self, asset_id: str) -> int:
        """素材删除前调用：断开引用但保留审计行（R17 / P102 反向陷阱）。

        若改用 ON DELETE CASCADE，外传审计记录会随素材消失（与 A12 追溯冲突）；
        若用 NO ACTION，则 DELETE FROM assets 会被 FK 拒绝（P102 原样重演）。
        显式 detach 是同时满足两者的唯一做法。
        """
        now = utc_now()
        with self.db.connection() as db:
            return db.execute(
                "UPDATE keyframe_egress_previews SET asset_id=NULL, detached_at=?,"
                "updated_at=? WHERE asset_id=? AND detached_at IS NULL",
                (now, now, asset_id),
            ).rowcount
