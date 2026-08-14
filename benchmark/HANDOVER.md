# Marketplace agent — handover (as of 2026-08-14)

## Where it stands after the 2026-08-13/14 session

Main is at `7c75fd8`, 337 tests, deployed. Two benchmarks run serially, one
task at a time, on the current code:

| | result | previously |
|---|---|---|
| Bespoke 16 (messy-data traps) | **13 pass / 3 fail / 0 no reply** | 10 / 6 / 0 |
| DABstep dev 10 (real, published answers) | **1 pass / 9 fail** | 1 / 9 |

The bespoke set is the one that moved, and it is the one that measures the
product: sixteen ordinary questions about broken data. DABstep is ten hard
questions about clean data, and the failures there are domain reasoning — fee
rules from `manual.md` applied to the wrong subset — not plumbing.

**What was actually wrong, and is now fixed.** Nine of the day's commits were
live bugs that had nothing to do with benchmarks:

- `stderr[:1200]` cut the exception off the end of every deep traceback, so the
  model never saw its own error. T03 failed three consecutive runs guessing at a
  parse error it had not been shown; with the tail kept it succeeded first try.
- `_set_reply` discarded composed replies, because `"none"` is truthy and `or`
  never replaced it. Every approval-gated email was exposed.
- Graph answers a file download with a 302 and httpx does not follow redirects,
  so `drive_read_text` was broken for every buyer, silently.
- The netgate allowed `graph.microsoft.com` but not the host the bytes actually
  come from, so the agent could list a file it was authorised to read and never
  open it.
- No path existed from a workspace file to the sandbox at all (`drive_fetch`).
- The file registries were capped by count, so sixteen handles was 377 MB of a
  512 MB container; it restarted mid-benchmark.
- A silent 2000-character truncation on `drive_read_text`.

**The one that generalises.** The model kept sending file references in shapes
the boundary refused — a handle in a dict, a bare SharePoint id, a name-to-handle
mapping, an empty list beside code that opened the file anyway. Four shapes, four
runs lost. Patching shapes failed three times; what worked was reading the *code*
as the declaration: stage every `/tmp/input/<name>` the code opens, for files the
run holds. **Infer intent from the artifact that cannot be wrong.** Worth asking
of every other tool boundary.

**Deleted:** the superlative check. Zero fires in 44 live tasks. Built from one
task's failure, extended once, never earned its place.

## What is still wrong, in priority order

1. **T04 — confidently wrong, undetected.** Four incorrect customer totals,
   `"Acme Corp "` and `"Acme Corp"` kept apart while claiming they were merged.
   No check fires, because prose and file agree with each other. This is the
   trust ceiling and it has not moved all day.
2. **T11, T12, DB70 — will not say "this cannot be answered".** Three
   independent sightings. T11 asks why customers churned when the data holds only
   dates; T12 asks for "top performers" when three metrics give three winners.
   Honesty holds where it is mechanical and gives way where it needs reasoning
   about absence.
3. **DABstep hard tasks — domain rules.** It answered 48 where the fee was 0.12.
   Not a step-budget problem and not a plumbing problem.

## The measurement discipline that made today work

Read mechanism counts, not the score. A score mixes every cause and is swamped by
variance — T03 gave three different answers to the same task in one afternoon. A
mechanism either fires or it does not:

```
handle refusals   58 of 77 calls  →  1 of 10 tasks
plumbing steps    4 per task      →  2 per task
```

Both measured on nine tasks that were never iterated against. The score did not
move while those did, which is the signature of a real fix rather than a tuned
one — and is the reason to distrust a change that moves the score alone.

## Track B is running (2026-08-14)

Data is in SharePoint at `data-analyst/dabstep/` — all seven DABstep context
files, `payments.csv` uploaded via a Graph upload session because a simple PUT
is capped at 4 MB. Harness: `/root/dabstep/send.mjs <task_id...>` and
`/root/dabstep/score.mjs`, dev answers in `/root/dabstep/tasks/dev.jsonl`.

**Only the 10 dev tasks can be scored.** `all.jsonl` ships 450 tasks with every
`answer` field blank — they are withheld for the leaderboard. 3 easy, 7 hard.
Published baselines: humans 62% after 3+ hours, best agents ≤16% hard, ~76% easy.

### Second full dev run, serial, 2026-08-14 03:0x — PASS 1/10, and the failure mode moved

The verification pass for everything above, run one task at a time on the nine
tasks that were never tuned against. Mechanism counts, per task:

```
DB5 DB49 DB70 DB1273 DB1305 DB1464 DB1681 DB1753 DB1871 DB2697
plumbing_steps  = 2 on every one of them   (was 4)
handle_refusals = 0 on all but DB5, which had 1   (was 58 of 77 calls)
```

Both mechanisms hold on tasks I did not iterate against, which is what the run
was for. **The score is 1/10, exactly as before.**

**What actually changed is the failure mode, and it is not all good news.**
Before, six of seven hard tasks said "I was unable to". Now most of them answer:

| | first run | this run |
|---|---|---|
| DB1273 | "I was unable to calculate" | "the average fee … is 48…" (answer: 0.120132) |
| DB1464 | "I was unable to retrieve" | "the fee IDs … are: 34, 39, 49, 62, 68, 82…" (a subset of a 338-id answer) |
| DB1871 | "I was unable to calculate" | "the delta … would pay in January 2023 is…" |
| DB2697 | "I was unable to complete" | "the preferred choice … is…" |
| DB49 | errored | "the top country for fraud is: A. NL" (answer: B. BE) |

Three still cannot get there — DB1305, DB1753 (ran out of steps mid-analysis) and
DB1681 (killed by the container restart, so it does not count as evidence).

So the plumbing work did what it was meant to: the agent now reaches its data and
computes. **And the result is that it has moved from honest failure to confident
error.** For a benchmark that is neutral — both score zero. For a product whose
premise is "every document contains what was asked for", it is a step backwards
in the dimension that matters most: "I was unable to calculate" is safe, and "the
average fee is 48" when the answer is 0.12 is not.

Nothing in the verification layer catches any of it, because prose and file agree.
That is [[marketplace-verification-limit]] with the plumbing excuse removed, and
it is now the whole problem rather than a footnote to it.

**The next bottleneck is domain correctness, not steps.** The fee questions need
`manual.md`'s rules applied to the right subset of rows; getting 48 where the
answer is 0.12 is not a step-budget problem. That is the same wall T04 and T07 hit
from the other side.

### The accepting boundary, and what it moved (2026-08-14, later)

The 58-of-77 "Unknown file handle" figure held up under scrutiny: 58 were real
tool results, 9 were the model quoting the error back, and there were 15 distinct
payloads, so it was not one bug counted many times. What it was *not* is the
model losing handles. It had them:

```
{'file_id': 'inbound:1a5a24ef5f37', 'filename': 'payments.csv'}   38 of 58
{'id': '01HBC6OG…', 'filename': 'payments.csv'}                   16 of 58
{'payments.csv': 'inbound:c7239fdd558f', 'fees.json': '01HBC…'}   (next run)
input_files: []  beside code reading /tmp/input/payments.csv      (run after that)
```

Four shapes in two days, each costing a run, each a reasonable way to say the
thing. `e89af04` and `1f84498` accept the first three. `384525d` is the one that
matters: **the code is read as the declaration**. Every `/tmp/input/<name>` the
code opens is staged if this run holds a file by that name. The model declares a
file twice — once in `input_files`, once by opening it — and only the second is
load-bearing, so only the second is trustworthy. A path in code is a request and
not an authorisation: a name we do not hold stages nothing.

**Measured on DB1753, same task, three deploys:**

| | handle refusals | data reached the sandbox |
|---|---|---|
| before | 58 of 77 calls | no |
| after the shape fixes | 2 of 7 | no |
| after code-derived staging | **0 of 9** | **yes** — real columns printed |

The failure class is gone. The task still fails, and now for a different reason:
it spent 3 of 12 steps on `drive_list` plus three `drive_fetch` calls, did real
analysis, and hit the step ceiling mid-way — "I am still working on identifying
the applicable fee IDs". **The step budget is the new binding constraint**, and
the obvious levers are fetching several files in one action, and not needing
`drive_list` before `drive_fetch` when the mail already named the folder.

### Full dev set, 2026-08-14: PASS 1 / 10 (1 of 3 easy, 0 of 7 hard)

```
DB5     easy  PASS   NL
DB49    easy  FAIL   B. BE            — errored while analysing payments.csv
DB70    easy  FAIL   Not Applicable   — answered the question instead of checking it applied
DB1273  hard  FAIL   0.120132         — "I was unable to calculate…"
DB1305  hard  FAIL   0.123217         — "I was unable to calculate…"
DB1464  hard  FAIL   (338 fee ids)    — "I was unable to retrieve…"
DB1681  hard  FAIL   (10 fee ids)     — "I encountered errors…"
DB1753  hard  FAIL   (34 fee ids)     — "I was unable to determine…"
DB1871  hard  FAIL   -0.948103        — "I was unable to calculate…"
DB2697  hard  FAIL   E:13.57          — "I was unable to complete…"
```

Against published baselines (best agents ~76% easy, ≤16% hard) that is below the
field on easy and at the floor on hard. n=10 and one run each, so treat it as a
first reading rather than a position.

**The number is the least interesting part of it. Six of the seven hard failures
said "I was unable to" — the agent did not invent a single figure.** On a
benchmark scoring only correctness that is worth exactly zero, and it is the
product thesis holding under real pressure: these are questions it could not
answer, reported as questions it could not answer.

The one exception is DB70, where ground truth is "Not Applicable" and the agent
answered the question as posed. Written up first as "the merchant is not in the
data" — that is **wrong**: `payments.csv` holds five merchants and
Martinis_Fine_Steakhouse is one of them. The question is unanswerable for some
other reason, not yet established; read `manual.md` on fraud-rate fines before
repeating any explanation of it. What survives the correction is the shape of the
failure — a question whose right answer is "this cannot be answered" was answered
anyway, which is the third sighting of that gap (T11, T12, DB70).

**Why the hard tasks failed, from the logs — two causes, and the first is ours:**

1. **Handle bookkeeping across several files.** DB5 needed one file and worked.
   The hard tasks need `payments.csv` plus `fees.json` plus sometimes
   `merchant_data.json`, and the model has to carry three `inbound:` handles from
   three separate `drive_fetch` results into one `execute_python` call. It loses
   track: "the file handles were unknown", then `FileNotFoundError:
   /tmp/input/payments.csv` with nothing staged at all.

   The fix is to stop making it bookkeep. `input_files` should accept the file's
   **name** — "payments.csv" — and resolve it against what this run has fetched.
   The platform already knows the mapping; making the model relay opaque tokens
   between calls is the part that breaks. **This is the top next step.**

2. **Data-shape reasoning.** `KeyError: 'merchant_name'` — the column is
   `merchant`. The same class as T03's ragged row: the model writes code against
   a shape it assumed rather than one it looked at.

Cosmetic, from the same runs: `_SANDBOX_PATH` scrubbing turns
`FileNotFoundError: '/tmp/input/payments.csv'` into `…: 'a working file` with the
quote left hanging. Harmless, ugly, in buyer-facing text.

**DB5's path, for the record.** `payments.csv` went SharePoint → Graph 302 →
platform download → handle → `input_files_staged: ["payments.csv"]` → `NL`, which
is the published answer. Nothing pre-staged.

Four things had to be fixed to get one task through, and three were real defects
rather than anticipated work:

- `be168b4` — no path existed from a workspace file to the sandbox at all.
  `drive_read_text` truncates at 2000 characters, so the more common case ("the
  data is in the shared folder") was closed while the emailed-attachment case
  was open.
- `571bdf7` — Graph answers `/items/{id}/content` with a 302 to the tenant's
  SharePoint host and httpx does not follow redirects. GET only, and the
  platform's credential is not carried to the target.
- the netgate allowlist held `graph.microsoft.com` and not the host the bytes
  actually come from, so the agent could list a file it was authorised to read
  and never open it. `SHAREPOINT_HOST` names one tenant; `*.sharepoint.com`
  would reach every tenant on earth, which is an exfiltration route.

### Two traps that cost an hour each

**Recreating the netgate breaks inbound mail.** Its published port changes every
time (32795 → 32797 today), and `Deployment.containerName` stores the gateway URL
the mail poller dials. Nothing reconciles them. After any netgate recreate:
update that column to the new port and restart the provisioning service, or every
inbound email goes to a dead port in silence.

**`git checkout origin/main -- <paths>` without `git fetch` first applies stale
code.** It succeeds, prints nothing unusual, and deploys whatever `origin/main`
pointed at last time. Bit me once today; the netgate was rebuilt from the old
allowlist and looked like the fix had failed.

Also: the sandbox sidecar's limits are baked in at container creation, so raising
them means removing the container and calling `spawnMcpSidecars` again — done
with a one-off script against the real function rather than `docker run` by hand,
so the container matches what the code would have made. `DeploymentStatus` has no
`RUNNING`; it is `ACTIVE`.

## Operational constraints (these bite if ignored)

- SSH needs the key flag: `ssh -i ~/.ssh/hetzner root@5.161.125.216`. Plain
  `ssh root@...` fails.
- **Do not `git pull` on the VPS.** `/opt/marketplace` has a stale HEAD and a
  dirty tree. Use `git fetch origin main && git checkout origin/main -- <paths>`,
  or just run `bash hotdeploy.sh` (fetch + docker cp + restart, ~10s).
- The VPS now authenticates to GitHub with a **read-only SSH deploy key**
  (`/root/.ssh/marketplace_deploy`, pinned in `/root/.ssh/config`). The old
  embedded PAT was expired and has been deleted.
- Secrets live in `/opt/marketplace/.env.prod`; read them with
  `node --env-file=.env.prod`.
- **Re-provisioning destroys container logs and orphans pending approvals.**
  Pull logs before re-provisioning. `hotdeploy.sh` avoids this entirely.
- Restarting the container **kills in-flight runs** — never deploy mid-benchmark.
- Commit as `Sai Suram <sai.suram07@gmail.com>`. No bot author, no
  `Co-Authored-By` trailers.
- Web app is on Vercel and auto-deploys from GitHub `main`. No manual deploy.

## Where things are

| What | Where |
|---|---|
| Agent (creator code) | `agents/data-analyst/agent.py` → container `/agent/creator/agent.py` |
| Platform adapter | `apps/provisioning-service/src/templates/runtime/adapter.py` → `/agent/adapter.py` |
| Approvals UI | `apps/web/app/(auth)/dashboard/approvals/page.tsx` |
| Test suite (188) | `tests/`, CI = `.github/workflows/runtime-tests.yml` |
| Benchmark harness | `benchmark/` (untracked) and `/root/bench/` on the VPS |
| Containers | `custom-agent-cmsmc95d`, `netgate-cmsmc95d`, `mcp-python-sandbox-cmsmc95d` |
| Agent address | `data-analyst-acme-corp-az3d9btj@agents.agentstore.it.com` |
| Buyer/manager | `sai@agents.agentstore.it.com` |

## Next steps, in the agreed order

### 0. Quick: confirm Approve All works
`57f2c60` fixed it but was never verified post-deploy. Open
`https://www.agentstore.it.com/dashboard/approvals` and click Approve All.

### 1. Why did T03 and T08 produce no reply at all?
Two of sixteen benchmark tasks returned nothing. For a product promising "every
document contains what was asked for", a request that vanishes is worse than a
wrong answer — nobody knows to chase it. Logs are still on the container:

```
docker logs --since 2026-08-12T15:41:55Z custom-agent-cmsmc95d   # wave 1 (T01-T04)
docker logs --since 2026-08-12T15:45:56Z custom-agent-cmsmc95d   # wave 2 (T05-T08)
docker logs --since 2026-08-12T16:05:32Z custom-agent-cmsmc95d   # waves 3-4 (T09-T16)
```

One of the two may already be fixed by the crash fix in `f49263f` — check before
assuming two separate bugs.

### 2. File ingress (the big one)
**The agent cannot read a file anyone emails it.** Ceiling is
`_ATTACHMENT_INLINE_LIMIT = 20_000` bytes per file and
`_ATTACHMENT_INLINE_TOTAL = 60_000` total, inlined as text into the prompt.
Anything larger is written to `/data/attachments/` in the **agent** container —
and the **sandbox container has no mounts at all**, so nothing can reach it.

Sandbox MCP tools (`/app/server.py` in the sandbox container):
- `execute_python` — code only, no file parameter
- `parse_pdf` / `parse_docx` / `parse_xlsx` — each take `file_content_base64`

Those three are the hook. Output files already flow sandbox → platform as
handles with the platform holding the bytes (`_SANDBOX_FILES`,
`_register_sandbox_files`); this is the same idea in reverse. Confirmed live by
benchmark task T16: the agent correctly said it could not access an attached
`.xlsx` and asked for a re-send. Good behaviour, real limitation.

### 3. Track B — real DABstep tasks
Blocked entirely on step 2. Context files are ~24 MB total, dominated by
`payments.csv` at 23.58 MB (≈1000× the inline ceiling). Dataset:
`https://huggingface.co/datasets/adyen/DABstep`, files under `data/context`.
Published baselines: humans **62% after 3+ hours**; best agents **≤16% hard**,
~76% easy.

## Open decision, not a task

Benchmark task **T04** (messy data) passed every guard while being confidently
wrong: it reported four customer totals that were all incorrect, kept
`"Acme Corp "` and `"Acme Corp"` as separate customers while claiming it had
standardised names, and "corrected 1 negative quantity to 0" — silently altering
data rather than flagging it.

It passed because the deliverable check compares **prose against file**, and both
were consistently wrong. Every mechanism in the platform verifies internal
consistency; **none verifies correctness.** No additional check closes this.
The real options are (a) domain-specific validation for the few operations that
matter most — dedup, joins, currency parsing, key normalisation — or (b) accept
the limit and be explicit to buyers rather than implying the verification layer
catches wrongness.

Note the pattern: T04 failed on trailing whitespace in a key
(`"Acme Corp "`). The run that died on 2026-08-11 failed the same way
(`Month, North` parsing as column `" North"`). Twice now.

## Benchmark: how to re-run

Ground truth is computed by `build_tasks.py` **before** anything is sent, so
scoring can never be retrofitted. Regenerate with
`python build_tasks.py > tasks.json`.

```bash
# on the VPS, from /opt/marketplace
node --env-file=.env.prod /root/bench/send_wave.mjs T01 T02 T03 T04
node --env-file=.env.prod /root/bench/resolve.mjs list
node --env-file=.env.prod /root/bench/resolve.mjs approve <id> ...
node --env-file=.env.prod /root/bench/dump.mjs        # replies + attachments
python score2.py                                      # scores prose AND workbooks
```

Two traps found the hard way:
- `resolve.mjs` must **POST** to `/api/approve-link/...`. The link in the email
  (`/approve/action/...`) is a page — a GET returns **200 and does nothing**.
  That is a real product bug worth fixing on its own: any prefetcher or scanner
  that follows it gets a success and no effect.
- Score the **workbooks**, not just the email bodies. Task T02 scored 0/3 in
  prose and 3/3 in the file — the analysis was perfect and the reply was
  truncated mid-sentence. Prose-only scoring records that as a wrong answer, and
  Panko's error-rate baseline is about the spreadsheet anyway.

## Result of the last run (2026-08-12)

**10 pass / 4 fail / 2 no reply**, tasks returning in minutes against a human
baseline of 62% after 3+ hours (DABstep). Indicative only — these are bespoke
tasks, n=16, not DABstep items.

- Passed: both tier-3 reasoning tasks (four-hop segmentation; anomaly with a
  decoy), reconciliation, A/B significance **with no stats library available**,
  the rounded-input trap, the contradiction trap, the memory ceiling, the
  unreadable attachment.
- Failed: T04 (above), T07 seasonality (never named the December peak, no
  workbook), T11 and T12 — the unanswerable and ambiguous requests, where it fell
  through to a generic "wasn't sure how to respond" instead of naming what was
  missing.
- No reply: T03, T08.

The honesty machinery holds where it is mechanical — it would not report a
crashed run, would not invent a total for a file it could not open, caught its
own contradiction. It is weakest where honesty requires reasoning about absence.

## Fixed this session (all on main)

`c663c91` attachments carried through approval-gated runs (they were dropped
entirely; the chart was rendered and discarded), gap note no longer vouches for
the wrong side, hand-back asks which side is wrong before rebuilding, repeat
failures ask for the data's actual shape.
`f49263f` a bare ` ``` ` response no longer raises IndexError past the regex
salvage and kills the whole message.
`57f2c60` approvals actually resolve — `deploymentId` was never carried, so every
resolve hit `/api/deployments/undefined/...`; `fetch` does not reject on 404 and
an empty `catch {}` hid it.
