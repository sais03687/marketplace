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
