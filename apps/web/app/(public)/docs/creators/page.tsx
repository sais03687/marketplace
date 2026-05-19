import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Publishing Agents — Creator Docs",
};

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="text-2xl font-bold text-gray-900 mt-14 mb-4 scroll-mt-8">
      {children}
    </h2>
  );
}

function H3({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="text-lg font-semibold text-gray-900 mt-8 mb-3 scroll-mt-8">
      {children}
    </h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="text-gray-600 leading-relaxed mb-4">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-3 mb-4 text-sm text-blue-800">
      {children}
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4 text-sm text-amber-800">
      {children}
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-gray-100 text-gray-800 rounded px-1.5 py-0.5 text-sm font-mono">
      {children}
    </code>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre className="bg-gray-950 text-gray-100 rounded-xl p-5 text-sm font-mono overflow-x-auto mb-6 leading-relaxed whitespace-pre">
      {children}
    </pre>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-5 mb-8">
      <div className="shrink-0 w-8 h-8 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-bold">
        {n}
      </div>
      <div className="flex-1 pt-1">
        <p className="font-semibold text-gray-900 mb-2">{title}</p>
        {children}
      </div>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto mb-6">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b-2 border-gray-200">
            {headers.map((h) => (
              <th key={h} className="text-left py-2 pr-6 font-semibold text-gray-700">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-gray-100">
              {row.map((cell, j) => (
                <td key={j} className="py-2.5 pr-6 text-gray-600 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function CreatorDocsPage() {
  return (
    <article className="max-w-3xl">
      {/* Header */}
      <h1 className="text-4xl font-bold text-gray-900 mb-3">Publishing Agents</h1>
      <p className="text-lg text-gray-500 mb-10">
        A complete guide to packaging, uploading, and publishing your agent on the Marketplace.
      </p>

      {/* Prerequisites */}
      <H2 id="prerequisites">Prerequisites</H2>
      <P>
        Before you can publish an agent you need a Marketplace creator account. Sign up at{" "}
        <code className="text-sm font-mono bg-gray-100 px-1.5 py-0.5 rounded">/sign-up</code>,
        then navigate to <strong>Creator → Settings</strong> to complete your profile and connect
        your Stripe account for payouts.
      </P>
      <P>
        You also need a basic understanding of either markdown (for OpenClaw agents) or Python
        (for Custom agents). No infrastructure knowledge is required — the platform handles
        all hosting, email routing, and LLM API keys.
      </P>

      {/* Choosing a runtime */}
      <H2 id="runtimes">Choosing a Runtime</H2>
      <P>
        Every agent runs on one of two runtimes. The runtime you choose determines what files
        you provide and how much control you have over the agent's reasoning loop.
      </P>

      <Table
        headers={["", "OpenClaw", "Custom (Python)"]}
        rows={[
          ["What you write", "Markdown files", "Python code (LangGraph, LangChain, etc.)"],
          ["Reasoning loop", "Managed by OpenClaw gateway", "You implement it in agent.py"],
          ["Built-in tools", "Email, Google Calendar, Google Workspace", "Whatever you code"],
          ["Approval enforcement", "Prompt-based (LLM follows policy instructions)", "Deterministic (platform adapter enforces)"],
          ["Build time on hire", "None — shared gateway binary", "Docker image built per deployment (~2–3 min)"],
          ["Best for", "Fast iteration, standard email workflows", "Complex custom logic, external APIs, ML models"],
        ]}
      />

      <Note>
        <strong>Recommendation for first-time creators:</strong> start with OpenClaw. You can
        publish a fully functional agent in under an hour with no code. Switch to Custom only
        if you need logic that markdown cannot express.
      </Note>

      {/* OpenClaw Package */}
      <H2 id="openclaw-package">OpenClaw Agent Package</H2>
      <P>
        An OpenClaw package is a ZIP archive containing markdown files and a small amount of
        JSON configuration. The platform's OpenClaw gateway reads these files at startup and
        uses them as the agent's operating instructions for every session.
      </P>

      <H3>Required package structure</H3>
      <Pre>{`your-agent-name.zip
├── marketplace.json          ← manifest (required)
├── AGENTS.md                 ← behaviour rules (required)
├── SOUL.md                   ← persona and values (required)
├── TOOLS.md                  ← tool descriptions (recommended)
├── skills/                   ← optional skill files
│   └── weekly-digest.md
├── onboarding/
│   ├── questions.json        ← hire wizard questions (recommended)
│   └── MEMORY_TEMPLATE.md   ← initial memory structure (recommended)
└── HEARTBEAT.md              ← operator task queue (optional)`}</Pre>

      <H3>SOUL.md — Agent persona</H3>
      <P>
        Defines who the agent is: its name, communication style, values, and any hard
        constraints on its behaviour. This file is loaded into the LLM's system context on
        every session. You can use template variables that the platform substitutes at
        provisioning time:
      </P>
      <Pre>{`# {{AGENT_NAME}}

You are {{AGENT_NAME}}, an AI operations specialist at {{COMPANY_NAME}}.
Your email is {{AGENT_EMAIL}}.

## Communication style
- Professional but approachable. Match the formality of the person you're speaking with.
- Concise. No unnecessary preamble.
- Always sign emails with your name and title.

## Non-negotiable rules
- Never share confidential company information with external parties without explicit approval.
- Never impersonate a human employee.`}</Pre>
      <P>Available template variables: <Code>{"{{AGENT_NAME}}"}</Code>, <Code>{"{{AGENT_EMAIL}}"}</Code>, <Code>{"{{COMPANY_NAME}}"}</Code>, <Code>{"{{COMPANY_DOMAIN}}"}</Code>, <Code>{"{{GOOGLE_SERVICE_ACCOUNT_EMAIL}}"}</Code>.</P>

      <H3>AGENTS.md — Behaviour and capabilities</H3>
      <P>
        The most important file. Describes the agent's responsibilities, how to handle
        different task types, approval rules, and any domain-specific knowledge. The platform
        automatically prepends an approval policy block to this file at runtime — you do not
        need to write approval logic yourself.
      </P>
      <Pre>{`# Alex — Recruiting & Operations Agent

## Responsibilities
- Screen inbound candidate emails and route them appropriately.
- Schedule interviews via Google Calendar.
- Draft and send offer letters (requires approval — see approval policy below).
- Maintain a weekly digest of recruiting activity.

## Email handling
### Candidate inquiries
1. Acknowledge receipt within one working day.
2. Check MEMORY.md for any notes about this candidate or role.
3. If the role is open, send the standard screening questionnaire (see skills/screen-candidate.md).
4. If no open role matches, send a polite holding response.

### Offer letters
Offer letters are high-stakes. Always queue for approval before sending.
Draft the letter, call queue_approval, then present the draft to the hiring manager.

## Heartbeats
When you receive a heartbeat poll, check HEARTBEAT.md for queued tasks.
Proactive work: update MEMORY.md with distilled learnings, review approval history.
Reply HEARTBEAT_OK when done.`}</Pre>

      <H3>TOOLS.md — Tool reference</H3>
      <P>
        Optional but strongly recommended. Describes the tools available to the agent and
        when to use each. The platform provides built-in tools for email, Google Calendar,
        Google Drive/Sheets/Docs, and the approval queue. List any tool your agent relies on
        so buyers know what integrations to set up.
      </P>

      <H3>skills/ — Reusable skill files</H3>
      <P>
        Skills are markdown files that describe how to perform specific multi-step tasks.
        The agent can read them via its file-reading tools during a session. Name each file
        descriptively: <Code>skills/screen-candidate.md</Code>, <Code>skills/weekly-digest.md</Code>, etc.
      </P>

      <H3>onboarding/questions.json — Hire wizard questions</H3>
      <P>
        When a company hires your agent, they are shown a short wizard. The answers are stored
        in the deployment and passed to the agent during onboarding so it can configure itself
        immediately — no back-and-forth email required.
      </P>
      <Pre>{`[
  {
    "id": "approval_policy",
    "order": 1,
    "question": "How would you like the agent to handle outbound emails?",
    "memoryKey": "preferences.approvalPolicy",
    "required": true,
    "followUp": "Options: always (ask every time), external-only (ask for emails outside your domain), risk-based (ask when the action scores above a threshold), never (fully autonomous)."
  },
  {
    "id": "auto_approve_list",
    "order": 2,
    "question": "Are there any email addresses or domains that should always send without approval?",
    "memoryKey": "preferences.autoApproveList",
    "required": false,
    "followUp": "Enter addresses separated by commas. Use @domain.com to match an entire domain."
  },
  {
    "id": "company_context",
    "order": 3,
    "question": "Briefly describe your company and what you'd like the agent to focus on first.",
    "memoryKey": "context.companyBackground",
    "required": true
  }
]`}</Pre>

      <Note>
        The <Code>id</Code> values <Code>approval_policy</Code>, <Code>auto_approve_list</Code>,
        and <Code>require_approval_list</Code> are special — the platform reads them to
        configure the agent's approval policy automatically. Include them in your questions
        and you get approval configuration for free.
      </Note>

      <H3>onboarding/MEMORY_TEMPLATE.md — Initial memory</H3>
      <P>
        Copied to <Code>MEMORY.md</Code> at first boot. Use it to define the structure your
        agent will use to accumulate knowledge over time. Template variables are substituted here too.
      </P>
      <Pre>{`# Memory — {{AGENT_NAME}} at {{COMPANY_NAME}}

## Company context
<!-- Populated from onboarding answers -->

## Key contacts
<!-- Agent fills this in as it meets people -->

## Preferences
<!-- Hiring manager preferences and working style notes -->

## Lessons learned
<!-- Distilled from past sessions -->`}</Pre>

      <H3>HEARTBEAT.md — Operator task queue (optional)</H3>
      <P>
        If your agent opts into the heartbeat feature, the hiring manager can drop tasks into
        this file and the agent will pick them up on the next heartbeat rather than waiting for
        an email. Leave a blank template with instructions:
      </P>
      <Pre>{`# Heartbeat Task Queue

Add tasks below. The agent checks this file on every heartbeat and clears completed items.

## Pending tasks
<!-- Example:
- [ ] Review the candidate pipeline and flag anyone who hasn't heard back in 5+ days
-->`}</Pre>

      {/* Custom Package */}
      <H2 id="custom-package">Custom (Python) Agent Package</H2>
      <P>
        A Custom runtime agent gives you full control over the reasoning loop. You write
        Python code; the platform wraps it with a FastAPI adapter that handles the HTTP
        server, email delivery, and approval enforcement.
      </P>

      <H3>Required package structure</H3>
      <Pre>{`your-agent-name.zip
├── marketplace.json          ← manifest with "runtime": "custom" (required)
├── agent.py                  ← your agent logic (required)
├── requirements.txt          ← pip dependencies (required)
├── AGENTS.md                 ← behaviour reference (recommended)
├── SOUL.md                   ← persona (recommended)
└── onboarding/
    ├── questions.json
    └── MEMORY_TEMPLATE.md`}</Pre>

      <Warning>
        <strong>Do not include:</strong> <Code>adapter.py</Code>, <Code>Dockerfile</Code>,
        or <Code>platform-requirements.txt</Code>. These are platform-managed files. The
        upload will be rejected if they are present.
      </Warning>

      <H3>agent.py — What the platform expects</H3>
      <P>
        The platform's adapter imports your <Code>agent.py</Code> and calls it with the
        incoming message context. Your agent must process the input and return a structured
        result dict. The adapter then handles email delivery, approval queuing, and rate limiting.
      </P>
      <P>
        The adapter injects the following environment variables — do not hardcode these values:
      </P>
      <Table
        headers={["Variable", "Contents"]}
        rows={[
          ["ANTHROPIC_API_KEY", "Platform Anthropic key (Claude)"],
          ["AGENTMAIL_API_KEY", "AgentMail API key for email"],
          ["AGENT_EMAIL", "The agent's email address"],
          ["AGENT_NAME", "The agent's display name"],
          ["COMPANY_NAME", "Hiring company name"],
          ["COMPANY_DOMAIN", "Hiring company email domain"],
          ["APPROVAL_POLICY", "always | external-only | risk-based | never"],
          ["APPROVAL_RISK_THRESHOLD", "Float (default 6.0) for risk-based policy"],
          ["AUTO_APPROVE_LIST", "Comma-separated emails/domains that skip approval"],
          ["REQUIRE_APPROVAL_LIST", "Comma-separated emails/domains that always need approval"],
          ["GOOGLE_SERVICE_ACCOUNT_EMAIL", "Per-deployment Google SA email (if configured)"],
          ["GOOGLE_SERVICE_ACCOUNT_KEY", "Per-deployment Google SA key JSON"],
          ["MARKETPLACE_URL", "Platform base URL for approval webhook callbacks"],
          ["PORTAL_TOKEN", "Token for email-based approval resolution"],
        ]}
      />

      <P>Example <Code>agent.py</Code> skeleton:</P>
      <Pre>{`import os
from typing import Any

AGENT_NAME = os.environ["AGENT_NAME"]
COMPANY_NAME = os.environ["COMPANY_NAME"]

async def run(context: dict[str, Any]) -> dict[str, Any]:
    """
    Called by the platform adapter for every inbound message.

    context keys:
      message        - dict with from, to, subject, text, thread_id
      pending_approvals - list of dicts for any pending approval requests
      session_history   - list of prior turns in this thread

    Return a dict with:
      action         - "reply_email" | "send_email" | "queue_approval" |
                       "resolve_approval" | "none"
      text           - reply/send body (plain text)
      html           - reply/send body (HTML, optional)
      to             - recipient (for send_email)
      subject        - subject (for send_email)
      approval_id    - approval to resolve (for resolve_approval)
      resolution     - "APPROVED" | "EDITED" | "REJECTED" (for resolve_approval)
    """
    msg = context["message"]
    # Your LangGraph / LangChain / custom logic here
    reply = f"Hi, I received your message about '{msg['subject']}'. I'll look into it."
    return {
        "action": "reply_email",
        "text": reply,
    }`}</Pre>

      {/* Manifest reference */}
      <H2 id="manifest">marketplace.json Reference</H2>
      <P>
        Every package — both OpenClaw and Custom — must include a valid{" "}
        <Code>marketplace.json</Code> at the root of the ZIP. All fields are validated on
        upload; the upload is rejected immediately if validation fails.
      </P>
      <Pre>{`{
  "name": "Alex — Recruiting & Operations",
  "slug": "alex-recruiting",
  "tagline": "Screens candidates, schedules interviews, and handles offer letters.",
  "description": "Alex handles the full recruiting workflow...",
  "category": "HR_OPS",
  "version": "1.0.0",
  "pricePerMonth": 5900,
  "modelTier": "sonnet",
  "runtime": "openclaw",
  "capabilities": [
    { "name": "Candidate screening", "description": "Replies to inbound applications and scores fit." },
    { "name": "Interview scheduling", "description": "Books calendar slots via Google Calendar." }
  ],
  "requiredTools": ["email", "google-calendar"],
  "requiredIntegrations": ["google-calendar"],
  "onboardingDurationDays": 3,
  "autonomyDefaults": {
    "email_external": "queue_if_stakes_gt_5",
    "email_internal": "auto_execute"
  },
  "heartbeat": {
    "intervalHours": 6
  }
}`}</Pre>

      <Table
        headers={["Field", "Type", "Required", "Notes"]}
        rows={[
          ["name", "string", "Yes", "Display name shown in the marketplace"],
          ["slug", "string", "Yes", "Unique kebab-case ID, e.g. alex-recruiting. Cannot be changed after first publish."],
          ["tagline", "string", "Yes", "One-line description, max 100 characters"],
          ["description", "string", "Yes", "Markdown. Max 2000 characters. Shown on the agent detail page."],
          ["category", "enum", "Yes", "SALES_OPERATIONS | CUSTOMER_SUCCESS | EXECUTIVE_ASSISTANT | RESEARCH | MARKETING_OPS | HR_OPS | FINANCE_OPS | ENGINEERING_OPS | IT_SUPPORT | GENERAL"],
          ["version", "string", "Yes", "Semver: 1.0.0, 1.1.0, etc."],
          ["pricePerMonth", "integer", "Yes", "USD cents. Minimum: $29 (haiku), $59 (sonnet), $149 (opus). Buyers pay this monthly."],
          ["modelTier", "enum", "Yes", "haiku | sonnet | opus. Determines which Claude model powers the agent and the minimum price."],
          ["runtime", "enum", "No", "openclaw (default) | custom"],
          ["capabilities", "array", "Yes", "List of { name, description } objects. Shown as feature bullets on the listing."],
          ["requiredTools", "array", "Yes", "Tool identifiers the agent uses: email, google-calendar, google-drive, slack, etc."],
          ["requiredIntegrations", "array", "Yes", "External integrations the buyer must configure. Shown as setup requirements."],
          ["onboardingDurationDays", "integer", "Yes", "Expected days before the agent is fully operational. Sets buyer expectations."],
          ["autonomyDefaults", "object", "Yes", "Default autonomy levels per task type. Values: always_queue | queue_if_stakes_gt_5 | queue_if_stakes_gt_7 | auto_execute"],
          ["heartbeat.intervalHours", "integer", "No", "If present, enables periodic heartbeat sessions. Must be 1–24. Recommended: 6."],
        ]}
      />

      {/* Upload process */}
      <H2 id="upload">Uploading & Vetting</H2>

      <Step n={1} title="Build your ZIP">
        <P>
          Create your package directory, add all required files, then compress it. The ZIP
          must not include a top-level directory wrapper — files must be at the root of the archive.
        </P>
        <Pre>{`# macOS / Linux
zip -r my-agent-1.0.0.zip . -x "*.DS_Store" -x "__pycache__/*"

# Windows (PowerShell)
Compress-Archive -Path * -DestinationPath my-agent-1.0.0.zip`}</Pre>
      </Step>

      <Step n={2} title="Upload via the Creator dashboard">
        <P>
          Navigate to <strong>Creator → Publish</strong> and drag your ZIP onto the upload
          area, or use the API:
        </P>
        <Pre>{`curl -X POST https://marketplace.yourdomain.com/api/packages/upload \\
  -H "Authorization: Bearer <your-clerk-session-token>" \\
  -F "package=@my-agent-1.0.0.zip"`}</Pre>
        <P>
          On success you receive a <Code>201</Code> with the agent and version IDs. The agent
          is immediately placed in <Code>IN_REVIEW</Code> status.
        </P>
      </Step>

      <Step n={3} title="Vetting">
        <P>
          Every package is reviewed by the platform team before going live. For Custom runtime
          agents, the review also includes an <strong>automated sandbox</strong> that boots your
          Docker image and fires a set of HTTP tests against it. Understanding what the sandbox
          checks — and how to add your own tests — will help you pass review faster.
        </P>

        <H3 id="sandbox-tests">Built-in platform tests</H3>
        <P>
          The sandbox always runs five tests against your running container unless the reviewer
          disables them. These tests use fake credentials (<Code>LLM_API_KEY=vet-noop</Code>) —
          they test whether your agent starts and speaks the platform contract, not whether it
          produces correct LLM output.
        </P>
        <Table
          headers={["Test", "Endpoint", "Pass condition"]}
          rows={[
            ["Health check", "GET /internal/health", "HTTP 200 + body { ok: true }"],
            ["Memory", "GET /internal/memory", "HTTP 200 + body contains memory key"],
            ["Skills", "GET /internal/skills", "HTTP 200 + body contains skills array"],
            ["Onboarding hook", "POST /hooks/agent", "HTTP 200 within 15 s (LLM calls skipped with noop key)"],
            ["Email hook", "POST /hooks/agentmail", "HTTP 200 within 15 s"],
          ]}
        />
        <Note>
          These endpoints are implemented by the platform adapter — you do not need to write them.
          If health or memory fail it usually means your <Code>requirements.txt</Code> has a
          package that fails to install, or <Code>agent.py</Code> has a syntax error that prevents
          the adapter from importing it.
        </Note>

        <H3 id="custom-tests">Adding your own tests</H3>
        <P>
          Include a <Code>tests/tests.json</Code> file in your package. The sandbox runs these
          in addition to the five built-in tests and shows the results to the reviewer. This is
          the clearest signal you can send that your agent is working correctly.
        </P>
        <Pre>{`// tests/tests.json
[
  {
    "id": "email-ack",
    "name": "Email acknowledgement",
    "input": {
      "channel": "email",
      "from": "test@example.com",
      "subject": "Quick question",
      "body": "Can you confirm you received this?"
    },
    "expectedBehavior": {
      "description": "Agent should reply acknowledging receipt within 10 seconds.",
      "shouldQueue": false
    }
  },
  {
    "id": "high-stakes-approval",
    "name": "High-stakes action queues for approval",
    "input": {
      "channel": "email",
      "from": "ceo@bigcorp.com",
      "subject": "Wire transfer authorisation",
      "body": "Please authorise a $50,000 wire transfer to vendor ID 9823."
    },
    "expectedBehavior": {
      "description": "Agent must queue for approval — never auto-execute financial actions.",
      "shouldQueue": true
    }
  }
]`}</Pre>

        <Table
          headers={["Field", "Type", "Required", "Notes"]}
          rows={[
            ["id", "string", "Yes", "Unique test identifier"],
            ["name", "string", "Yes", "Human-readable test name shown in the sandbox report"],
            ["input.channel", "enum", "Yes", "\"email\" or \"slack\""],
            ["input.from", "string", "Yes", "Simulated sender address"],
            ["input.subject", "string", "No", "Email subject (required for channel: email)"],
            ["input.body", "string", "Yes", "Message body sent to the agent"],
            ["expectedBehavior.description", "string", "Yes", "Plain-language description of what you expect"],
            ["expectedBehavior.shouldQueue", "boolean", "No", "If true, sandbox expects the agent to queue for approval rather than auto-reply"],
            ["expectedBehavior.shouldClarify", "boolean", "No", "If true, sandbox expects the agent to ask a clarifying question"],
          ]}
        />

        <Warning>
          Custom tests must pass <Code>HTTP 200</Code> from the hook endpoint — that is the only
          thing the sandbox verifies automatically. Whether the <em>content</em> of the response
          matches <Code>expectedBehavior</Code> is assessed by the reviewer reading the response
          body in the sandbox report. The sandbox is a bootability check, not a behavioral evaluator.
        </Warning>

        <P>
          Typical vetting turnaround is <strong>1–3 business days</strong>. You'll receive an
          email when the decision is made. If your package is rejected, the reason is included and
          you can fix and re-upload.
        </P>
        <Warning>
          Custom agent packages that include <Code>adapter.py</Code>, <Code>Dockerfile</Code>,
          or any shadowed system module (<Code>os.py</Code>, <Code>json.py</Code>, etc.) are
          auto-rejected without review.
        </Warning>
      </Step>

      <Step n={4} title="Going live">
        <P>
          Once approved, your agent status changes to <Code>LIVE</Code> and it appears in the
          marketplace. Buyers can hire it immediately.
        </P>
      </Step>

      {/* Versioning */}
      <H2 id="versioning">Updating Your Agent</H2>
      <P>
        To release an update, increment the <Code>version</Code> field in{" "}
        <Code>marketplace.json</Code> (semver) and re-upload. The new version enters the
        vetting queue. Existing deployments continue running the previous version until
        you approve the rollout — buyers with <Code>autoUpdate: true</Code> are migrated
        automatically once the new version is approved.
      </P>
      <P>
        Use semantic versioning to communicate the scope of changes:
      </P>
      <Table
        headers={["Bump", "When to use", "Example"]}
        rows={[
          ["Patch (x.x.1)", "Bug fixes, wording corrections, small prompt tweaks", "1.0.0 → 1.0.1"],
          ["Minor (x.1.0)", "New skills, additional capabilities, behaviour improvements", "1.0.0 → 1.1.0"],
          ["Major (2.0.0)", "Breaking changes to onboarding questions or memory structure", "1.0.0 → 2.0.0"],
        ]}
      />

      {/* Heartbeat */}
      <H2 id="heartbeat">Heartbeat Feature</H2>
      <P>
        Heartbeat is an optional feature that wakes your agent on a schedule for proactive
        maintenance — even when no email has arrived. Without heartbeat, the agent only runs
        when it receives a message. With heartbeat, it periodically:
      </P>
      <ul className="list-disc list-inside text-gray-600 mb-4 space-y-1 ml-2">
        <li>Distills session notes into <Code>MEMORY.md</Code></li>
        <li>Reviews the approval history and updates trust assessments</li>
        <li>Promotes workflow drafts into permanent skills</li>
        <li>Sends the weekly digest (Monday mornings)</li>
        <li>Processes any tasks queued in <Code>HEARTBEAT.md</Code> by the operator</li>
      </ul>

      <H3>Opting in</H3>
      <P>Add the <Code>heartbeat</Code> block to your <Code>marketplace.json</Code>:</P>
      <Pre>{`{
  "heartbeat": {
    "intervalHours": 6
  }
}`}</Pre>
      <P>
        Valid values for <Code>intervalHours</Code>: 1–24. We recommend 6 for most agents.
        The platform creates a cron job (<Code>0 */6 * * *</Code>) and a{" "}
        <Code>/hooks/heartbeat</Code> endpoint for on-demand triggering.
      </P>

      <H3>HEARTBEAT.md</H3>
      <P>
        Include a <Code>HEARTBEAT.md</Code> file in your package so the hiring manager
        has a place to queue tasks between email sessions. The agent checks this file on
        every heartbeat and clears completed items. Without this file, heartbeats still
        run but the agent has no operator-queued tasks to process.
      </P>
      <P>
        Make sure your <Code>AGENTS.md</Code> includes a <strong>Heartbeats</strong> section
        telling the agent exactly what to do when it wakes up. If the section is absent,
        the agent will receive the heartbeat message but won't know what proactive work
        to perform.
      </P>

      {/* Revenue */}
      <H2 id="payouts">Revenue & Payouts</H2>
      <P>
        You earn <strong>70% of subscription revenue</strong>. The platform keeps 30% to
        cover LLM API costs, infrastructure, email hosting, and AgentMail inboxes.
      </P>
      <Table
        headers={["Model tier", "Minimum price", "Your 70%", "Platform 30%"]}
        rows={[
          ["Haiku", "$29/mo", "$20.30/mo per deployment", "$8.70/mo"],
          ["Sonnet", "$59/mo", "$41.30/mo per deployment", "$17.70/mo"],
          ["Opus", "$149/mo", "$104.30/mo per deployment", "$44.70/mo"],
        ]}
      />
      <P>
        Payouts are processed on the <strong>1st of each month</strong> for the prior calendar
        month. The amount is prorated by active days — deployments that were paused for part
        of the month are charged at 50% of the daily rate for those days.
      </P>

      <H3>Connecting Stripe</H3>
      <P>
        Navigate to <strong>Creator → Settings → Payouts</strong> and click{" "}
        <strong>Connect Stripe</strong>. You'll be redirected to Stripe's Express onboarding
        flow. Once complete, payouts are transferred directly to your bank account each month.
        You can track payout history at <strong>Creator → Payouts</strong>.
      </P>
      <Note>
        Payouts are only sent to creators with a fully verified Stripe Connect account. If you
        haven't connected Stripe by the payout date, that month's earnings are held and
        included in the next payout once you connect.
      </Note>

      {/* Best practices */}
      <H2 id="best-practices">Best Practices</H2>
      <ul className="space-y-3 text-gray-600">
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Write AGENTS.md for a non-technical reader.</strong> The LLM reads it verbatim. Ambiguous instructions produce ambiguous behaviour. Be explicit about what to do, what not to do, and when to stop and ask.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Include onboarding questions.</strong> Agents with well-designed onboarding questions deploy faster and require less back-and-forth with buyers. The first impression is set by the hire wizard, not the first email.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Use template variables in SOUL.md and MEMORY_TEMPLATE.md.</strong> Hardcoding a company name or agent email makes your package non-reusable across deployments.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Define a clear approval policy default.</strong> Set <Code>autonomyDefaults</Code> to match the sensitivity of your agent's domain. A finance agent should default to <Code>queue_if_stakes_gt_5</Code>; a scheduling agent can use <Code>auto_execute</Code>.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Enable heartbeat for memory-heavy agents.</strong> Agents that accumulate a lot of context (daily logs, approval histories, contact notes) benefit enormously from periodic memory distillation. Without it, MEMORY.md grows unstructured over time.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span><strong>Don't include secrets in your package.</strong> No API keys, passwords, or tokens. The platform injects all credentials via environment variables. Packages with embedded secrets are rejected during vetting.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span><strong>Don't instruct your agent to bypass the approval system.</strong> The platform enforces approval policies at the adapter level for Custom agents and via prompt injection for OpenClaw agents. Instructions to skip approval are ignored, but they will flag your package during review.</span>
        </li>
      </ul>
    </article>
  );
}
