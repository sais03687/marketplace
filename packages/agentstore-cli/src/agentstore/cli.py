"""agentstore — command line entry point."""
from __future__ import annotations

import argparse
import os
import sys

from . import __version__
from .check import ERROR, check


def _cmd_check(args: argparse.Namespace) -> int:
    findings = check(args.folder)
    in_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    prefix = "" if args.folder in (".", "./") else args.folder.rstrip("/\\") + "/"
    for f in findings:
        where = f"{f.file}:{f.line}" if f.line else f.file
        if in_actions:
            # Shown on the line in GitHub's file view and in the run summary.
            kind = "error" if f.level == ERROR else "warning"
            loc = f"file={prefix}{f.file}" + (f",line={f.line}" if f.line else "")
            print(f"::{kind} {loc}::{f.message} -> {f.fix}")
        else:
            print(f"{'ERROR  ' if f.level == ERROR else 'WARNING'} {where}: {f.message}")
            print(f"        fix: {f.fix}")
    errors = sum(f.level == ERROR for f in findings)
    warnings = len(findings) - errors
    if not findings:
        print("No migration problems found.")
    else:
        print(f"\n{errors} error(s), {warnings} warning(s). "
              + ("Errors stop the upload; fix them first." if errors else "Warnings will not stop the upload."))
    return 1 if errors else 0


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to a code page that cannot print every character
    # in a finding (a dash in a fix, a non-ASCII URL); never crash on that.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(prog="agentstore", description="Agentstore tools for creators.")
    parser.add_argument("--version", action="version", version=f"agentstore {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("check", help="find what will not work on the platform")
    p.add_argument("folder", nargs="?", default=".", help="the folder holding agent.py (default: here)")
    p.set_defaults(func=_cmd_check)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
