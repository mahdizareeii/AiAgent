# Native onedir bundle. Build once on each supported platform; do not cross-compile.
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

root = Path(SPECPATH)
datas, binaries, hiddenimports = [], [], []
for package in ("mcp", "ddgs", "primp", "lxml", "pypdf", "bs4", "certifi"):
    package_data, package_binaries, package_imports = collect_all(package, filter_submodules=lambda name: not (name.startswith("mcp.cli") or name == "mcp.__main__"))
    datas += package_data
    binaries += package_binaries
    hiddenimports += package_imports
datas += [(str(root / "THIRD_PARTY_NOTICES.txt"), "."), (str(root / "LICENSE"), ".")]

a = Analysis([str(root / "sidecar.py")], pathex=[str(root)], binaries=binaries,
             datas=datas, hiddenimports=hiddenimports,
             excludes=["pytest", "tkinter", "IPython", "matplotlib", "numpy", "mcp.cli", "mcp.__main__"],
             noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="local-agent-research",
          debug=False, bootloader_ignore_signals=False, strip=False, upx=False,
          console=True, disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False,
               name="local-agent-research")
