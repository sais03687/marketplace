"""Unit test the new approval policy engine inside the container."""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, "/agent")

# Inject env vars BEFORE importing adapter so module-level constants pick them up
# (we actually already set APPROVAL_POLICY in the container env, but for this
# test we flip it at runtime by rewriting the override file).

OVERRIDE = Path("/agent/approval_policy.json")


def reset_override():
    if OVERRIDE.exists():
        OVERRIDE.unlink()


def set_override(data):
    OVERRIDE.write_text(json.dumps(data))


def run(label, recipient, risk=None, expected_needs_approval=None):
    # Re-import fresh helper each time so overrides are re-read
    import importlib
    import adapter
    importlib.reload(adapter)
    needs, reason = adapter._should_require_approval(recipient, risk or {})
    marker = "OK " if (expected_needs_approval is None or needs == expected_needs_approval) else "FAIL"
    print(f"  [{marker}] {label}: needs_approval={needs} reason={reason!r}")
    return needs == expected_needs_approval if expected_needs_approval is not None else True


print("=" * 70)
print("Test 1: Default policy (external-only) — no override file")
print("=" * 70)
reset_override()
passed = 0
total = 0
for label, recip, expected in [
    ("manager email",             "sai.suram07@gmail.com",         False),
    ("manager with display name", "Sai <sai.suram07@gmail.com>",   False),
    ("company domain",            "alice@company.com",             False),
    ("external gmail",            "random@gmail.com",              True),
    ("external corporate",        "ceo@otherco.com",               True),
]:
    total += 1
    if run(label, recip, {}, expected):
        passed += 1
print(f"  → {passed}/{total} passed\n")

print("=" * 70)
print("Test 2: policy=always — every email requires approval")
print("=" * 70)
set_override({"policy": "always"})
passed = 0
total = 0
for label, recip, expected in [
    ("manager",          "sai.suram07@gmail.com", True),
    ("company domain",   "alice@company.com",     True),
    ("external",         "random@gmail.com",      True),
]:
    total += 1
    if run(label, recip, {}, expected):
        passed += 1
print(f"  → {passed}/{total} passed\n")

print("=" * 70)
print("Test 3: policy=never — every email auto-approves")
print("=" * 70)
set_override({"policy": "never"})
passed = 0
total = 0
for label, recip, expected in [
    ("manager",          "sai.suram07@gmail.com", False),
    ("company domain",   "alice@company.com",     False),
    ("external",         "random@gmail.com",      False),
    ("suspicious",       "ceo@otherco.com",       False),
]:
    total += 1
    if run(label, recip, {}, expected):
        passed += 1
print(f"  → {passed}/{total} passed\n")

print("=" * 70)
print("Test 4: policy=risk-based, threshold=6.0")
print("=" * 70)
set_override({"policy": "risk-based", "riskThreshold": 6.0})
passed = 0
total = 0
for label, recip, risk, expected in [
    ("low risk external",  "random@gmail.com",  {"combined": 3.0}, False),
    ("exactly at threshold", "random@gmail.com", {"combined": 6.0}, True),
    ("high risk external", "random@gmail.com",  {"combined": 8.5}, True),
    ("high risk to manager", "sai.suram07@gmail.com", {"combined": 9.0}, True),
    ("low risk to manager",  "sai.suram07@gmail.com", {"combined": 1.0}, False),
]:
    total += 1
    if run(label, recip, risk, expected):
        passed += 1
print(f"  → {passed}/{total} passed\n")

print("=" * 70)
print("Test 5: Allowlist / denylist precedence")
print("=" * 70)
set_override({
    "policy": "external-only",
    "autoApprove": ["vendor@trusted.com", "@partner.io"],
    "requireApproval": ["alice@company.com"],
})
passed = 0
total = 0
for label, recip, expected in [
    ("trusted vendor (exact)",        "vendor@trusted.com",   False),
    ("trusted partner domain",        "bob@partner.io",       False),
    ("denied company employee",       "alice@company.com",    True),
    ("other company employee",        "bob@company.com",      False),
    ("other external",                "stranger@gmail.com",   True),
]:
    total += 1
    if run(label, recip, {}, expected):
        passed += 1
print(f"  → {passed}/{total} passed\n")

reset_override()
print("(cleaned up override file)")
