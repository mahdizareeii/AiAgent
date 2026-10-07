"""Build a native standalone sidecar and include dependency license texts."""

from importlib import metadata
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parent


def write_notices() -> None:
    sections = ["Local Agent Research third-party notices", "This distribution includes dependencies under their respective licenses.", "The application code is Apache-2.0; see LICENSE."]
    for distribution in sorted(metadata.distributions(), key=lambda d: d.metadata.get("Name", "").lower()):
        name = distribution.metadata.get("Name", "unknown")
        sections.extend(["\n" + "=" * 72, f"{name} {distribution.version}", f"License: {distribution.metadata.get('License-Expression') or distribution.metadata.get('License') or 'See license texts below'}", f"Project: {distribution.metadata.get('Home-page') or distribution.metadata.get('Project-URL', '')}"])
        for file in distribution.files or ():
            if ".dist-info/" not in str(file) or not any(token in file.name.lower() for token in ("license", "copying", "notice")):
                continue
            path = distribution.locate_file(file)
            if path.is_file():
                sections.append(f"\n--- {file} ---\n{path.read_text(encoding='utf-8', errors='replace')}")
    (ROOT / "THIRD_PARTY_NOTICES.txt").write_text("\n".join(sections) + "\n", encoding="utf-8")


if __name__ == "__main__":
    write_notices()
    environment = {**os.environ, "PYINSTALLER_CONFIG_DIR": str(ROOT / ".cache" / "pyinstaller")}
    subprocess.run([sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", str(ROOT / "local-agent-research.spec")], cwd=ROOT, env=environment, check=True)
    print(f"Built {ROOT / 'dist' / 'local-agent-research'}")
