"""W3.3 Layer 2：打标执行与落库（S4）。

把三个切片接起来：
  S2 claim_for_runner（唯一放行点）→ S3 适配器（真实网络）→ 落 asset_frame_tags

四条硬约束：
  1. 必须经 claim：本模块不自己建 consent，只接受 claim 的结果。
     这是 I-1 的落点——绕过 claim 就等于绕过了用户同意。
  2. 词表外改道 notes：违规不阻断落库（规划门 §3.4）。
  3. token 撞顶重试一次：用户 2026-10-21 裁决（默认 2000 → 4000）。
  4. 每一次真实 HTTP 调用落一条 provider_invocations 行（规划门 A10：
     「行数 == 调用次数」）。撞顶重试是**第二次真实调用**，因此也是第二行——
     只按帧计数会让「重试有没有发生」不可断言，而重试正是烧额度的地方。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import httpx

from .database import Database, json_dumps, json_loads, utc_now
from .ids import new_id
from .keyframe_egress import FRAME_TAGS_ALGORITHM_VERSION, KeyframeEgressService
from .media.keyframe_vocab import Vocabulary, load_vocabulary
from .media.vision_adapter import (
    VISION_MAX_TOKENS,
    VisionRequest,
    build_body,
    build_instruction,
    next_retry_budget,
    parse_tag_response,
)
from .projects import DomainError

# provider_invocations 的稳定标识（审计用，不是 UI 文案）。
KEYFRAME_TAGGING_CAPABILITY = "keyframe_tagging"
KEYFRAME_PROMPT_TEMPLATE_VERSION = "keyframe-tagging-instruction-v1"
KEYFRAME_OUTPUT_SCHEMA_VERSION = "keyframe-tags-output-v1"


class KeyframeTaggingService:
    def __init__(
        self,
        db: Database,
        egress: KeyframeEgressService,
        providers: Any,
        vault: Any,
        *,
        client_factory: Any = None,
        vocabulary: Vocabulary | None = None,
    ) -> None:
        self.db = db
        self.egress = egress
        self.providers = providers
        self.vault = vault
        self._client_factory = client_factory or (lambda **kw: httpx.Client(**kw))
        self._vocabulary = vocabulary

    @property
    def vocabulary(self) -> Vocabulary:
        if self._vocabulary is None:
            self._vocabulary = load_vocabulary()
        return self._vocabulary

    # ── 作业执行体（jobs.py 的 keyframe_runner 槽位）──

    async def run_tagging_job(
        self,
        row: Any,
        cancel_event: Any,
        progress: Any = None,
        stage: Any = None,
    ) -> dict[str, Any]:
        """JobService 分派入口：与其它 runner 同签名。

        失败必须把 keyframe_generations 落到 failed：只让作业行失败的话，
        generation 会永远停在 running，而状态查询路由读的正是 generation——
        桌面端会永久显示「进行中」（REST 侧无超时可以救它）。
        错误码不落 generation 表：该表没有 error_code 列，加列要新迁移；
        状态查询改读作业行的 error_code（同一事实只有一个出处）。
        """
        payload = json_loads(row["input_json"]) or {}
        generation_id = str(payload.get("keyframe_generation_id") or "")
        project_id = str(payload.get("project_id") or row["project_id"] or "")
        if not generation_id or not project_id:
            raise DomainError("KEYFRAME_JOB_INVALID", "作业载荷缺少生成记录标识")
        if stage:
            stage("keyframe:tagging")
        try:
            result = await self.tag_generation(
                project_id, generation_id, cancel_event=cancel_event,
            )
        except Exception as exc:
            code = getattr(exc, "code", None) or "INTERNAL_ERROR"
            self.mark_failed(project_id, generation_id, code)
            # 失败路径同样清理：载荷字节的唯一用途是外传，而外传已经发生过
            # （claim 在此之前完成）。留着不删只会在磁盘上多躺 15 分钟到一个
            # 启动周期。不破坏重试语义——理由见 _purge_payloads 的 docstring。
            self._purge_payloads(generation_id)
            raise
        self._purge_payloads(generation_id)
        if progress:
            progress(1.0)
        return result

    def _purge_payloads(self, generation_id: str) -> int:
        """打标收尾清理该 generation 的预览载荷字节（成功与失败都调）。

        **清理点选在 run_tagging_job 而不是 _persist 之后**：_persist 只在
        成功路径上跑，失败路径（Provider 400、预算耗尽、用户取消）会带着
        载荷字节退出——那批字节已经外传过了（claim 已完成），没有任何理由
        再留在盘上。放在 run_tagging_job 里、两条路径的汇合处，是同时覆盖
        「打标成功」与「打标失败」的唯一一处。

        失败路径清理会破坏「重试」吗？不会，而且这是核实过的：
          · jobs.retry 只把**作业行**置回 queued，keyframe_generations 保持 failed；
          · 重跑作业会重新 claim 同一份 consent，而 claim_for_runner 对已消费
            consent 直接抛 KEYFRAME_EGRESS_CONSENT_REQUIRED——载荷在与不在都跑不通；
          · 桌面面板没有重试按钮，失败后给的是「重新生成预览并再次确认」，
            即全新 prepare + create（新 preview_id、新载荷）。
        也就是说：失败后唯有重新走一次用户同意才能再次外传，与字节是否留在
        盘上无关；留着只多一份泄露面，不增加可恢复性。

        清理自身绝不抛：它跑在作业收尾处，抛出去会把一次**已经成功落库**的
        打标变成 failed（状态谎报）。启动期 purge 的容错口径与此一致
        （app.py:981-984 同样吞异常）。
        """
        try:
            preview_id = self._preview_id_for(generation_id)
            if not preview_id:
                return 0
            return self.egress.purge_preview(preview_id)
        except Exception:  # noqa: BLE001 清理失败不得改写打标结果
            return 0

    def _preview_id_for(self, generation_id: str) -> str:
        with self.db.connection() as db:
            row = db.execute(
                "SELECT egress_preview_id FROM keyframe_generations WHERE id=?",
                (generation_id,),
            ).fetchone()
        return str(row["egress_preview_id"]) if row else ""

    def mark_failed(self, project_id: str, generation_id: str, code: str) -> bool:
        """把**仍在 running** 的 generation 落终态；已终态的不覆盖。

        WHERE 里带 status='running' 的理由：claim 之前就失败的（例如同意书
        已消费）根本没有进入 running，把它改成 failed 是把「未执行」谎报成
        「执行失败」。取消走 cancelled，其余一律 failed。
        """
        target = "cancelled" if code == "JOB_CANCELLED" else "failed"
        with self.db.connection() as db:
            return db.execute(
                "UPDATE keyframe_generations SET status=?,finished_at=? "
                "WHERE id=? AND project_id=? AND status=?",
                (target, utc_now(), generation_id, project_id, "running"),
            ).rowcount > 0

    async def tag_generation(
        self, project_id: str, generation_id: str, *, cancel_event: Any = None,
    ) -> dict[str, Any]:
        """执行一次打标生成。调用前必须已 claim（否则 DomainError）。"""
        claim = self.egress.claim_for_runner(project_id, generation_id)
        frames = json.loads(claim["frames_json"] or "[]")
        excluded = set(claim["excluded_frames"] or [])
        provider = self._require_provider(claim["provider_config_id"])
        secret = self.vault.for_request(claim["provider_config_id"])
        vocabulary = self.vocabulary

        # 只处理未被用户移除的帧——被移除的帧不得外传（I-3）。
        targets = [f for f in frames if int(f["frame_index"]) not in excluded]
        if not targets:
            raise DomainError("VISION_FRAMES_UNMAPPED", "没有可外传的帧")

        results: list[dict[str, Any]] = []
        violations_total = 0
        for ordinal, meta in enumerate(targets):
            if cancel_event is not None and cancel_event.is_set():
                raise DomainError("JOB_CANCELLED", "已取消")
            payload = self.egress.load_payload(claim["preview_id"], int(meta["frame_index"]))
            tagged = await self._tag_one(
                generation_id=generation_id,
                provider_id=claim["provider_config_id"],
                provider=provider, secret=secret, jpeg=payload, vocabulary=vocabulary,
            )
            violations_total += tagged["violations"]
            results.append({
                "frame_index": int(meta["frame_index"]),
                "timestamp_us": int(meta["timestamp_us"]),
                "labels": tagged["labels"],
                "notes": tagged["notes"],
            })
            # 逐帧推进：素材帧数多的打标会持续几分钟，没有进度就是黑箱。
            self._set_job_progress(generation_id, (ordinal + 1) / len(targets))

        self._persist(
            asset_id=str(claim.get("asset_id") or ""),
            fingerprint=str(claim.get("source_fingerprint") or ""),
            provider_config_id=claim["provider_config_id"],
            generation_id=generation_id,
            results=results,
            vocabulary=vocabulary,
        )
        return {
            "generation_id": generation_id,
            "frame_count": len(results),
            "vocabulary_violations": violations_total,
            "vocabulary_version": vocabulary.vocabulary_version,
        }

    async def _tag_one(
        self, *, generation_id: str, provider_id: str, provider: dict[str, Any],
        secret: str, jpeg: bytes, vocabulary: Vocabulary,
    ) -> dict[str, Any]:
        request = VisionRequest(
            instruction=build_instruction(vocabulary.labels),
            labels=vocabulary.labels,
            frame_jpeg=jpeg,
        )
        input_sha256 = hashlib.sha256(jpeg).hexdigest()
        budget = VISION_MAX_TOKENS
        attempts = 0
        while True:
            attempts += 1
            body = build_body(request, provider["model"], max_tokens=budget)
            url = provider["base_url"].rstrip("/") + "/chat/completions"
            # 审计行在**调用之前**落：进程若在请求中途死去，留下的是
            # 一行 running（= 可能已处理），而不是查无此调用。
            invocation_id = self._start_invocation(
                generation_id=generation_id, provider_id=provider_id,
                provider=provider, input_sha256=input_sha256,
            )
            try:
                with self._client_factory(timeout=240.0, trust_env=False) as client:
                    response = client.post(
                        url,
                        json=body,
                        headers={"Authorization": f"Bearer {secret}"},
                    )
                if response.status_code != 200:
                    raise DomainError(
                        "VISION_PROVIDER_UNSUPPORTED",
                        f"Provider 返回 {response.status_code}",
                    )
                parsed = parse_tag_response(response.json(), vocabulary.labels)
            except DomainError as exc:
                self._finish_invocation(invocation_id, "failed", exc.code)
                raise
            except Exception:
                self._finish_invocation(
                    invocation_id, "failed", "VISION_PROVIDER_UNSUPPORTED",
                )
                raise
            if not parsed["exhausted"]:
                self._finish_invocation(invocation_id, "succeeded")
                return parsed
            following = next_retry_budget(budget)
            # 撞顶这次调用**已经发生且已经烧掉额度**：如实记 failed，
            # 重试是另一行（A10 要的是调用次数，不是帧数）。
            self._finish_invocation(
                invocation_id, "failed", "PROVIDER_TOKEN_BUDGET_EXHAUSTED",
            )
            # 只重试一次：再撞顶就如实失败，不无限烧额度。
            if following is None or attempts >= 2:
                raise DomainError(
                    "PROVIDER_TOKEN_BUDGET_EXHAUSTED",
                    "推理预算耗尽且重试无效",
                )
            budget = following

    def _start_invocation(
        self, *, generation_id: str, provider_id: str, provider: dict[str, Any],
        input_sha256: str,
    ) -> str:
        invocation_id = f"invocation_{new_id()}"
        with self.db.connection() as db:
            db.execute(
                "INSERT INTO provider_invocations(id,keyframe_generation_id,"
                "provider_config_id,capability,provider_name,model,"
                "prompt_template_version,output_schema_version,input_sha256,status,"
                "started_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    invocation_id,
                    generation_id,
                    provider_id,
                    KEYFRAME_TAGGING_CAPABILITY,
                    str(provider.get("display_name") or provider_id),
                    str(provider.get("model") or ""),
                    KEYFRAME_PROMPT_TEMPLATE_VERSION,
                    KEYFRAME_OUTPUT_SCHEMA_VERSION,
                    input_sha256,
                    "running",
                    utc_now(),
                    utc_now(),
                ),
            )
        return invocation_id

    def _finish_invocation(
        self, invocation_id: str, status: str, error_code: str | None = None,
    ) -> None:
        """幂等收尾：已收尾的行不再改（重试/异常路径可能重复调用）。

        status='running' 的条件让「先写成 failed 再被 succeeded 覆盖」这种
        last-writer-wins 的谎言结构上不可能发生。
        """
        with self.db.connection() as db:
            db.execute(
                "UPDATE provider_invocations SET status=?,finished_at=?,error_code=? "
                "WHERE id=? AND status='running'",
                (status, utc_now(), error_code, invocation_id),
            )

    def _set_job_progress(self, generation_id: str, progress: float) -> None:
        """按 generation 找作业行推进度（generation ↔ job 由 input_json 关联）。"""
        with self.db.connection() as db:
            db.execute(
                "UPDATE jobs SET progress=?,updated_at=? WHERE kind=? AND status='running' "
                "AND input_json LIKE ?",
                (progress, utc_now(), "keyframe_tagging", f"%{generation_id}%"),
            )

    def _require_provider(self, provider_config_id: str) -> dict[str, Any]:
        provider = self.providers.get(provider_config_id)
        if provider is None:
            raise DomainError("VISION_PROVIDER_UNSUPPORTED", "Provider 配置不存在")
        if not provider.get("enabled"):
            raise DomainError("VISION_PROVIDER_UNSUPPORTED", "Provider 已停用")
        return provider

    def _persist(
        self, *, asset_id: str, fingerprint: str,
        provider_config_id: str, generation_id: str,
        results: list[dict[str, Any]], vocabulary: Vocabulary,
    ) -> None:
        if not asset_id or not fingerprint:
            raise DomainError("VISION_FRAMES_UNMAPPED", "生成记录缺少素材归属")
        now = utc_now()
        with self.db.connection() as db:
            for item in results:
                db.execute(
                    "INSERT INTO asset_frame_tags (id,asset_id,source_fingerprint,"
                    "algorithm_version,vocabulary_id,vocabulary_version,status,reason,"
                    "frame_index,timestamp_us,labels_json,notes,provider_config_id,"
                    "generation_id,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        new_id(), asset_id, fingerprint,
                        FRAME_TAGS_ALGORITHM_VERSION,
                        vocabulary.vocabulary_id, vocabulary.vocabulary_version,
                        "ready", None,
                        item["frame_index"], item["timestamp_us"],
                        json_dumps(item["labels"]), item["notes"],
                        provider_config_id, generation_id, now, now,
                    ),
                )
            db.execute(
                "UPDATE keyframe_generations SET status=?,finished_at=? WHERE id=?",
                ("succeeded", now, generation_id),
            )
