from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

hiddenimports = collect_submodules("aivs_core")
project_root = Path(SPECPATH).parents[1]
datas = [
    (str(project_root / "resources/fonts"), "fonts"),
    (str(project_root / "resources/model-manifests"), "model-manifests"),
    (str(project_root / "resources/renditions"), "renditions"),
    (str(project_root / "resources/platform-presets"), "platform-presets"),
]
binaries = []
for package in (
    "faster_whisper",
    "ctranslate2",
    "tokenizers",
    "huggingface_hub",
    "av",
    "onnxruntime",
):
    package_datas, package_binaries, package_hiddenimports = collect_all(
        package, include_py_files=True
    )
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hiddenimports

a = Analysis(
    [str(project_root / "services/core/entrypoint.py")],
    pathex=[str(project_root / "services/core/src")],
    hiddenimports=hiddenimports,
    datas=datas,
    binaries=binaries,
    name="aivs-core",
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, name="aivs-core", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="aivs-core")
