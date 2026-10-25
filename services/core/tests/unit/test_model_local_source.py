"""file:// 本地来源的分发路径：变量展开、可操作报错、端到端 ready。

为什么需要这组测试：中文 CLIP 的 754MB 产物由本仓自行导出、没有可下载
URL，只能走「本机导出 → file:// 本地来源 → 校验安装」。这条路只要有一环
没接上，用户就会卡在"装不上"，而单元测试此前只覆盖 https 与直接指定的
file:// 绝对路径，覆盖不到按机器可配置的来源。

全部用合成小文件，绝不触碰真实 754MB 产物。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import pytest

from aivs_core.database import Database
from aivs_core.model_registry import ModelError, ModelManager, ModelRegistry

SOURCE_VAR = "AIVS_MODEL_SOURCE_ROOT"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


FILES = {
    "vision_model.onnx": b"\x08\x07vision" + b"\x00" * 32,
    "text_model.onnx": b"\x08\x07text" + b"\x00" * 48,
    "tokenizer.json": b'{"model": {"type": "WordPiece"}}',
}


def write_files(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in FILES.items():
        (directory / name).write_bytes(content)
    return directory


def write_source(root: Path) -> Path:
    """把合成产物放到 <root>/chinese-clip-vit-base-patch16/ 下。"""
    return write_files(root / "chinese-clip-vit-base-patch16")


def build_manifest(aggregate: str | None = None) -> dict:
    ordered = list(FILES)
    total = sum(len(FILES[name]) for name in ordered)
    return {
        "manifest_version": 1,
        "model_id": "chinese-clip-vit-base-patch16",
        "provider": "onnx-clip",
        "revision": "zh-test-1",
        "display_name": "中文 CLIP（测试合成件）",
        "purpose": "test",
        "trusted_source_id": "test-source",
        "download_url": None,
        "size_bytes": total,
        "installed_size_bytes": total,
        "sha256": aggregate
        or sha256_bytes(b"".join(FILES[name] for name in ordered)),
        "supports_word_timestamps": False,
        "runtime_version": "onnxruntime>=1.18,<2",
        "license": {
            "id": "upstream-undeclared",
            "name": "上游未声明许可——用户明确决定承担风险",
            "url": None,
            "attribution": "test",
            "acceptance_required": True,
        },
        "supported_languages": ["zh", "en"],
        "runtime_requirements": {"python": ">=3.12,<3.14"},
        "files": [
            {
                "path": name,
                "size_bytes": len(FILES[name]),
                "sha256": sha256_bytes(FILES[name]),
                "url": (
                    "file://${AIVS_MODEL_SOURCE_ROOT}/"
                    "chinese-clip-vit-base-patch16/" + name
                ),
            }
            for name in ordered
        ],
        "created_at": "2026-10-19T00:00:00.000Z",
    }


def make_manager(tmp_path: Path, manifest: dict | None = None) -> ModelManager:
    manifest_dir = tmp_path / "manifests"
    manifest_dir.mkdir(parents=True, exist_ok=True)
    payload = manifest if manifest is not None else build_manifest()
    (manifest_dir / "chinese-clip-vit-base-patch16.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )
    db = Database(tmp_path / "app.db")
    db.initialize()
    return ModelManager(db, tmp_path / "data", ModelRegistry(manifest_dir))


def run_download(manager: ModelManager, model_id: str = "chinese-clip-vit-base-patch16"):
    manifest = manager.registry.get(model_id)

    async def run():
        return await manager.download(
            manifest, asyncio.Event(), lambda _p: None, lambda _s: None
        )

    return asyncio.run(run())


def test_env_var_expansion_makes_local_source_resolvable(tmp_path: Path, monkeypatch):
    """环境变量展开生效：file://${VAR}/... 能落到真实文件。"""
    source_root = tmp_path / "model-source"
    model_dir = write_source(source_root)
    monkeypatch.setenv(SOURCE_VAR, str(source_root))
    manager = make_manager(tmp_path)
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    resolved = manager._file_url(manifest, manifest.files[0])
    assert resolved.startswith("file:///")
    assert "AIVS_MODEL_SOURCE_ROOT" not in resolved
    from urllib.parse import urlparse
    from urllib.request import url2pathname

    assert Path(url2pathname(urlparse(resolved).path)) == model_dir / manifest.files[0].path


def test_missing_env_var_raises_actionable_error(tmp_path: Path, monkeypatch):
    """未设置环境变量：必须报出变量名与"先跑导出脚本"的指引。"""
    monkeypatch.delenv(SOURCE_VAR, raising=False)
    manager = make_manager(tmp_path)
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    with pytest.raises(ModelError) as exc:
        manager._file_url(manifest, manifest.files[0])
    assert exc.value.code == "MODEL_DOWNLOAD_FAILED"
    message = exc.value.message
    assert SOURCE_VAR in message, message
    assert "export_chinese_clip_onnx.py" in message, message
    assert "未设置" in message, message


def test_env_var_set_but_file_missing_raises_actionable_error(tmp_path: Path, monkeypatch):
    """变量设了但没有产物：报出缺失路径与要跑的脚本。"""
    monkeypatch.setenv(SOURCE_VAR, str(tmp_path / "empty-source"))
    manager = make_manager(tmp_path)
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    with pytest.raises(ModelError) as exc:
        manager._file_url(manifest, manifest.files[0])
    assert exc.value.code == "MODEL_DOWNLOAD_FAILED"
    message = exc.value.message
    assert "vision_model.onnx" in message, message
    assert "export_chinese_clip_onnx.py" in message, message


def test_download_from_local_source_installs_ready(tmp_path: Path, monkeypatch):
    """端到端：file:// 本地来源 → 校验安装 → status=ready 且 _is_ready。"""
    source_root = tmp_path / "model-source"
    write_source(source_root)
    monkeypatch.setenv(SOURCE_VAR, str(source_root))
    manager = make_manager(tmp_path)

    result = run_download(manager)
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")
    assert result["installed_bytes"] == manifest.size_bytes

    detail = manager.detail("chinese-clip-vit-base-patch16")
    assert detail["status"] == "ready", detail["status"]
    ready_dir = manager.ready_path("chinese-clip-vit-base-patch16")
    assert ModelManager._is_ready(manifest, ready_dir) is True
    for name, content in FILES.items():
        assert (ready_dir / name).read_bytes() == content


def test_aggregate_hash_mismatch_is_corrupt(tmp_path: Path, monkeypatch):
    """逐文件都对但聚合 sha256 不符：必须抛 MODEL_HASH_MISMATCH。"""
    source_root = tmp_path / "model-source"
    write_source(source_root)
    monkeypatch.setenv(SOURCE_VAR, str(source_root))
    wrong = sha256_bytes(b"not the aggregate")
    manager = make_manager(tmp_path, build_manifest(aggregate=wrong))

    with pytest.raises(ModelError) as exc:
        run_download(manager)
    assert exc.value.code == "MODEL_HASH_MISMATCH"
    assert manager.detail("chinese-clip-vit-base-patch16")["status"] == "failed"
    ready_dir = (
        tmp_path / "data" / "models" / "clip"
        / "chinese-clip-vit-base-patch16" / "zh-test-1"
    )
    assert not ready_dir.exists()


def test_ready_dir_with_matching_files_but_wrong_aggregate_is_corrupt(
    tmp_path: Path, monkeypatch
):
    """逐文件 size/sha 全对、只有聚合值不符：_is_ready 仍必须为 False。

    这条把聚合校验单独夹出来：只要逐文件校验就够的话，本测试会误判为
    ready（历史上清单声明的聚合值就是这么错了两个月）。
    """
    source_root = tmp_path / "model-source"
    write_source(source_root)
    monkeypatch.setenv(SOURCE_VAR, str(source_root))
    manager = make_manager(tmp_path, build_manifest(aggregate=sha256_bytes(b"bogus")))
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    # 手工造一个"逐文件全对、marker 也匹配"的就绪目录。
    ready_dir = (
        tmp_path / "data" / "models" / "clip"
        / "chinese-clip-vit-base-patch16" / manifest.revision
    )
    write_files(ready_dir)
    (ready_dir / ".ready").write_text(
        json.dumps(
            {
                "model_id": manifest.model_id,
                "revision": manifest.revision,
                "manifest_sha256": manifest.manifest_sha256,
            }
        ),
        encoding="utf-8",
    )
    assert all(
        (ready_dir / name).read_bytes() == content for name, content in FILES.items()
    ), "逐文件内容应与清单一致（本测试只让聚合值不符）"
    assert ModelManager._is_ready(manifest, ready_dir) is False


# ── P161：https 分发通道（AIVS_MODEL_CDN）─────────────────────────────────
# 为什么需要这组：754MB 产物既不入库、也不宜打进安装包（全体用户为少数人的
# 功能付 719MB）。manifest 默认仍写 file:// 兜底本机导出；设置 AIVS_MODEL_CDN
# 后优先从该 https 基址下载。分配渠道（GitHub Releases / 对象存储）因此变成
# 配置项而非代码改动。


def test_cdn_env_overrides_file_source(monkeypatch, tmp_path: Path) -> None:
    """设置 AIVS_MODEL_CDN 时，来源变成 <base>/<files[].path>（https）。"""
    monkeypatch.delenv(SOURCE_VAR, raising=False)
    monkeypatch.setenv("AIVS_MODEL_CDN", "https://example.test/releases/v1")
    manager = make_manager(tmp_path, build_manifest())
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    url = ModelManager._file_url(manager, manifest, manifest.files[0])
    assert url == "https://example.test/releases/v1/" + manifest.files[0].path
    assert url.startswith("https://")


def test_cdn_trailing_slash_is_normalized(monkeypatch, tmp_path: Path) -> None:
    """基址带不带尾斜杠结果一致，不会拼出双斜杠。"""
    monkeypatch.delenv(SOURCE_VAR, raising=False)
    manager = make_manager(tmp_path, build_manifest())
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    monkeypatch.setenv("AIVS_MODEL_CDN", "https://example.test/releases/v1")
    without = ModelManager._file_url(manager, manifest, manifest.files[0])
    monkeypatch.setenv("AIVS_MODEL_CDN", "https://example.test/releases/v1/")
    with_slash = ModelManager._file_url(manager, manifest, manifest.files[0])
    assert without == with_slash
    assert "//" not in without.split("://", 1)[1]


def test_cdn_absent_keeps_local_file_fallback(monkeypatch, tmp_path: Path) -> None:
    """不设 CDN 时行为不变：仍走 file:// 本地来源（产物缺失则给可操作报错）。"""
    monkeypatch.delenv("AIVS_MODEL_CDN", raising=False)
    source_root = tmp_path / "source"
    write_source(source_root)
    monkeypatch.setenv(SOURCE_VAR, str(source_root))
    manager = make_manager(tmp_path, build_manifest())
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    url = ModelManager._file_url(manager, manifest, manifest.files[0])
    assert url.startswith("file://")


@pytest.mark.parametrize("scheme_url", ["ftp://evil.test/x", "http://evil.test/x"])
def test_cdn_rejects_non_https_and_plain_http(
    monkeypatch, tmp_path: Path, scheme_url: str
) -> None:
    """既有来源白名单不被 CDN 变量绕过：非 https，或指向远程明文的 http，一律拒绝。"""
    monkeypatch.delenv(SOURCE_VAR, raising=False)
    monkeypatch.setenv("AIVS_MODEL_CDN", scheme_url)
    manager = make_manager(tmp_path, build_manifest())
    manifest = manager.registry.get("chinese-clip-vit-base-patch16")

    with pytest.raises(ModelError):
        ModelManager._file_url(manager, manifest, manifest.files[0])
