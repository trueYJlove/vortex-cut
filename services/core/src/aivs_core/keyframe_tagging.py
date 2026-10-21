"""W3.3 Layer 2：打标执行与落库（S4）。

把三个切片接起来：
  S2 claim_for_runner（唯一放行点）→ S3 适配器（真实网络）→ 落 asset_frame_tags

三条硬约束：
  1. 必须经 claim：本模块不自己建 consent，只接受 claim 的结果。
     这是 I-1 的落点——绕过 claim 就等于绕过了用户同意。
  2. 词表外改道 notes：违规不阻断落库（规划门 §3.4）。
  3. token 撞顶重试一次：用户 2026-10-21 裁决（默认 2000 → 4000）。
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from .database import Database, json_dumps, utc_now
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
        for meta in targets:
            if cancel_event is not None and cancel_event.is_set():
                raise DomainError("JOB_CANCELLED", "已取消")
            payload = self.egress.load_payload(claim["preview_id"], int(meta["frame_index"]))
            tagged = await self._tag_one(
                provider=provider, secret=secret, jpeg=payload, vocabulary=vocabulary,
            )
            violations_total += tagged["violations"]
            results.append({
                "frame_index": int(meta["frame_index"]),
                "timestamp_us": int(meta["timestamp_us"]),
                "labels": tagged["labels"],
                "notes": tagged["notes"],
            })

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
        self, *, provider: dict[str, Any], secret: str, jpeg: bytes,
        vocabulary: Vocabulary,
    ) -> dict[str, Any]:
        request = VisionRequest(
            instruction=build_instruction(vocabulary.labels),
            labels=vocabulary.labels,
            frame_jpeg=jpeg,
        )
        budget = VISION_MAX_TOKENS
        attempts = 0
        while True:
            attempts += 1
            body = build_body(request, provider["model"], max_tokens=budget)
            url = provider["base_url"].rstrip("/") + "/chat/completions"
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
            if not parsed["exhausted"]:
                return parsed
            following = next_retry_budget(budget)
            # 只重试一次：再撞顶就如实失败，不无限烧额度。
            if following is None or attempts >= 2:
                raise DomainError(
                    "PROVIDER_TOKEN_BUDGET_EXHAUSTED",
                    "推理预算耗尽且重试无效",
                )
            budget = following

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
