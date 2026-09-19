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


def test_the_list_sits_under_the_answer_not_above_it():
    text = agent._with_check_section("Revenue was 7,385.75.\n\nMethod: summed amount.", ["I read amount as the order total."])
    assert text.index("Revenue was") < text.index("Check before you use this") < text.index("Method:")
    assert "1. I read amount as the order total." in text


@pytest.mark.parametrize("value", [None, [], "", ["none"], ["  "], {"a": 1}])
def test_nothing_to_flag_means_no_list(value):
    assert agent._check_items(value) == []


def test_the_list_is_capped():
    assert len(agent._check_items([f"item {i}" for i in range(6)])) == agent._MAX_CHECKS


def test_the_list_does_not_split_a_lead_in_from_its_breakdown():
    text = agent._with_check_section(
        "Revenue by customer (total 7,385.75):\n\nGamma 2,605.00\nBeta 2,550.25\n\nMethod: summed.",
        ["I removed one duplicate."])
    assert text.index("Gamma 2,605.00") < text.index("Check before you use this") < text.index("Method:")


def test_a_figure_nothing_computed_is_labelled_not_asserted():
    items = agent._label_unverified(
        ["Keeping the duplicate would raise Beta Ltd to $35,401.00."],
        ["stdout: beta 2550.25 total 7385.75"], "orders csv", None, "Total 7,385.75")
    assert "not calculated" in items[0]


def test_a_figure_the_run_computed_is_left_alone():
    items = agent._label_unverified(
        ["If 1005 is a return, the total is $5,510.75."],
        ["stdout: total_if_return 5510.75"], "1005,Gamma Inc,-4", None, "Total 7,385.75")
    assert items == ["If 1005 is a return, the total is $5,510.75."]


def test_a_percentage_of_a_computed_fraction_is_backed():
    items = agent._label_unverified(["Conversion was 5.33% overall."], ["rate 0.0532765"], "", None, "")
    assert "not calculated" not in items[0]


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
