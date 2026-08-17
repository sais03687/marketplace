"""A ranking the delivered file argues against.

Deleted on 2026-08-16 for firing zero times in 44 tasks, and restored the same
day when T03 claimed "the 2026-03 cohort is holding up best with an average
retention of 62.00%" over a workbook whose M1 column holds 65 and 64. The
deleted code was run against that exact reply before restoring it, and it fired.

The deletion reasoning was wrong in a way worth keeping written down: a check
aimed at a rare, expensive failure cannot be judged by how often it fires in a
window where that failure did not occur. Across those 44 tasks T03 either
crashed, could not parse its input, or gave a defensible answer — the hazard
never arose, so the net caught nothing and was mistaken for useless.

Benchmark task T03 on 2026-08-12 built a correct retention triangle and then
reported "2026-03 is holding up best at 62.00%" with 65.00 and 64.00 in the same
column of the workbook it attached. It had averaged each cohort over only the
months that cohort had reached, so the youngest won by not having decayed yet.

Every other check on this path verifies internal consistency, which is why T04
passed while being wrong — prose and file agreed and both were wrong. This one
does not need consistency to be the answer, and it does not need to know what a
cohort is: "best is 62.00%" beside a column holding 65.00 is a contradiction on
the face of the deliverable.

The risk is the other way round. A check that fires on a correct sentence costs
a hand-back, and on 2026-08-11 a hand-back sent the agent to rebuild an
already-correct workbook twice. So most of what follows is about when it must
stay quiet.
"""
import ast
import asyncio
import io
from pathlib import Path

import pytest

import adapter
from creator import agent

RUNTIME = (Path(__file__).resolve().parents[1] /
           "apps" / "provisioning-service" / "src" / "templates" / "runtime" / "adapter.py")

# The T03 workbook, as it was delivered: the triangle, plus the average that
# produced the wrong ranking. 62.00 is in two columns and is the largest in one
# of them.
TRIANGLE = [[
    ["Cohort", "M1_retained_pct", "M2_retained_pct", "M3_retained_pct", "Avg_Retention"],
    ["2026-01", "64.00", "48.00", "40.00", "50.67"],
    ["2026-02", "65.00", "46.94", "", "55.97"],
    ["2026-03", "62.00", "", "", "62.00"],
    ["2026-04", "", "", "", ""],
]]

REGIONS = [[
    ["Region", "Revenue"],
    ["North", "45,000"],
    ["South", "30,000"],
    ["East", "25,000"],
    ["Total", "100,000"],
]]


def _conflicts(text, grids=TRIANGLE):
    return adapter._ranking_conflicts(text, grids)


# ── the bug it was built for ───────────────────────────────────────────────

def test_the_t03_claim_is_caught():
    got = _conflicts("2026-03 is holding up best at 62.00%.")
    assert got, "the claim the check exists for went unnoticed"
    assert got[0]["value"] == "62.00"
    assert got[0]["beaten_by"] == "65"
    assert got[0]["row"] == "2026-02"


def test_the_conflict_names_the_column_it_read():
    # The hand-back has to be answerable: "your file also holds 65.00" invites a
    # shrug, "M1_retained_pct also holds 65.00 (2026-02)" can be checked.
    got = _conflicts("2026-03 is holding up best at 62.00%.")
    assert got[0]["column"] == "M1_retained_pct"


def test_the_right_answer_is_not_flagged():
    assert not _conflicts("2026-02 is holding up best at 65.00% M1 retention.")


def test_a_lowest_claim_is_read_the_other_way():
    assert _conflicts("The weakest cohort at M1 is 2026-02 at 65.00%.")
    assert not _conflicts("The weakest cohort at M1 is 2026-03 at 62.00%.")


# ── and everything it must not fire on ─────────────────────────────────────

def test_a_sentence_that_names_its_column_is_read_against_that_column():
    # 62.00 is the lowest M1 and the highest average. The sentence says which it
    # means, and it is right about it — flagging it would hand back a correct
    # sentence, which is the expensive kind of wrong.
    assert not _conflicts("The weakest cohort at M1 is 2026-03 at 62.00%.")


def test_a_claim_naming_the_flattering_column_is_a_known_miss():
    # Consistent with its own file, so this check cannot see it: the error is in
    # how the average was built, not in the ranking of what is there. Recorded
    # because it is the limit of the whole approach, not an oversight.
    assert not _conflicts("2026-03 leads on Avg_Retention at 62.00%.")


def test_an_enumeration_is_not_a_claim_about_any_one_figure():
    assert not _conflicts("M1 retention is highest early: 64.00%, 65.00%, 62.00%.")


def test_a_total_row_does_not_outrank_the_rows_it_totals():
    # Every "highest region" claim loses to the total beneath it, so this would
    # fire on almost every summary ever written.
    assert not _conflicts("North is the highest region at 45,000.", REGIONS)


def test_a_genuinely_beaten_region_still_fires():
    beaten = [[["Region", "Revenue"], ["North", "45,000"], ["South", "51,000"],
               ["Total", "96,000"]]]
    got = _conflicts("North is the highest region at 45,000.", beaten)
    assert got and got[0]["beaten_by"] == "51000"


def test_a_bound_is_not_a_ranking():
    # "at least 62.00%" is ordinary summary prose. Read as a claim that 62.00 is
    # the lowest of anything, it fires on a sentence making no ranking at all.
    assert not _conflicts("Every observed cohort held at least 62.00%.")
    assert not _conflicts("No cohort lost more than at most 62.00%.")


def test_a_bound_does_not_hide_a_real_claim_in_the_same_sentence():
    assert _conflicts(
        "Every cohort held at least 40.00%, and 2026-03 is holding up best at 62.00%.")


def test_no_superlative_means_nothing_to_check():
    assert not _conflicts("2026-03 sits at 62.00% after one month.")


def test_a_figure_that_is_not_in_the_file_is_not_this_check_s_business():
    # That is the deliverable check's question, and answering it here would say
    # the same thing twice in two different voices.
    assert not _conflicts("The best month was March at 88.00%.")


def test_counts_and_ordinals_are_not_claimed_figures():
    assert not _conflicts("The top 3 cohorts are shown; month 1 is the best.")


def test_a_cohort_label_is_not_two_figures():
    # _NUMBER_RE reads "2026-03" as 2026 and -03. Left in, the label alone puts
    # the sentence over the enumeration limit and the real claim is never tested.
    figs = adapter._claimed_figures("2026-03 is holding up best at 62.00%")
    assert [f[0] for f in figs] == ["62.00"]


def test_a_percentage_under_the_substantive_floor_still_counts():
    # The deliverable check ignores bare integers under 100 — a retention figure
    # is 62.00 and a margin is 8.5%, and both are exactly what gets ranked.
    assert [f[0] for f in adapter._claimed_figures("margin was 8.5% at best")] == ["8.5"]


# ── a superlative that names a row instead of a figure ─────────────────────

# The workbook T03 actually delivered on 2026-08-13 once it could parse the
# input, with the Size column it was given.
DELIVERED = [[
    ["Cohort", "Size", "M1_retention%", "M2_retention%", "M3_retention%"],
    ["2026-01", "500", "64", "48", "40"],
    ["2026-02", "620", "65", "46.94", ""],
    ["2026-03", "450", "62", "", ""],
    ["2026-04", "700", "", "", ""],
]]


def test_the_claim_as_t03_actually_phrased_it_is_caught():
    # "The best performing cohort is 2026-03" — the exact sentence, carrying no
    # figure at all, which is why the check was silent on it the first time.
    got = _conflicts("The best performing cohort is 2026-03.", DELIVERED)
    assert got
    assert any(c["column"] == "M1_retention%" and c["beaten_by"] == "65"
               and c["row"] == "2026-02" for c in got)


def test_every_column_it_loses_in_is_reported_not_just_the_first():
    # The first is Size, where 2026-04's 700 beats it and means nothing about
    # performance. Reporting only that would be a hand-back about the wrong
    # column; reporting both makes "which metric?" answerable in one sentence.
    cols = {c["column"] for c in _conflicts("The best cohort is 2026-03.", DELIVERED)}
    assert {"Size", "M1_retention%"} <= cols


def test_it_cannot_tell_a_right_claim_from_a_wrong_one_and_does_not_pretend_to():
    # 2026-02 is the defensible answer and is still beaten somewhere — on the
    # average of differing numbers of months. The check does not say the ranking
    # is wrong; it says the file supports more than one and asks which. Naming
    # the metric is what makes the defensible answer defensible.
    assert _conflicts("The best performing cohort is 2026-02.", TRIANGLE)


def test_naming_the_metric_settles_it():
    assert not _conflicts("2026-02 leads on M1_retention% retention.", DELIVERED)


def test_a_row_the_file_does_not_have_is_not_a_claim_about_the_file():
    assert not _conflicts("The best performing cohort is 2026-09.", DELIVERED)


def test_a_row_that_leads_everywhere_is_left_alone():
    clean = [[["Region", "Revenue"], ["North", "143200"], ["South", "88900"]]]
    assert not _conflicts("North is the best region.", clean)
    assert _conflicts("South is the best region.", clean)


def test_the_nearest_named_row_is_the_subject():
    got = _conflicts("The best cohort is 2026-03, ahead of 2026-01.", DELIVERED)
    assert got and all(c["subject"] == "2026-03" for c in got)


def test_the_subject_is_said_once_however_many_columns_it_loses_in():
    conflicts = _conflicts("The best performing cohort is 2026-03.", DELIVERED)
    rendered = agent._render_ranking_conflicts(conflicts)
    assert rendered.count("you call 2026-03") == 1
    assert "Size" in rendered and "M1_retention%" in rendered


def test_the_buyers_note_names_every_row_ahead_of_the_claim():
    # Naming only the first would caveat a ranking with "2026-04 is ahead in
    # Size", which reads as confusion rather than as a real doubt.
    state = _State(budget=0, text="The best performing cohort is 2026-03.")
    state.ranking_conflicts = _conflicts(
        "The best performing cohort is 2026-03.", DELIVERED)
    state.ranking_unfixable = True
    asyncio.run(agent.finalize(state))
    assert "2026-04 in Size" in state.result["text"]
    assert "2026-02 in M1_retention%" in state.result["text"]


def test_a_figure_claim_still_takes_the_figure_path():
    # When a number is quoted it pins the column, which is strictly better
    # evidence than a row name. The label path must not pre-empt it.
    got = _conflicts("2026-03 is holding up best at 62.00%.", TRIANGLE)
    assert got and "subject" not in got[0]


# ── reading the file's shape ───────────────────────────────────────────────

def test_a_workbook_becomes_columns():
    grids = adapter._file_grids({"sheets": {"Retention": TRIANGLE[0]}})
    assert len(grids) == 1
    headers = [h for h, _ in adapter._grid_columns(grids[0])]
    assert "M1_retained_pct" in headers and "Avg_Retention" in headers


def test_a_csv_becomes_columns_too():
    csv = "Region,Revenue\nNorth,45000\nSouth,51000\n"
    grids = adapter._file_grids({"__text__": csv})
    # Only the numeric column comes back — a column of region names has nothing
    # to rank and nothing to contradict.
    assert grids and [h for h, _ in adapter._grid_columns(grids[0])] == ["Revenue"]


def test_a_pdf_table_becomes_columns_too():
    grids = adapter._file_grids({"text": "", "tables": [{"page": 1, "data": TRIANGLE[0]}]})
    assert grids and adapter._grid_columns(grids[0])


def test_prose_with_no_table_yields_nothing_to_compare():
    assert not adapter._file_grids({"text": "There is no table in this document."})


def test_prose_is_never_split_into_a_table_by_its_commas():
    # "Revenue was up, 45,000 in Q3" splits into three fields, two of them
    # fragments of one number — a column nobody wrote, holding a figure nobody
    # claimed. A PDF's real tables arrive through `tables`, already found.
    prose = ("Revenue was up, 45,000 in Q3.\n"
             "North led the way, comfortably.\n"
             "We expect, all being well, more of the same.")
    assert not adapter._file_grids({"text": prose})
    assert not adapter._file_grids({"__text__": prose})


# ── the whole path: a delivered file, parsed, read, compared ───────────────

def test_check_rankings_against_file_reads_the_file_the_run_actually_delivered(monkeypatch):
    calls = []

    async def _fake_mcp(server, tool, arguments):
        calls.append(tool)
        return {"sheets": {"Retention": TRIANGLE[0]}}

    monkeypatch.setattr(adapter, "call_mcp_tool", _fake_mcp)
    adapter._SANDBOX_FILES["f1"] = {"name": "retention.xlsx", "bytes": b"PK\x03\x04 workbook"}
    adapter._PARSED_FILES.clear()
    try:
        got = asyncio.run(adapter.check_rankings_against_file(
            "2026-03 is holding up best at 62.00%.", ["f1"]))
        assert got and got[0]["beaten_by"] == "65"
        assert calls == ["parse_xlsx"]

        # Second read of the same bytes must not cost another round trip — the
        # deliverable check reads these same files on the same pass.
        asyncio.run(adapter.check_rankings_against_file("best at 62.00%", ["f1"]))
        assert calls == ["parse_xlsx"]
    finally:
        adapter._SANDBOX_FILES.pop("f1", None)
        adapter._PARSED_FILES.clear()


def test_an_unreadable_file_is_not_evidence_of_a_wrong_claim(monkeypatch):
    async def _fails(server, tool, arguments):
        raise RuntimeError("sandbox is down")

    monkeypatch.setattr(adapter, "call_mcp_tool", _fails)
    adapter._SANDBOX_FILES["f2"] = {"name": "retention.xlsx", "bytes": b"PK\x03\x04 workbook"}
    adapter._PARSED_FILES.clear()
    try:
        assert asyncio.run(adapter.check_rankings_against_file(
            "2026-03 is holding up best at 62.00%.", ["f2"])) == []
    finally:
        adapter._SANDBOX_FILES.pop("f2", None)
        adapter._PARSED_FILES.clear()


def test_a_summary_with_no_superlative_never_touches_the_sandbox(monkeypatch):
    async def _unexpected(server, tool, arguments):
        raise AssertionError("parsed a file for a summary that ranks nothing")

    monkeypatch.setattr(adapter, "call_mcp_tool", _unexpected)
    adapter._SANDBOX_FILES["f3"] = {"name": "retention.xlsx", "bytes": b"PK\x03\x04 workbook"}
    try:
        assert asyncio.run(adapter.check_rankings_against_file(
            "2026-03 sits at 62.00% after one month.", ["f3"])) == []
    finally:
        adapter._SANDBOX_FILES.pop("f3", None)


# ── the hand-back, and what happens when it is refused ─────────────────────

class _State:
    """Only what verify_deliverables, its router and finalize read."""
    def __init__(self, budget=2, text="2026-03 is holding up best at 62.00%."):
        self.content = ""
        self.action_results = []
        self.actions_taken = []
        self.analysis = {"final_response": {"action": "reply_email", "text": text}}
        self.context = {"_wrapping_up": True}
        self.deliverable_gaps = []
        self.deliverable_unfixable = False
        self.rebuilt_figures = []
        self.rebuild_unfixable = False
        self.rebuild_attempts = 0
        self.ranking_conflicts = []
        self.ranking_attempts = 0
        self.ranking_unfixable = False
        self.headline_conflicts = []
        self.headline_attempts = 0
        self.headline_unfixable = False
        self.verify_attempts = 0
        self.max_verify_attempts = budget
        self.iteration = 3
        self.max_iterations = 12
        self.result = None


@pytest.fixture
def checked():
    """The platform's check, installed the way the adapter installs it."""
    async def _check(text, file_ids=None):
        return adapter._ranking_conflicts(text, TRIANGLE)
    agent.set_ranking_verifier(_check)
    yield
    agent.set_ranking_verifier(None)


def _verify(state):
    asyncio.run(agent.verify_deliverables(state))
    return state


def test_the_agent_is_handed_the_conflict_before_the_reply_goes_out(checked):
    state = _verify(_State())
    assert state.ranking_conflicts
    assert state.ranking_attempts == 1
    note = state.action_results[-1]
    assert note.startswith("RANKING CHECK")
    assert "62.00" in note and "65" in note


def test_the_hand_back_is_an_acting_pass_not_a_formality(checked):
    # _wrapping_up left set sends the run straight back here and the budget is
    # spent without the sentence ever being looked at again.
    state = _verify(_State())
    assert "_wrapping_up" not in state.context
    assert agent.route_after_verify(state) == "reason_and_act"


def test_the_hand_back_offers_the_narrower_comparison_as_an_answer(checked):
    # The claim may be about a subset the check cannot see. If the agent is only
    # told it is wrong, it will change a correct number.
    note = _verify(_State()).action_results[-1]
    assert "narrower" in note.lower()


def test_a_correct_ranking_is_never_handed_back(checked):
    state = _verify(_State(text="2026-02 is holding up best at 65.00%."))
    assert not state.ranking_conflicts
    assert state.action_results == []


def test_a_chat_measures_it_but_does_not_loop(checked):
    state = _verify(_State(budget=0))
    assert state.ranking_conflicts, "someone watching a chat still needs telling"
    assert state.ranking_unfixable is True
    assert state.ranking_attempts == 0
    assert agent.route_after_verify(state) == "finalize"


def test_a_claim_that_survives_the_budget_is_flagged_to_the_reader(checked):
    state = _verify(_State(budget=0))
    asyncio.run(agent.finalize(state))
    text = state.result["text"]
    assert "62.00" in text and "65" in text
    assert text.index("holding up best") < text.index("---"), "the caveat leads"


def test_the_note_does_not_declare_the_agent_wrong(checked):
    # It read columns, not meaning. A file cannot say which comparison was
    # intended, and claiming otherwise is how the deliverable note went wrong on
    # 2026-08-11 — vouching for the side that happened to be incorrect.
    text = (lambda s: (asyncio.run(agent.finalize(s)), s.result["text"])[1])(_verify(_State(budget=0)))
    lowered = text.lower()
    assert "narrower" in lowered or "either" in lowered
    assert "look at the file" in lowered


def test_a_broken_check_never_holds_up_a_correct_answer():
    async def _explodes(text, file_ids=None):
        raise RuntimeError("sandbox is down")
    agent.set_ranking_verifier(_explodes)
    try:
        state = _verify(_State())
        assert state.ranking_conflicts == []
        assert state.action_results == []
    finally:
        agent.set_ranking_verifier(None)


def test_no_verifier_installed_is_simply_no_check():
    agent.set_ranking_verifier(None)
    state = _verify(_State())
    assert state.ranking_conflicts == []


# ── every run gets it, on both channels ────────────────────────────────────

def test_every_call_site_passes_the_check_in():
    # The deliverable check shipped missing from both Teams call sites, so a chat
    # reply was never verified against its own file at all.
    src = io.open(RUNTIME, encoding="utf-8").read()
    tree = ast.parse(src)
    missing = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") in ("run_agent", "resume_agent"):
            if "ranking_fn" not in {k.arg for k in node.keywords if k.arg}:
                missing.append(node.lineno)
    assert not missing, f"call sites without ranking_fn: {missing}"


# ── the reply that proved the deletion wrong ───────────────────────────────

# T03, 2026-08-16, verbatim. Averaging each cohort over only the months it has
# reached lets the youngest win for not having decayed yet.
T03_AS_SENT = (
    "The 2026-03 cohort is currently holding up best with an average retention "
    "of 62.00%. Here's a summary of the retention percentages: "
    "2026-01: Average Retention: 50.67% 2026-02: Average Retention: 55.97% "
    "2026-03: Average Retention: 62.00%"
)
T03_WORKBOOK = [[
    ["Cohort", "M1_retention", "M2_retention", "M3_retention", "Avg_Retention"],
    ["2026-01", "64", "48", "40", "50.67"],
    ["2026-02", "65", "46.94", "", "55.97"],
    ["2026-03", "62", "", "", "62"],
    ["2026-04", "", "", "", ""],
]]


def test_the_reply_that_justified_restoring_this_is_caught():
    got = adapter._ranking_conflicts(T03_AS_SENT, T03_WORKBOOK)
    assert got, "the failure this check exists for goes out unflagged again"
    assert any(c["beaten_by"] == "65" and c["column"] == "M1_retention" for c in got)


def test_every_fire_is_logged_with_what_it_saw(capsys):
    # The decision to keep this rests on numbers nobody has yet, so each fire
    # has to be recoverable from the container log.
    adapter._ranking_conflicts(T03_AS_SENT, T03_WORKBOOK)
    import asyncio
    inbound = dict(adapter._SANDBOX_FILES)
    try:
        adapter._SANDBOX_FILES.clear()
        asyncio.run(adapter.check_rankings_against_file(T03_AS_SENT, []))
    finally:
        adapter._SANDBOX_FILES.update(inbound)
    src = __import__("io").open(adapter.__file__, encoding="utf-8").read()
    assert "[ranking-check] FIRED" in src, "a fire that leaves no trace cannot be judged later"
