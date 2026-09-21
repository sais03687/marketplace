"""Every anchor in the docs sidebar lands on a section that exists.

The buyers sidebar advertised "Approval Flow" at #approval-flow, which no
section has ever carried: the section is #approval-policies. Clicking it left
the reader at the top of the page, which reads as a page that did not scroll
rather than a link that was wrong, so it survived every time someone used the
docs.

Found on 2026-09-21. The general failure is a heading renamed without its link,
which is silent in a way no build step catches.
"""
import re
from pathlib import Path

DOCS = Path(__file__).resolve().parents[1] / "apps" / "web" / "app" / "(public)" / "docs"
LAYOUT = (DOCS / "layout.tsx").read_text(encoding="utf-8")


def _ids(page: str) -> set[str]:
    src = (DOCS / page / "page.tsx").read_text(encoding="utf-8")
    return set(re.findall(r'id="([a-z0-9-]+)"', src))


def _anchors() -> list[tuple[str, str]]:
    """(page, anchor) for every sidebar href carrying a fragment."""
    return re.findall(r'href: "/docs/([a-z]+)#([a-z0-9-]+)"', LAYOUT)


def test_the_sidebar_actually_links_somewhere():
    assert len(_anchors()) > 0, "no anchored links found — has the sidebar moved?"


def test_every_sidebar_anchor_has_a_section():
    missing = [
        f"/docs/{page}#{anchor}"
        for page, anchor in _anchors()
        if anchor not in _ids(page)
    ]
    assert not missing, f"sidebar links to sections that do not exist: {missing}"


def test_cross_references_inside_a_page_resolve_too():
    # Same failure, one level down: the pages link to their own sections with
    # href="#id", and a renamed heading breaks those just as quietly.
    for page in ("buyers", "creators"):
        src = (DOCS / page / "page.tsx").read_text(encoding="utf-8")
        ids = _ids(page)
        refs = set(re.findall(r'href="#([a-z0-9-]+)"', src))
        assert not (refs - ids), f"{page} links to missing sections: {sorted(refs - ids)}"
