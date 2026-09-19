"""The file check ignores the requester's own numbers; flags go in one list up top."""
import pytest

from creator import agent


@pytest.mark.parametrize("request_text, reply_figure", [
    ("Merchants with more than 100 transactions get the lower rate.", "100"),
    ("Standard rate is 2.9% plus $0.30.", "2.9"),
    ("Budget for the event was $1,250.00.", "1,250"),
    ("Invoice INV-4501 is overdue.", "4501"),
])
def test_a_number_the_requester_wrote_is_not_a_file_gap(request_text, reply_figure):
    assert agent._not_quoted_from_request([reply_figure], request_text) == []


def test_a_computed_number_is_still_a_file_gap():
    assert agent._not_quoted_from_request(["17.19545"], "Rate is 2.9% over 100 sales.") == ["17.19545"]


def test_the_earlier_thread_counts_as_the_request():
    assert agent._not_quoted_from_request(["480"], "Redo it please.", "Earlier: target was 480.") == []


@pytest.mark.parametrize("value", [None, [], "", ["none"], ["  "], {"a": 1}])
def test_nothing_to_flag_means_no_list(value):
    assert agent._check_items(value) == []


def test_the_list_is_capped():
    assert len(agent._check_items([f"item {i}" for i in range(6)])) == agent._MAX_CHECKS


@pytest.mark.parametrize("params, ok", [
    ('{"server": "python-sandbox", "tool": "execute_python"}', True),
    ("", True),
    ("not json", False),
    ('["a list"]', False),
])
def test_schema_mode_string_params_are_decoded(params, ok):
    analysis = {"action": {"type": "mcp_call", "params": params}}
    assert agent._decode_string_params(analysis) is ok
    if ok:
        assert isinstance(analysis["action"]["params"], dict)
