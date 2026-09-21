"""A re-uploaded package does not reuse the previous upload's URL.

Every upload of a given version wrote over the last one at a fixed blob path,
and those paths are public CDN URLs. On 2026-09-21 a corrected package was
uploaded and the vetting run that started moments later downloaded the PREVIOUS
code: the report named a traceback from a line the new package does not contain,
and a secret finding nothing in it matches. Re-running minutes later passed 5/5
on the identical upload.

The confusing direction is the harmless one. The other direction is a package
whose new code fails being vetted as the old code that passed, and approved on
that, which is the vetting gate reporting on something other than what ships.

The behaviour is tested in test_package_path_is_content_addressed.mjs so it runs
the shipped function; this file runs it under pytest and checks the upload path
is built from it.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STORAGE = (ROOT / "apps" / "web" / "lib" / "package-storage.ts").read_text(encoding="utf-8")
SCRIPT = Path(__file__).resolve().parent / "test_package_path_is_content_addressed.mjs"


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed")
def test_the_fingerprint_behaves():
    r = subprocess.run(
        ["node", "--experimental-strip-types", str(SCRIPT)],
        capture_output=True, text=True, cwd=SCRIPT.parent,
    )
    print(r.stdout or r.stderr)
    assert r.returncode == 0, r.stdout + r.stderr
    assert r.stdout.count("ok   ") >= 7, r.stdout


def test_the_upload_path_carries_the_fingerprint():
    start = STORAGE.index("export async function storeExtractedPackage")
    body = STORAGE[start:STORAGE.index("\n}\n", start)]
    assert "packageFingerprint(files)" in body, "the prefix must depend on the content"


def test_the_fingerprint_reads_both_names_and_bytes():
    # A package differing only in which file holds which bytes is a different
    # package, and must not share a URL with the other one.
    start = STORAGE.index("export function packageFingerprint")
    body = STORAGE[start:STORAGE.index("\n}\n", start)]
    assert "h.update(relativePath" in body
    assert "files.get(relativePath)" in body
