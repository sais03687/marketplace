"""The harness itself: the real runtime loads, with no real credentials."""


def test_the_runtime_loads_outside_its_container():
    import adapter
    from creator import agent

    # A function from each of the fixes these tests protect, so an import that
    # succeeds while losing the code under test fails here rather than silently.
    for name in ("build_notebook", "_reply_recipient", "scrub_placeholders",
                 "begin_run", "current_run_steps", "_summary_figures",
                 "_require_internal_auth", "record_sandbox_step"):
        assert hasattr(adapter, name), f"adapter is missing {name}"
    for name in ("_buyer_readable", "_rebuilt_figures", "_needs_manager_approval",
                 "_compose_reply", "_write_reply", "_markdown_table"):
        assert hasattr(agent, name), f"agent is missing {name}"


def test_tests_never_hold_a_real_credential():
    import adapter
    assert adapter.APPROVAL_TOKEN == "test-approval-token"
    assert "not-a-real" in adapter.ANTHROPIC_API_KEY
