"""Build the upload zip the way the platform expects it."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

from .check import ERROR, check

# The same exclusions the publish workflow uses, so a zip built here and one built
# on GitHub hold the same files.
EXCLUDE_DIRS = {".git", ".github", "__pycache__", "node_modules", "tests", ".venv", "venv", "env"}
EXCLUDE_NAMES = {".DS_Store"}
EXCLUDE_PREFIXES = (".env",)
EXCLUDE_SUFFIXES = (".pyc", ".zip")


def _included(rel: Path) -> bool:
    if any(part in EXCLUDE_DIRS for part in rel.parts[:-1]):
        return False
    name = rel.name
    return not (name in EXCLUDE_NAMES or name.startswith(EXCLUDE_PREFIXES) or name.endswith(EXCLUDE_SUFFIXES))


def pack(folder: str, out: str | None = None) -> int:
    root = Path(folder).resolve()
    errors = [f for f in check(root) if f.level == ERROR]
    if errors:
        print("Not packed — fix these first (run `agentstore check` for the details):")
        for f in errors:
            print(f"  {f.file}{':' + str(f.line) if f.line else ''}: {f.message}")
        return 1
    manifest = json.loads((root / "marketplace.json").read_text(encoding="utf-8"))
    target = Path(out) if out else root.parent / f"{manifest['slug']}-{manifest['version']}.zip"
    files = [p for p in sorted(root.rglob("*")) if p.is_file() and _included(p.relative_to(root))
             and p.resolve() != target.resolve()]
    # Contents at the top level, not the folder: the platform looks for
    # marketplace.json at the root of the archive.
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files:
            z.write(p, p.relative_to(root).as_posix())
    print(f"Packed {len(files)} file(s) into {target}")
    for p in files:
        print(f"  {p.relative_to(root).as_posix()}")
    print("Upload it at Creator → Publish, or push to GitHub with the template's workflow.")
    return 0
