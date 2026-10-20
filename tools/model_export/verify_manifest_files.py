"""按清单校验本地模型产物：逐文件 size/sha256 + 聚合 sha256。

用法：

    .venv/Scripts/python.exe tools/model_export/verify_manifest_files.py \\
        --manifest <清单> --source <产物目录>

``--source`` 是清单 files[].path 的根目录。个别文件不在同一目录时用
``--file path=location`` 覆盖（例如 tokenizer.json 来自探针目录）。

退出码：0 全部一致；1 有不一致或缺失；2 清单本身无法解析。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def aggregate_sha256(paths: list[Path]) -> str:
    """与 aivs_core.model_registry._manifest_files_sha256 同算法、同顺序。"""
    digest = hashlib.sha256()
    for path in paths:
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
    return digest.hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="按清单校验本地模型产物")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path, help="files[].path 的根目录")
    parser.add_argument(
        "--file",
        action="append",
        default=[],
        metavar="PATH=LOCATION",
        help="覆盖单个文件的实际位置（可重复）",
    )
    args = parser.parse_args(argv)

    try:
        manifest: dict[str, Any] = json.loads(args.manifest.read_text(encoding="utf-8"))
        declared_files = list(manifest["files"])
        declared_total = int(manifest["size_bytes"])
        declared_aggregate = str(manifest["sha256"])
    except (OSError, KeyError, TypeError, ValueError) as exc:
        print(f"清单无法解析：{args.manifest}（{type(exc).__name__}: {exc}）")
        return 2

    overrides: dict[str, Path] = {}
    for item in args.file:
        name, _, location = item.partition("=")
        if not name or not location:
            print(f"--file 需要 PATH=LOCATION 形式，收到：{item}")
            return 2
        overrides[name] = Path(location)

    failures: list[str] = []
    locations: list[Path] = []
    total = 0
    print(f"清单：{args.manifest}")
    print(f"根目录：{args.source}")
    for entry in declared_files:
        name = str(entry["path"])
        path = overrides.get(name, args.source / name)
        locations.append(path)
        if not path.is_file():
            failures.append(f"{name}: 缺失（{path}）")
            print(f"[缺失] {name}  {path}")
            continue
        size = path.stat().st_size
        total += size
        actual = sha256_file(path)
        size_ok = size == int(entry["size_bytes"])
        sha_ok = actual == str(entry["sha256"])
        flag = "OK  " if size_ok and sha_ok else "FAIL"
        print(f"[{flag}] {name}  size={size} (清单 {entry['size_bytes']})")
        print(f"       sha256={actual}")
        if not size_ok:
            failures.append(f"{name}: size {size} != {entry['size_bytes']}")
        if not sha_ok:
            failures.append(f"{name}: sha256 不一致")

    if len(locations) == len(declared_files) and all(p.is_file() for p in locations):
        aggregate = aggregate_sha256(locations)
        aggregate_ok = aggregate == declared_aggregate
        print(f"[{'OK  ' if aggregate_ok else 'FAIL'}] 聚合 sha256={aggregate}")
        print(f"       清单声明={declared_aggregate}")
        if not aggregate_ok:
            failures.append("聚合 sha256 不一致（按清单 files[] 顺序串接全部文件字节）")
        if total != declared_total:
            failures.append(f"合计 size {total} != {declared_total}")
            print(f"[FAIL] 合计 size={total} 清单声明={declared_total}")
        else:
            print(f"[OK  ] 合计 size={total}")
    else:
        failures.append("缺少文件，无法计算聚合 sha256")

    if failures:
        print("")
        print("结论：不通过")
        for item in failures:
            print(f"  - {item}")
        return 1
    print("")
    print("结论：通过（全部文件 size/sha256 与聚合 sha256 均与清单一致）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
