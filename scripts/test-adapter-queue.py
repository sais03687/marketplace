"""Test queue_for_approval from inside the container to verify end-to-end."""
import asyncio
import sys
sys.path.insert(0, "/agent")
from adapter import queue_for_approval

async def main():
    approval_id = await queue_for_approval(
        task_type="adapter-end-to-end-test",
        channel="email",
        draft="Draft text from adapter test",
        reasoning="Testing real LLM risk scores through the adapter queue",
        stakes=8.5,
        ambiguity=6.0,
        reversibility=7.5,
        thread_id="adapter-test-thread",
        original_request="Test from inside container",
    )
    print(f"Got approval_id: {approval_id!r}")
    return approval_id

asyncio.run(main())
