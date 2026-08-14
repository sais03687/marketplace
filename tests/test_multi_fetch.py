"""Fetching one file per step spends the budget before the thinking starts.

DB1753 used four of its twelve steps on plumbing — a drive_list to learn the
ids, then a fetch each for payments.csv, fees.json and merchant_data.json — did
real analysis with what was left, and ran out mid-way: "I am still working on
identifying the applicable fee IDs".

Every one of those four steps was bookkeeping the platform could do itself. A
request that says "the data is in dabstep/" has already said where to look, and
the ids are a lookup, not a decision.
"""
import asyncio

import pytest

import adapter
from creator import agent

CSV = b"psp_reference,merchant\n1,Crossfit_Hanna\n"
FEES = b'[{"ID": 1, "fee": 0.1}]'


class _State:
    def __init__(self):
        self.action_results = []
        self.actions_taken = []
        self.context = {}
        self.analysis = {}
        self.iteration = 1
        self.content = ""


@pytest.fixture
def drive(monkeypatch):
    """A SharePoint folder with a subfolder, and a count of what was called."""
    files = {
        "ID_PAYMENTS": ("payments.csv", CSV),
        "ID_FEES": ("fees.json", FEES),
    }

    class _MT:
        listings = 0
        downloads = []

        @staticmethod
        async def drive_list(subfolder=""):
            _MT.listings += 1
            if subfolder == "dabstep":
                return [
                    {"name": "payments.csv", "id": "ID_PAYMENTS", "file": {}},
                    {"name": "fees.json", "id": "ID_FEES", "file": {}},
                ]
            if subfolder:
                return []
            return [{"name": "dabstep", "id": "ID_FOLDER", "folder": {}}]

        @staticmethod
        async def drive_download(item_id):
            _MT.downloads.append(item_id)
            if item_id not in files:
                raise RuntimeError(f"404 for {item_id}")
            return files[item_id]

    monkeypatch.setattr(agent, "_mt", _MT)
    agent.set_file_registrar(adapter._register_inbound_file)
    yield _MT
    agent.set_file_registrar(None)


def _fetch(params):
    # execute_action reads the action off the state, the way the graph leaves it.
    state = _State()
    state.analysis = {"action": {"type": "drive_fetch", "params": params}}
    asyncio.run(agent.execute_action(state))
    return state


# ── several files, one step ────────────────────────────────────────────────

def test_two_files_by_name_take_one_action(drive):
    state = _fetch({"files": ["payments.csv", "fees.json"]})
    assert drive.downloads == ["ID_PAYMENTS", "ID_FEES"]
    result = state.action_results[-1]
    assert "payments.csv" in result and "fees.json" in result


def test_a_name_needs_no_drive_list_first(drive):
    # The whole step this saves: the model no longer has to list the folder to
    # learn an id it was never going to read.
    _fetch({"files": ["payments.csv"]})
    assert drive.downloads == ["ID_PAYMENTS"]


def test_the_folder_is_listed_once_however_many_files_are_named(drive):
    _fetch({"files": ["payments.csv", "fees.json"]})
    # Root plus the one subfolder it found — not a listing per file.
    assert drive.listings <= 2


def test_a_named_subfolder_is_searched_directly(drive):
    _fetch({"files": ["payments.csv"], "subfolder": "dabstep"})
    assert drive.listings == 1
    assert drive.downloads == ["ID_PAYMENTS"]


@pytest.mark.parametrize("params", [
    {"files": ["payments.csv"]},
    {"filenames": ["payments.csv"]},
    {"names": ["payments.csv"]},
    {"item_ids": ["ID_PAYMENTS"]},
    {"item_id": "ID_PAYMENTS"},
    {"name": "payments.csv"},
    {"files": "payments.csv"},
    {"files": [{"name": "payments.csv"}]},
])
def test_however_the_request_is_phrased(drive, params):
    # Same lesson as the sandbox boundary: refusing a reasonable shape costs a
    # step to teach a rule the model will not remember.
    state = _fetch(params)
    assert drive.downloads, f"{params} fetched nothing"
    assert "payments.csv" in state.action_results[-1]


def test_ids_and_names_can_be_mixed(drive):
    _fetch({"files": ["ID_PAYMENTS", "fees.json"]})
    assert drive.downloads == ["ID_PAYMENTS", "ID_FEES"]


# ── and it still reports what it could not do ──────────────────────────────

def test_a_file_that_is_not_there_is_named_not_silently_skipped(drive):
    state = _fetch({"files": ["payments.csv", "ledger_2019.csv"]})
    result = state.action_results[-1]
    assert "payments.csv" in result, "the one that worked is still reported"
    assert "ledger_2019.csv" in result and "no such file" in result


def test_a_download_that_raises_does_not_lose_the_others(drive):
    state = _fetch({"files": ["ID_MISSING", "fees.json"]})
    result = state.action_results[-1]
    assert "fees.json" in result
    assert "ID_MISSING" in result


def test_nothing_fetched_says_so(drive):
    state = _fetch({"files": ["nope.csv"]})
    assert "Fetched nothing" in state.action_results[-1]


def test_a_wild_request_is_capped(drive):
    _fetch({"files": [f"file{i}.csv" for i in range(50)]})
    assert len(drive.downloads) <= agent._MAX_FETCH_PER_ACTION


def test_the_reply_points_at_the_staged_path_not_the_handle(drive):
    # The sandbox takes names now, and the name is what the model will have
    # written into its code — which is the reference that never goes wrong.
    state = _fetch({"files": ["payments.csv"]})
    assert "/tmp/input/payments.csv" in state.action_results[-1]
