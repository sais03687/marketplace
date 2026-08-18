# Example workflows

Templates to copy into your own agent repository. Nothing here runs in this
repository, and that is the point.

`upload-agent.yml` used to live in `.github/workflows/`, where GitHub ran it on
every push to `main`. It failed in seven seconds every time: its
`working-directory` named an agent directory this repository does not contain,
so bash could not be started and the step died before executing a command.

The cost was not the failure, it was the habit. Every commit on `main` carried a
red X for a workflow that was never meant to run here, sitting beside `runtime
tests`, which was passing. A permanently red check trains everyone to stop
reading the checks, and then the one that matters goes unread too.

## upload-agent.yml

Zips your agent directory and uploads it to the marketplace on every push to
`main`, where it becomes a new version pending admin review.

Before it will work:

1. Copy it to `.github/workflows/upload-agent.yml` in your agent's repository.
2. Set `working-directory` to your agent's directory.
3. Add `MARKETPLACE_API_KEY` under Settings → Secrets → Actions, generated at
   <https://agentstore.it.com/creator/settings>.

The directory it points at needs a `marketplace.json` with at least `slug` and
`version` — the first step reads both out of it and the upload is rejected
without them.
