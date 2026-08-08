from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

hiddenimports = collect_submodules("aivs_core")
project_root = Path(SPECPATH).parents[2]

a = Analysis(
    [str(project_root / "services/core/src/aivs_core/bootstrap.py")],
    pathex=[str(project_root / "services/core/src")],
    hiddenimports=hiddenimports,
    datas=[],
    name="aivs-core",
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, name="aivs-core", console=True)
coll = COLLECT(exe, a.binaries, a.datas, name="aivs-core")
