"""attach_fn: a file the agent made in its own code goes out with the reply.

Only files produced in the Python sandbox used to reach a reply, so an agent
that drew a chart or wrote a CSV itself had no way to send it.
"""
import adapter


def _fresh_run():
    adapter._SANDBOX_FILES.clear()
    adapter._SANDBOX_FILE_NAMES.clear()
    adapter.begin_run("email:attach-test")


def test_a_file_the_agent_made_is_attached_to_the_reply():
    _fresh_run()
    handle = adapter.attach_file("discharge.png", b"\x89PNG fake")
    assert handle and handle.startswith("sandbox:")
    attached = {a["name"]: a for a in adapter.run_attachments()}
    assert "discharge.png" in attached
    assert attached["discharge.png"]["contentType"] == "image/png"


def test_text_is_accepted_and_paths_are_reduced_to_a_name():
    _fresh_run()
    assert adapter.attach_file("../../etc/routes.csv", "stop,van\nA,1\n")
    assert {a["name"] for a in adapter.run_attachments()} == {"routes.csv"}


def test_empty_oversized_or_nameless_files_are_refused():
    _fresh_run()
    assert adapter.attach_file("empty.txt", b"") is None
    assert adapter.attach_file("", b"data") is None
    assert adapter.attach_file("big.bin", b"x" * (adapter._ATTACHMENT_HANDLE_LIMIT + 1)) is None
    assert adapter.run_attachments() == []


def test_only_an_agent_that_asks_for_attach_fn_gets_it():
    async def wants(content, context, attach_fn):
        ...

    async def does_not(content, context):
        ...

    assert adapter._creator_tool_kwargs(wants)["attach_fn"] is adapter.attach_file
    assert "attach_fn" not in adapter._creator_tool_kwargs(does_not)


def test_an_emailed_attachment_can_be_opened_by_creator_code():
    handle = adapter._register_inbound_file("receipt.png", b"\x89PNG receipt")
    resolver = adapter._creator_tool_kwargs(lambda content, context, file_resolver_fn: None)["file_resolver_fn"]
    assert resolver(handle) == b"\x89PNG receipt"


def test_a_sandbox_file_still_resolves_and_nonsense_does_not():
    _fresh_run()
    handle = adapter.attach_file("chart.png", b"png")
    resolver = adapter._creator_tool_kwargs(lambda content, context, file_resolver_fn: None)["file_resolver_fn"]
    assert resolver(handle) == b"png"
    assert resolver("inbound:doesnotexist") is None and resolver(None) is None


def test_attachments_are_listed_in_context_with_handles_that_open():
    import base64

    collected = []
    note = adapter._describe_inbound_attachments([
        {"filename": "receipt.png", "contentType": "image/png",
         "content_base64": base64.b64encode(b"\x89PNG receipt").decode()},
        {"filename": "stops.csv", "contentType": "text/csv",
         "content_base64": base64.b64encode(b"name,lat,lon\nA,39.7,-86.1\n").decode()},
    ], "msg-1", collected)
    by_name = {a["name"]: a for a in collected}
    assert set(by_name) == {"receipt.png", "stops.csv"}
    assert by_name["receipt.png"]["inlined"] is False and by_name["stops.csv"]["inlined"] is True
    assert adapter.resolve_any_file(by_name["receipt.png"]["handle"]) == b"\x89PNG receipt"
    assert adapter.resolve_any_file(by_name["stops.csv"]["handle"]).startswith(b"name,lat,lon")
    assert "A,39.7,-86.1" in note   # text files are still inlined for the model, as before


def test_a_creators_own_file_is_not_held_against_the_reply():
    """Production Planner, 2026-10-11: its CSV held the plan per product, the reply
    gave the total and the value of an extra hour, and the buyer was told those
    correct figures "appear in my summary but not in the file... go with the file"."""
    import asyncio
    _fresh_run()
    adapter.attach_file("production_plan.csv", "product,quantity\nchair,24\ntable,14\n")
    reply = "Best plan, profit 2,200.00: 24 chairs and 14 tables. Extra wood is worth 1.00 a unit, labour 4.00 an hour."
    assert asyncio.run(adapter.verify_deliverables(reply)) == []


def test_a_sandbox_file_that_disagrees_with_the_reply_is_still_flagged():
    """The check still does its job on what the platform's sandbox computed."""
    import asyncio, base64
    _fresh_run()
    adapter._register_sandbox_files({"files": [{
        "name": "summary.csv",
        "base64_content": base64.b64encode(b"region,total\nWest,1234.56\nEast,999.10\n").decode(),
    }]})
    flagged = asyncio.run(adapter.verify_deliverables("West came to 1,234.56 and East to 4,321.00."))
    assert any("4,321" in f for f in flagged)
