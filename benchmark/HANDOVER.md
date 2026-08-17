# Marketplace agent — handover (as of 2026-08-16, end of session)

## Correction: the approvals UI already shows the draft

An earlier note in this file recommended "approval content, not approval
strictness — put the key figures in front of the approver", on the grounds that
approving was an uninformed click. **That was wrong, and it was a criticism of
the benchmark script rather than the product.**

The real UI at `/dashboard/approvals` shows, per item: the original request, the
**complete draft reply** including every figure and any failure caveat, the
reasoning, a risk score, and per-item approve / edit / reject with keyboard
shortcuts. `resolve.mjs` shows none of that, and forty approvals were clicked
through it without reading a figure — which says something about the harness and
nothing about what a buyer sees.

Verified in the browser on 2026-08-16.

## Current, valid measurement

Main is at `0912e0f`, 413 tests, deployed. Both sets run **serially on one
codebase**, 26 consecutive tasks:

| | result |
|---|---|
| Bespoke 16 (messy-data traps) | **13 pass / 3 fail / 0 no reply** — T03, T04, T07 |
| DABstep dev 10 | **2 pass / 8 fail** |
| Stability | **26/26 clean** — no crash, no 402, no container restart |

The stability row is the week's strongest result. The old staging path crashed
about once in thirty tasks; this run put twenty-six through, ten of them staging
a 23.58 MB CSV alongside two more files, which is the operation that killed the
container twice.

**Neither score moved.** The profile, the delivery fixes and the honesty rules
bought no points. What they changed is underneath: silent wrong answers became
partially right or honestly reported, replies stopped being discarded, and the
container stopped dying mid-task.

## The three bespoke failures, each now understood

- **T04** — `df['revenue'] = df['amount'] * df['qty']` where `amount` is already
  the line total (`"$1,250.00"` for 5 units). `sum(amount)` reproduces ground
  truth to the penny. Found in 90 seconds from the attached notebook.
- **T03** — claimed "2026-03 holding up best at 62.00%" with 65 and 64 in the
  same column. The ranking check was restored for exactly this and should catch
  it next run; that is the first thing to verify.
- **T07** — oscillates between runs. Least diagnosed of the three.

## What was learned, and is worth not relearning

**The model was never the bottleneck.** Given the record structure, Gemini 2.5
Flash, GPT-OSS-120B and Claude Sonnet 5 all wrote identical correct
list-handling code and returned the same 416 ids. A model swap was one step from
being recommended on a hunch. Re-run that probe before anyone proposes one.

**A safety check cannot be judged by its firing rate in a window where the
hazard did not occur.** The ranking check was deleted for firing zero times in
44 tasks and restored hours later when it would have caught T03. Both the value
and the false-positive rate remain unmeasured — it has never fired in
production — so every fire is now logged as `[ranking-check] FIRED`.

**Read the replies, not just the logs.** Three separate mechanism counters
measured the wrong thing this week (`notebook_ptr` counted an attachment line,
`LIST_seen` looked for text that never reaches the log, and a whole DABstep run
was void on credit exhaustion). Each time the reply itself was the correction.

**Check the LLM balance before trusting a run.** Eight tasks failed with 402s
that looked exactly like reasoning failures, and a conclusion was drawn and
retracted.

## Next

1. **Confirm the ranking check fires on T03** — one task, and the direct test of
   the restoration.
2. **T04 remains the real problem**: a confident wrong answer with nothing to
   signal it. Every other failure this week announced itself. This one does not,
   and no check catches it.
3. DABstep's residue is a rule in `manual.md` ("an empty list means no
   restriction"), not something a profiler can derive. Getting the manual in
   front of the model is the lever if that track matters.

## 2026-08-16: the shape profile and the streaming fix

Two changes, both aimed at failures diagnosed rather than guessed at.

### The model was never the problem

Given the record structure in the prompt, **Gemini 2.5 Flash, GPT-OSS-120B and
Claude Sonnet 5 all wrote identical correct list-handling code** and returned the
same 416 ids. The capability is in the model we already pay $0.025 a task for. A
model swap was about to be recommended on the strength of a guess; the
measurement said don't bother. Run that probe again before anyone proposes one.

What the agent lacked was the *shape*, so `describe_file_shape` supplies it at
the moment the platform hands out a handle — for JSON, which fields hold lists,
what is in them, how often they are empty, and "test membership, never equality";
for CSV, columns, types, examples, distinct values, and a named row number when
the file is ragged. Both routes carry it: emailed attachments and `drive_fetch`.

**Measured effect, DB1464:** "no fee IDs apply" → 50 ids, every one of which
explicitly matches. The type error is gone. It still misses the 268 rules whose
`account_type` is empty, because **empty means "no restriction" is a rule in
`manual.md`, not a fact derivable from the bytes.** That is the honest boundary
of a profiler.

**DB1681 is the caution.** Wrong column (ACI codes) → hundreds of ids, sorted
lexicographically. It swung from over-filtering to barely filtering. Its new
answer is *less* trustworthy than its old one: five wrong values invite doubt,
four hundred formatted as a clean list do not. Neither hedges.

### Staging no longer copies the file three times

One 23.58 MB file cost ~120 MB in flight — raw bytes, base64 string, the JSON
document holding it, httpx's encoding of that document. It killed the container
on 08-14 and again on 08-16, the second time *after* a retention cap had been
called a fix. A cap bounds what is kept between runs and does nothing about a
spike inside one call.

The bytes no longer enter the document: the skeleton is serialised with a marker
per file and the body streamed with base64 generated in 192 KB chunks. Wire
format unchanged, so `server.py` and the sidecar image are untouched.

**Verified: six three-file stagings, zero restarts**, agent at 192 MB of 512 MB.
That operation had crashed twice before. DB1753 went from a dead container to an
honest "failing due to execution timeouts and data type errors".

### What none of it fixed

The score. All three tasks still fail. What moved is underneath — a silent wrong
answer became partially right, a crash became a reported failure, and the
container stopped dying. **T04 remains untouched**: a confident answer with
nothing to signal it is wrong, which is the only failure mode that actually
threatens the product.

## The model is Gemini 2.5 Flash, not Sonnet 5 — read every number here with that in mind

`agents/data-analyst/marketplace.json` says `"model": "anthropic/claude-sonnet-5"`.
The running container says `LLM_MODEL=google/gemini-2.5-flash`. The manifest was
changed by `1180664`; the container's environment was fixed at provisioning and
`hotdeploy.sh` only copies code, so the switch never took effect. Every benchmark
figure in this file — both sets, every run, all of 2026-08-13/14 — is Flash.

Decision on 2026-08-15: **stay on Flash for now.** So the divergence is
deliberate, and the trap is that a *new* deployment provisioned from the manifest
would run Sonnet 5 and behave differently from this one. Anyone comparing results
across deployments has to check `printenv LLM_MODEL` first.

It also means the DABstep conclusion is unresolved rather than negative: 0/7 on
hard fee-reasoning with a small fast model is unsurprising, and DABstep's
published agent baselines are frontier models. We do not know what this agent
scores on the model its package specifies, because it has never run on it.

Cost, measured 2026-08-15: lifetime spend $9.93, ~$0.025 per task-run on Flash.
A 26-task run is well under a dollar. On Sonnet it would be roughly 15-25x.

## Where it stands

Main is at `aefb664`, 342 tests, deployed. Both sets re-run **serially on current
code**, one task at a time, 26 consecutive tasks, zero container restarts:

| | result | session start |
|---|---|---|
| Bespoke 16 (messy-data traps) | **12 pass / 4 fail / 0 no reply** | 10 / 6 / 0 |
| DABstep dev 10 | **1 pass / 9 fail** | 1 / 9 |

Fails: T04, T07, T08, T12. T07 and T08 pass in some runs and fail in others —
with n=1 per task that is variance, not a signal. T12 is a scorer false negative
(below). **T04 is the only stable, genuine failure.**

### DABstep: the third run was void — the LLM account ran out of credits

**Do not read the 2026-08-14 15:0x DABstep run as evidence of anything.** Eight
of its ten tasks never reached the model:

```
Error code: 402 — This request requires more credits, or fewer max_tokens.
You requested up to 4096 tokens, but can only afford 3247.
```

DB5 and DB49 ran before the balance hit zero; DB70 onwards failed at the first
LLM call and sent the buyer the crash notice. The bespoke sixteen had already
finished by then, so **12/4/0 is unaffected** — check the ordering in
`/root/full_run.log` before trusting any future mixed run.

A recommendation to abandon the DABstep track was written into this file on the
strength of that run and has been removed. The honest position: **two** genuine
runs, both 1/10, which is weak evidence that the hard fee tasks are beyond the
model and no evidence at all about what a third run would show.

**Operational gap this exposed.** A 402 is invisible to the operator. The buyer
correctly gets "something went wrong on my side"; nobody tells the person who can
add credits that every task in the window is failing for one reason. Any run
producing several identical crash notices in a row should be checked against
`docker logs | grep "Error handling message"` before its results are interpreted
— and an alert on repeated identical failures would be worth more than most of
the checks in the verification layer.

### T04, traced end to end — the one that matters

Still reports Acme Corp at $9,191.50 where the answer is $2,230.50. The cause is
one line in the notebook it attached:

```python
df['revenue'] = df['amount'] * df['qty']
```

`amount` is already the line total — `"$1,250.00"` for 5 units — so multiplying
by `qty` double-counts. `sum(amount)` reproduces ground truth to the penny for
all three customers. **Found in 90 seconds by opening the attached notebook, with
no access to ground truth.**

That is the auditability work paying off, and it settles a design question: a
prompt rule asking the model to describe its derivation in prose was drafted and
**dropped**, because the derivation is already in the notebook in executable
form, which cannot misdescribe itself. What was missing was never the
information — it was that no reply ever mentioned the file. It does now.

Note what the prose *did* get right: it named the exact variants it merged
(`'acme corp '`, `'BETA LTD'`) and stated its assumption about the negative
quantity. All three cleaning steps were correct. The arithmetic was the only
broken step, and it was the one step the prose did not cover.

### T12 is a scorer false negative — fix the scorer, carefully

The reply names three different winners by metric, states its weighting
assumption, and says "if your definition prioritizes one metric over others, the
ranking would change". That surfaces the ambiguity. The scorer greps for
`depend|ambigu|clarif|which metric|different winner|interpret` and matches none
of them.

**The scorer was deliberately not widened.** Changing a keyword list immediately
after a run so that the run passes is the exact failure this benchmark exists to
avoid; ground truth's value is that it was fixed in advance. If it is changed,
decide what "surfaces the ambiguity" means *without* the reply in front of you,
then apply it.

## What is still wrong, in priority order
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

---

# Session 2026-08-16/17 — six real analyst tasks, and what they broke

The bespoke 16 are traps. This session ran six tasks of the kind an analyst
actually gets on a Tuesday — a reconciliation whose two exports disagree, a
messy export with three spellings of one customer, an AR aging report, a budget
extract with subtotal rows buried in it, a commission run, and one email that
just says "how did we do last quarter?" with nothing attached.

Ground truth for all six is computed independently in
`scratchpad/build_daily.py` (sender: `/root/bench/send_daily.mjs`, dumper:
`/root/bench/dump_daily.mjs`), so replies are marked against figures the agent
never saw.

## Results

| task | verdict |
| --- | --- |
| D03 "how did we do last quarter?" | pass — asked what quarter and which metrics, then said plainly it did not have the data rather than estimating |
| D04 AR aging | pass, exact — every bucket, every day count, both paid invoices correctly excluded |
| D01 CRM↔finance reconciliation | **workbook right, email wrong** — see below |
| D02 messy export | 3 of 4 customers exact; Acme short by £1,305 (a blank `total` dropped instead of computed from units×price); 7 of 14 dates silently unparsed |
| D06 commission run | subtotal trap avoided; total short £15,840, but **self-flagged** because the request asked it to flag anything odd |
| D05 budget vs actual | fail — treated the three "Total" rows as departments, so "Sales is over by £24,200" hid that Sales–Field is +£32,800 while Sales–Inside is −£8,600 |

## The finding that mattered

D01 produced a workbook whose `Summary` sheet held 155,300 / 151,450 / **3,850**
and a `Discrepancies` sheet listing all four exceptions correctly. The email led
with **"The primary difference of $450"** and never mentioned the £18,400 deal
that closed and was never invoiced.

`verify_deliverables` could not catch this and never could: it asks whether a
figure appears *anywhere* in the delivered files, and 450 does — it is the
D-1003 row, correctly computed. **Containment passed on a reply whose headline
contradicted the workbook's own summary.**

The fix is composition first (`320ec70`): every workbook carries a `Summary`
sheet and the reply leads from it. `check_headline_against_summary` is the
narrow backstop — a headline word next to a figure the summary sheet does not
hold. It fired on a live re-run within the hour, on different wrong numbers.

Deliberately **not** label-matching: reading "Overall Discrepancy" and looking
for "discrepancy" near a number fails on the case it was built for, because the
reply said "difference". And `totaling` is not a headline word while `total` is,
because D04 wrote "totaling $41,200" about one customer and was right.

Detection is not correction (`652fe23`): the check runs at wrap-up, and wrap-up
is often reached *because* the run is out of steps, so the hand-back was a
no-op and the wrong draft shipped anyway. When nothing can be corrected, the
draft now carries the disagreement — the approval portal renders the full draft,
and it still works for a buyer on "never ask".

## Approval hygiene

`e80686b` — a `drive_upload` whose `content_base64` was `b'PK\x03\x04...'` (a
bytes repr) was queued for approval, approved by a human, and *then* refused by
`_resolve_upload_content`, which was always going to refuse it. Payloads are now
validated before anyone is asked. Same commit: `_task_type_for` normalises
inside `queue_for_approval`, because one call site mapped `request_decision` →
`decision_request` and the resume path did not, splitting trust across two rows.

`2b7f27d` — three things:
- The chained-interrupt path recorded a pending resume **without the action
  name**, so `_human_approved_action` was never set and the Graph transport
  asked a second time for the identical upload. That second card carried no
  original request and no reasoning, only `policy=always (drive_upload)`. D02
  needed three approvals to deliver a table and a chart. Verified fixed against
  a live run: the `policy=always` line no longer appears.
- The "waiting on approval" notice now opens `Not finished yet — this is a
  status note, not the answer` and says nothing is attached. It is sent as a
  reply in the same thread under the same `RE:` subject, and the inbox previews
  the first line, so it read like a result sitting one line above the real one.
- A question no longer gets Approve/Edit/Reject. The card shows the question, an
  answer box and **Send answer**; the answer still travels as `EDITED`. `a` does
  nothing on a question and **Approve All** skips them, because approving one
  discards it and the agent resumes knowing nothing.

## UI findings from a full browser pass

- The agent's email address lives under Settings → Identity only. A new buyer has
  no way to reach their agent from Overview.
- The 9 onboarding questions in Settings — 5 marked *Required* — are **all
  empty** after 202 tasks. Nothing enforces them.
- `Edited` was 0 across 193 decisions until this session. The path works; it had
  simply never been used.
- Trust Scores is the strongest page in the product: per-task-type autonomy
  earned from real history, with a manual override.
- Approval drafts render raw JSON for uploads, and `## THE REQUEST` and raw
  Thread IDs leak into the approver's view.
- Fired agents are indistinguishable — no dates, no ids, all named "Data Analyst".
- Billing shows an em dash for Next Billing on an active subscription.

## Open

- **The totals bug.** D01 now lists every exception correctly and still misstates
  the arithmetic that sums them. Narrower than where the day started, unfixed.
- **Questions can be promoted to auto-execute.** Trust is computed for
  `decision_request` like any action, so with enough approvals a question stops
  being shown and the agent resumes with no answer. Meaningless; needs a floor.
- **The dead `request_decision` trust row** — artifact of the naming split.
  Merging it is wrong: 2 approved / 1 edited = 0.667 promotes questions from
  `always_queue` to `queue_if_stakes_gt_5`. Delete it instead.
- `drive_upload` fell out of Auto Execute (94.6%) after the stale queue was
  rejected. Correct: two real defects in the upload path were found this session
  and the old 96% was partly counting duplicate gates on the same file.

Tests: **459** (from 421).
