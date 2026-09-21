"""The publish page says what a package is, and checks it before the sandbox does.

Found on 2026-09-21 by building an agent using only the UI. The upload step
asked for "your agent package" and named nothing about it: not the two files it
must contain, not that they belong at the root of the ZIP, not that agent.py has
to define two particular functions. All of that was in the docs, which the page
did not link to.

The cost is measured in round trips. A package missing resume_agent, or zipped
folder-and-all, uploads happily and fails at boot, and the creator learns that
from a vetting run minutes later. Both are knowable from the ZIP itself.
"""
from pathlib import Path

PAGE = (Path(__file__).resolve().parents[1] / "apps" / "web" / "app" / "(auth)"
        / "creator" / "publish" / "page.tsx").read_text(encoding="utf-8")


def test_the_upload_step_says_what_a_package_is():
    drop = PAGE[PAGE.index("Drop your agent package here"):][:1800]
    assert "marketplace.json" in drop
    assert "agent.py" in drop


def test_the_upload_step_links_to_the_docs():
    drop = PAGE[PAGE.index("Drop your agent package here"):][:1800]
    assert "/docs/creators" in drop


def test_the_entry_points_are_checked_before_upload():
    # The platform imports both when the container starts. A package missing one
    # builds and uploads and then does not boot.
    assert "run_agent" in PAGE and "resume_agent" in PAGE
    assert "def\\\\s+" in PAGE, "agent.py's contents should be read, not just its presence"


def test_a_folder_wrapped_zip_is_named_as_such():
    # Compressing the folder instead of its contents puts every file one level
    # down. It reads as "marketplace.json: Missing", which sends the creator
    # looking for a file that is right there.
    assert "not the folder holding them" in PAGE
