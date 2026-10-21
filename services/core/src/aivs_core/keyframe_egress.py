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
from .media.vision_adapter import vision_adapter_supported
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
               jobs: Any = None, *, allow_unprobed: bool = False) -> dict[str, Any]:
        """校验哈希、时效与 vision 能力后建 consent + generation（+ 作业行）。无网络。

        `jobs` 非空时，作业行与 consent/generation 在**同一事务**内落库
        （设计门 §3.2）：否则进程在两句之间崩溃会留下「已签同意书、永远
        排队」的生成记录——用户重新审阅一次，代价是一整轮抽帧编码。
        传 None 时退化为只写 consent + generation（兼容无 JobService 的调用方）。

        **fail-closed（A4）**：Provider 未通过 vision 能力探测时一律拒绝，且
        拒绝发生在写 consent/generation **之前**——所以「零字节外传」里连
        同意书都不会签。判据只读 provider_configs 的六列，不读 Provider DTO
        （`_dto` 曾不含这六列，靠 DTO 会让门禁恒假）。

        **allow_unprobed 是探测自举，不是通用旁路**：vision 能力探测本身要走
        prepare→create→claim（I-1），而那一刻 Provider 状态还是 untested——
        若不放行，探测永远无法开始。该参数**仅**由 `VisionProbeService.probe`
        传 True，且是 keyword-only；HTTP 路由的调用点不含它（有测试锁住，
        见 test_vision_probe.py::test_create_route_does_not_accept_allow_unprobed
        与 test_only_probe_path_passes_allow_unprobed）。
        """
        row = self._require_preview(project_id, preview_id)
        if not allow_unprobed:
            self._require_vision_capable(row["provider_config_id"])
        if row["payload_sha256"] != payload_sha256:
            raise DomainError("KEYFRAME_PREVIEW_EXPIRED", "预览内容已变化，请重新审阅")
        if row["payloads_purged_at"] is not None:
            raise DomainError("KEYFRAME_PREVIEW_EXPIRED", "预览载荷已清理，请重新生成")
        now = utc_now()
        consent_id = f"keyframe_consent_{new_id()}"
        generation_id = f"keyframe_gen_{new_id()}"
        job_id = f"job_{new_id()}"
        with self.db.connection() as db:
            db.execute("BEGIN")
            try:
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
                self._insert_job(
                    db, jobs, job_id, now, project_id, generation_id, row["asset_id"],
                )
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return {"keyframe_generation_id": generation_id, "status": "queued",
                "consent_id": consent_id}

    def _require_vision_capable(self, provider_config_id: str) -> None:
        """fail-closed：Provider 必须已探测为 supported 才允许外传。

        判据**只读库**（provider_configs 的六列），理由有二：
          1. ProviderRepository._dto 的字段集不归本模块管，依赖它会让门禁
             在 DTO 缺列时**恒假**——那是「看起来有守卫、实际恒拒」的另一种
             不可观测形态；
          2. 六列是 v41 迁移的物理事实，直读是唯一不经过投影的判据。

        四条都查而不是只查 status（对齐 captions 的 _require_capable 先例）：
        status=supported 但缺 tested_at 或适配器不可用时，runner 拿不到可选
        档位，下一步就会用未探测的适配器发请求。
        """
        with self.db.connection() as db:
            provider = db.execute(
                "SELECT enabled,vision_capability_status,vision_capability_tested_at,"
                "vision_response_adapter_id FROM provider_configs WHERE id=?",
                (provider_config_id,),
            ).fetchone()
        if provider is None:
            raise DomainError("PROVIDER_NOT_FOUND", "Provider 不存在")
        if (
            not provider["enabled"]
            or provider["vision_capability_status"] != "supported"
            or not provider["vision_capability_tested_at"]
            or not vision_adapter_supported(provider["vision_response_adapter_id"])
        ):
            raise DomainError(
                "VISION_PROVIDER_UNSUPPORTED",
                "Provider 未通过 vision 能力探测；请先对该 Provider 做 vision 能力探测",
            )

    @staticmethod
    def _insert_job(db: Any, jobs: Any, job_id: str, now: str, project_id: str,
                    generation_id: str, asset_id: str | None) -> None:
        """在调用方事务内落 keyframe_tagging 作业行。

        没有这一步，create 产出的 generation 永远停在 queued：全仓只有
        jobs._run 认得这个 kind，却没有任何代码创建它。
        """
        if jobs is None or not hasattr(jobs, "insert_keyframe_tagging_job"):
            return
        jobs.insert_keyframe_tagging_job(
            db, job_id, now, project_id, generation_id, asset_id,
        )

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

    def generation_status(self, project_id: str, generation_id: str) -> dict[str, Any]:
        """生成状态（S5b：Desktop 只读轮询）。零网络、**绝不跨项目**。

        键集合是冻结契约（packages/contracts 的 KeyframeGenerationStatus 逐键校验
        onlyKeys）：缺键即失败，所以缺值一律给 None 而不是省略该键。

        frame_count / vocabulary_* 从 asset_frame_tags 反推而不是另建计数列：
        同一事实存两处必然漂移。素材被删后标签行随 ON DELETE CASCADE 消失，
        此时三项如实返回 None（「不知道」比「0」诚实——0 会被读成「打了 0 帧」）。
        error_code 取自作业行：keyframe_generations 没有该列，而加列要新迁移，
        作业行的 error_code 正是失败码的唯一出处。
        """
        with self.db.connection() as db:
            row = db.execute(
                "SELECT id,status FROM keyframe_generations WHERE id=? AND project_id=?",
                (generation_id, project_id),
            ).fetchone()
            if row is None:
                # 与「不存在」同一响应：跨项目探测不该能区分二者（防枚举）。
                raise DomainError("KEYFRAME_GENERATION_NOT_FOUND", "生成记录不存在")
            counted = db.execute(
                "SELECT COUNT(*) AS frames, COUNT(notes) AS violations, "
                "MAX(vocabulary_version) AS vocabulary_version "
                "FROM asset_frame_tags WHERE generation_id=?",
                (generation_id,),
            ).fetchone()
            job = db.execute(
                "SELECT error_code FROM jobs WHERE kind=? AND input_json LIKE ? "
                "ORDER BY created_at DESC LIMIT 1",
                ("keyframe_tagging", f"%{generation_id}%"),
            ).fetchone()
        frames = int(counted["frames"]) if counted else 0
        has_tags = frames > 0
        return {
            "keyframe_generation_id": str(row["id"]),
            "status": str(row["status"]),
            "frame_count": frames if has_tags else None,
            "vocabulary_violations": int(counted["violations"]) if has_tags else None,
            "vocabulary_version": (
                int(counted["vocabulary_version"]) if has_tags else None
            ),
            "error_code": (job["error_code"] if job and job["error_code"] else None),
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

    def detach_asset(self, asset_id: str, db: Any = None) -> int:
        """素材删除前调用：断开引用但保留审计行（R17 / P102 反向陷阱）。

        若改用 ON DELETE CASCADE，外传审计记录会随素材消失（与 A12 追溯冲突）；
        若用 NO ACTION，则 DELETE FROM assets 会被 FK 拒绝（P102 原样重演）。
        显式 detach 是同时满足两者的唯一做法。

        `db` 非空时复用调用方的连接与事务——delete_asset 必须让 detach 与
        `DELETE FROM assets` 同生共死，否则崩在两句之间会留下「素材已删、
        预览仍指向它」的半删状态，而那个状态正是 FK 拒绝的来源。
        """
        now = utc_now()
        sql = (
            "UPDATE keyframe_egress_previews SET asset_id=NULL, detached_at=?,"
            "updated_at=? WHERE asset_id=? AND detached_at IS NULL"
        )
        params = (now, now, asset_id)
        if db is not None:
            return db.execute(sql, params).rowcount
        with self.db.connection() as connection:
            return connection.execute(sql, params).rowcount
