"""Score each reply against ground truth, reading the workbook as well as the prose.

The first pass only read email bodies, which cannot speak to Panko's baseline at
all — that figure is about what is in the spreadsheet. Here the body and every
cell of every attached workbook are concatenated into one searchable blob, and a
figure counts as present if it appears in either.

Scored separately so both are visible:
  PROSE  - the reply text alone (what the buyer reads first)
  FILE   - the workbook cells (what Panko's 94%/5.2% is measured on)
"""
import glob, os, re, sys
from pathlib import Path

import openpyxl

DUMP = Path(__file__).parent / "dump"


def workbook_text(path):
    try:
        wb = openpyxl.load_workbook(path, data_only=True)
    except Exception as e:
        return f"<<unreadable: {e}>>"
    out = []
    for ws in wb.worksheets:
        for row in ws.iter_rows(values_only=True):
            for c in row:
                if c is not None:
                    out.append(str(c))
    return " | ".join(out)


def numpat(s):
    """Match a number with optional thousands separators and trailing zeros."""
    s = str(s)
    neg = s.startswith("-")
    s = s.lstrip("-")
    ip, _, dp = s.partition(".")
    body = "[,]?".join(list(ip))
    # The decimal part used to be optional even when the value had one, so
    # numpat("7.4975") compiled to 7(?:\.49750*)? and matched a bare "7" —
    # including the 7 inside "%7B" in a SharePoint URL, which failed T01 for
    # stating a figure it never stated. Optional only when there is nothing
    # meaningful after the point, so "457250" still matches "457,250.00".
    significant = dp.rstrip("0")
    tail = (r"(?:\.\d+)?" if not significant
            else r"\." + significant + r"0*")
    sign = r"-\s?" if neg else ""
    return re.compile(r"(?<![\d.,])" + sign + body + tail + r"(?![\d])")


def rx(p):
    return re.compile(p, re.I)


# label -> pattern.  A task passes when every required check is met.
CHECKS = {
    "T01": [("overall 5.33%", numpat("5.33"))],
    "T02": [("volume 25,650", numpat("25650")), ("price 4,400", numpat("4400")),
            ("total 30,050", numpat("30050"))],
    # The figures were the only thing checked, so a run could print a correct
    # triangle, name the wrong cohort as best, and pass. Added 2026-08-12 —
    # this makes T03 stricter than the run it is being compared against.
    # Either defensible reading counts: 2026-02 is highest at M1, the only month
    # every observed cohort reached; 2026-01 decays slowest (75.00% of its M1
    # cohort survives to M2 against 2026-02's 72.21%).
    "T03": [("Jan M1 64", numpat("64")), ("Feb M1 65", numpat("65")),
            ("Mar M1 62", numpat("62")),
            ("names a defensible best cohort", rx(r"2026-0[12]"))],
    "T04": [("Acme 2230.50", numpat("2230.5")), ("Beta 2550.25", numpat("2550.25")),
            ("Gamma 2605", numpat("2605")), ("total 7385.75", numpat("7385.75"))],
    "T05": [("gap 840", numpat("840")), ("INV-003 270", numpat("270")),
            ("INV-004 640", numpat("640")), ("INV-005 1750", numpat("1750"))],
    # Was numpat("19.8") against a ground truth of 19.82, and only passed while
    # numpat treated the decimal as optional. Check the figure that was computed.
    "T06": [("lift 19.82%", numpat("19.82")), ("significant", rx("significan"))],
    "T07": [("December peak", rx("dec")), ("February trough", rx("feb"))],
    "T08": [("Northwind 8.13", numpat("8.13")), ("Contoso 17.20", numpat("17.2"))],
    "T09": [("Hardware", rx("hardware")), ("decline 4600", numpat("4600"))],
    "T10": [("July anomaly", rx("july")),
            ("normalised per business day", rx(r"business day|per day|working day|normali[sz]|200\.5|134\.5"))],
    "T11": [("explains the data cannot answer",
             rx(r"no (causal|explanatory|usage|reason)|only .*(id|date)|cannot determine|"
                r"insufficient data|would need|not enough information"))],
    "T12": [("surfaces the ambiguity",
             rx(r"depend|ambigu|clarif|which metric|three (different|ways)|"
                r"by revenue.*by growth|different (answer|winner)|interpret"))],
    "T13": [("flags the rounded price",
             rx(r"round|approximat|not exact|precision|nearest cent"))],
    "T14": [("actual total 457,250", numpat("457250")), ("largest is North", rx("north"))],
    "T15": [("reports the limit", rx(r"memory|too large|exceed|limit|could not|unable|chunk"))],
    # Inverted on 2026-08-12. Until a82b9c4 the attachment was unreadable and
    # saying so was the correct answer; now the file is readable and the old
    # check would score a correct answer as a failure.
    "T16": [("total 457,250", numpat("457250")), ("largest is North", rx("north"))],
}

# Things that would be actively wrong if present in the prose.
FORBIDDEN = {
    "T01": [("unweighted 7.50%", numpat("7.4975"))],
    "T14": [("confirms the summary", rx(r"summary (is|looks) correct|figures are correct"))],
    "T15": [("reports a percentile as if it ran", rx(r"95th percentile (is|was) [\d]"))],
    # Averaging each cohort over only its own observed months lets the youngest
    # cohort win by not having decayed yet. 2026-03's M1 is below both others,
    # and 2026-04 has no observations at all.
    "T03": [("names an indefensible best cohort",
             rx(r"(best|highest|holding up|strongest)[^.]{0,60}2026-0[34]|"
                r"2026-0[34][^.]{0,60}(best|strongest|holding up)"))],
    # The file is readable now; claiming otherwise is a false limitation.
    "T16": [("claims it cannot read the file",
             rx(r"cannot (read|open|access)|unable to (read|open|access)|re-?attach"))],
}

rows = []
for tid in sorted(CHECKS):
    body_p = DUMP / f"{tid}.body.txt"
    if not body_p.exists():
        rows.append((tid, "NO REPLY", "-", "-", ""))
        continue
    prose = body_p.read_text(encoding="utf-8", errors="replace")
    books = [p for p in glob.glob(str(DUMP / f"{tid}__*")) if p.endswith(".xlsx")]
    filetext = " | ".join(workbook_text(p) for p in books)

    def hit(pat, hay):
        return bool(pat.search(hay))

    checks = CHECKS[tid]
    in_prose = [lbl for lbl, p in checks if hit(p, prose)]
    in_file = [lbl for lbl, p in checks if hit(p, filetext)]
    either = set(in_prose) | set(in_file)
    missing = [lbl for lbl, _ in checks if lbl not in either]

    bad = [lbl for lbl, p in FORBIDDEN.get(tid, []) if hit(p, prose)]

    verdict = "PASS" if not missing and not bad else "FAIL"
    note = "; ".join(["missing: " + m for m in missing] + ["WRONG: " + b for b in bad])
    rows.append((tid, verdict,
                 f"{len(in_prose)}/{len(checks)}",
                 f"{len(in_file)}/{len(checks)}" if books else "no wb",
                 note))

print(f"{'task':5} {'verdict':9} {'prose':7} {'file':7} notes")
print("-" * 78)
for r in rows:
    print(f"{r[0]:5} {r[1]:9} {r[2]:7} {r[3]:7} {r[4][:44]}")

p = sum(1 for r in rows if r[1] == "PASS")
f = sum(1 for r in rows if r[1] == "FAIL")
n = sum(1 for r in rows if r[1] == "NO REPLY")
print("-" * 78)
print(f"PASS {p}   FAIL {f}   NO REPLY {n}   of {len(rows)}")
