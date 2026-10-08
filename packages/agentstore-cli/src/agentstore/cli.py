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


def _cmd_test(args: argparse.Namespace) -> int:
    from .run import run
    message = args.message
    if args.file:
        with open(args.file, encoding="utf-8") as fh:
            message = fh.read()
    if not message:
        print('Give the email text: agentstore test "the email body", or --file email.txt')
        return 2
    approve = "yes" if args.approve else "no" if args.reject else None
    return run(args.folder, message, args.sender, args.subject, args.attach or [], approve)


def _cmd_pack(args: argparse.Namespace) -> int:
    from .pack import pack
    return pack(args.folder, args.output)


def _cmd_init(args: argparse.Namespace) -> int:
    from .init import init
    return init(args.folder)


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

    p = sub.add_parser("init", help="add marketplace.json, an agent.py wrapper and .env to a project")
    p.add_argument("folder", nargs="?", default=".")
    p.set_defaults(func=_cmd_init)

    p = sub.add_parser("check", help="find what will not work on the platform")
    p.add_argument("folder", nargs="?", default=".", help="the folder holding agent.py (default: here)")
    p.set_defaults(func=_cmd_check)

    p = sub.add_parser("test", help="run the agent on a sample email, as the platform would, on your own key")
    p.add_argument("message", nargs="?", default="", help="the email body")
    p.add_argument("--file", help="read the email body from a file instead")
    p.add_argument("--attach", action="append", help="attach a file (repeatable)")
    p.add_argument("--sender", default="Sam Buyer <sam@buyer-company.com>")
    p.add_argument("--subject", default="Test from agentstore")
    p.add_argument("--folder", default=".", help="the folder holding agent.py (default: here)")
    group = p.add_mutually_exclusive_group()
    group.add_argument("--approve", action="store_true", help="answer yes to every approval")
    group.add_argument("--reject", action="store_true", help="answer no to every approval")
    p.set_defaults(func=_cmd_test)

    p = sub.add_parser("pack", help="build the upload zip (runs check first)")
    p.add_argument("folder", nargs="?", default=".")
    p.add_argument("-o", "--output", help="where to write the zip")
    p.set_defaults(func=_cmd_pack)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
