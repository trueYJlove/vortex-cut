"""W3.3 S2b：契约增量回归锁（A8）。

本文件存在的理由：`JobKind` 在契约里有**三处**必须同步——
  1. 类型联合 `JobKind`（编译期）
  2. 运行期数组 `JOB_KINDS`（`isJobKind` / `parseJob` 依赖它）
  3. 后端分派（不在本文件范围）

只改第 1 处，编译能过，但运行期 `parseJob` 会拒绝新 kind——
这是**静默失败**：类型看起来对、运行期炸。评审在设计门阶段已指出该风险
（Design Gate 评审 #8），本文件把它变成机器可判定的锁。
"""
from __future__ import annotations

import re
from pathlib import Path


CONTRACTS = Path(__file__).resolve().parents[4] / "packages/contracts/src/index.ts"


def _source() -> str:
    return CONTRACTS.read_text(encoding="utf-8")


def test_job_kind_union_declares_keyframe_tagging() -> None:
    source = _source()
    union_block = _job_kind_union(source)
    assert '"keyframe_tagging"' in union_block


def test_job_kinds_runtime_array_declares_keyframe_tagging() -> None:
    """关键一条：只改 union 不改数组 ⇒ parseJob 运行期拒绝新 kind。"""
    source = _source()
    array_block = _job_kinds_array(source)
    assert "keyframe_tagging" in array_block


def test_job_kind_union_and_array_have_same_members() -> None:
    """两个清单必须**完全一致**，不只是「都含新成员」。

    任何一边多/少一个成员都是潜在缺陷：union 多出成员 ⇒ 编译期允许但运行期拒绝；
    array 多出成员 ⇒ 运行期接受但类型不存在。
    """
    source = _source()
    union_members = set(re.findall(r'\|\s*"([a-z_]+)"', _job_kind_union(source)))
    array_members = set(re.findall(r'"([a-z_]+)"', _job_kinds_array(source)))
    assert union_members, "union 解析为空，正则会失配"
    assert array_members, "array 解析为空，正则会失配"
    assert union_members == array_members, (
        f"union 与数组不一致：仅 union {sorted(union_members - array_members)}；"
        f"仅数组 {sorted(array_members - union_members)}"
    )


def test_new_error_codes_registered() -> None:
    """失败码是开放联合，不需改类型；但必须登记进 ERROR_CODES 才可诊断。"""
    source = _source()
    for code in (
        "VISION_PROVIDER_UNSUPPORTED",
        "VISION_FRAMES_UNMAPPED",
        "KEYFRAME_PREVIEW_EXPIRED",
        "KEYFRAME_EGRESS_CONSENT_REQUIRED",
        "VISION_VOCABULARY_VIOLATION",
    ):
        assert f'"{code}"' in source, code


def test_preview_frame_has_two_byte_sets() -> None:
    """A12 的契约前提：payload_* 与 thumbnail_* 必须各自成组存在。

    只有一套字段时，「用户看到的 == 将发出去的」无法表达，
    A12 的负向对照也就没有可变红的字段。
    """
    source = _source()
    block = _interface_block(source, "KeyframePreviewFrame")
    for field in ("payload_width", "payload_height", "payload_bytes", "payload_sha256"):
        assert field in block, field
    for field in ("thumbnail_width", "thumbnail_height", "thumbnail_bytes", "thumbnail_sha256"):
        assert field in block, field


def test_parsers_are_exported() -> None:
    source = _source()
    for name in (
        "parseKeyframeEgressPreview",
        "parseKeyframePreviewFrame",
        "parseKeyframeEgressCreateResponse",
        "parseAssetFrameTagsSummary",
    ):
        assert f"export function {name}(" in source, name


# ── 解析辅助（正则失败即断言失败，不静默返回空）──


def _job_kind_union(source: str) -> str:
    match = re.search(r"export type JobKind =([\s\S]*?);", source)
    assert match is not None, "找不到 JobKind 联合定义"
    return match.group(1)


def _job_kinds_array(source: str) -> str:
    match = re.search(r"const JOB_KINDS: JobKind\[\] = \[([\s\S]*?)\];", source)
    assert match is not None, "找不到 JOB_KINDS 数组定义"
    return match.group(1)


def _interface_block(source: str, name: str) -> str:
    match = re.search(rf"export interface {name} \{{([\s\S]*?)\n\}}", source)
    assert match is not None, f"找不到接口 {name}"
    return match.group(1)
