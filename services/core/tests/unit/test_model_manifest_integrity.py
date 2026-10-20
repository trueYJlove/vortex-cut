"""用真实清单目录锁死模型注册表的整目录加载行为。

背景：clip-vit-base-patch32.json 的顶层 size_bytes 曾与 files[].size_bytes 合计
不一致（351685709 != 607973425），而 ModelRegistry.reload() 是全有或全无——
一份清单坏掉，整张注册表加载失败，/api/v1/models* 与语义检索全部失效，且
没有测试覆盖真实 resources/model-manifests，缺陷潜伏两个月未被发现。
本文件用仓库真实的数据目录做回归，未来任何一份清单写错都会立刻变红。
"""

from __future__ import annotations

from pathlib import Path

from aivs_core.model_registry import ModelManifest, ModelRegistry

# 从本文件向上找到含 resources/model-manifests 的祖先，不依赖 cwd。
REPO_ROOT = next(
    parent
    for parent in Path(__file__).resolve().parents
    if (parent / "resources" / "model-manifests").is_dir()
)
MANIFEST_DIR = REPO_ROOT / "resources" / "model-manifests"


def load_manifests() -> list[ModelManifest]:
    return ModelRegistry(MANIFEST_DIR).list()


def test_manifest_directory_loads_without_error() -> None:
    # reload() 是整目录原子加载：任一份清单非法都会让这里抛 ModelError。
    manifests = load_manifests()
    assert manifests, f"未从 {MANIFEST_DIR} 加载到任何 manifest"


def test_loaded_manifest_count_matches_json_file_count() -> None:
    manifests = load_manifests()
    paths = sorted(MANIFEST_DIR.glob("*.json"))
    assert paths, f"{MANIFEST_DIR} 下没有清单文件"
    assert len(manifests) == len(paths), (
        f"加载到 {len(manifests)} 份 manifest，目录里有 {len(paths)} 个 json 文件"
    )
    # 数量相等仍可能是"漏了一份、多算了一份"，因此再比对 source_file 集合。
    assert {m.source_file.resolve() for m in manifests} == {p.resolve() for p in paths}


def test_each_manifest_size_bytes_equals_sum_of_files() -> None:
    offenders = {
        m.model_id: (m.size_bytes, sum(f.size_bytes for f in m.files))
        for m in load_manifests()
        if m.size_bytes != sum(f.size_bytes for f in m.files)
    }
    assert not offenders, f"size_bytes 与 files 合计不一致: {offenders}"


def test_each_manifest_installed_size_covers_declared_size() -> None:
    offenders = {
        m.model_id: (m.installed_size_bytes, m.size_bytes)
        for m in load_manifests()
        if m.installed_size_bytes < m.size_bytes
    }
    assert not offenders, f"installed_size_bytes 小于 size_bytes: {offenders}"


def test_chinese_clip_manifest_is_registered() -> None:
    model_ids = {m.model_id for m in load_manifests()}
    assert "chinese-clip-vit-base-patch16" in model_ids, model_ids
