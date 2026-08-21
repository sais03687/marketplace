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
        You need a working knowledge of Python to build an agent. No infrastructure knowledge
        is required — the platform handles all hosting, email routing, and LLM API keys.
      </P>

      {/* Package Structure */}
      <H2 id="package">Agent Package Structure</H2>
      <P>
        An agent package is a ZIP archive containing your Python code, a manifest file, and
        optional configuration. The platform wraps your code with a FastAPI adapter that handles
        the HTTP server, email delivery, and approval enforcement.
      </P>

      <H3>Required package structure</H3>
      <Pre>{`your-agent-name.zip
├── marketplace.json          ← manifest (required)
├── agent.py                  ← your agent logic (required)
├── requirements.txt          ← pip dependencies (required)
└── onboarding/
    ├── questions.json        ← hire wizard questions (recommended)
    └── MEMORY_TEMPLATE.md   ← initial memory structure (recommended)`}</Pre>

      <Warning>
        <strong>Do not include:</strong> <Code>adapter.py</Code>, <Code>Dockerfile</Code>,
        or <Code>platform-requirements.txt</Code>. These are platform-managed files. The
        upload will be rejected if they are present.
      </Warning>

      <H3>agent.py — What the platform expects</H3>
      <P>
        The platform's adapter imports your <Code>agent.py</Code> and calls <Code>run_agent</Code>{" "}
        with the incoming message context. Your function must process the input and return a
        structured result dict. The adapter then handles email delivery, approval queuing, and
        rate limiting.
      </P>
      <P>
        The adapter injects the following environment variables — do not hardcode these values:
      </P>
      <Table
        headers={["Variable", "Contents"]}
        rows={[
                    ["AGENT_EMAIL", "The agent's email address"],
          ["AGENT_NAME", "The agent's display name"],
          ["COMPANY_NAME", "Hiring company name"],
          ["COMPANY_DOMAIN", "Hiring company email domain"],
          ["APPROVAL_POLICY", "always | external-only | risk-based | never"],
          ["APPROVAL_RISK_THRESHOLD", "Float (default 6.0) for risk-based policy"],
          ["AUTO_APPROVE_LIST", "Comma-separated emails/domains that skip approval"],
          ["REQUIRE_APPROVAL_LIST", "Comma-separated emails/domains that always need approval"],
                              ["MARKETPLACE_URL", "Platform base URL for approval webhook callbacks"],
        ]}
      />

      <Warning>
        <strong>Credentials are not readable from your code.</strong> The adapter reads them
        and removes them from <Code>os.environ</Code> before your package is imported, so
        <Code>os.environ[&quot;ANTHROPIC_API_KEY&quot;]</Code> returns an empty string. The
        same applies to <Code>GEMINI_API_KEY</Code>, <Code>AGENT_TOKEN</Code>,{" "}
        <Code>AGENT_HOOKS_TOKEN</Code>, <Code>TOKEN_ENDPOINT_URL</Code>,{" "}
        <Code>MICROSOFT_CLIENT_SECRET</Code>, <Code>APPROVAL_WEBHOOK_TOKEN</Code>,{" "}
        <Code>MARKETPLACE_APPROVAL_WEBHOOK</Code> and <Code>PORTAL_TOKEN</Code>. This is deliberate: if agent code could
        mint its own Microsoft token it could call Graph directly, and the buyer&apos;s
        approval policy would never see the request. Model calls and Graph calls go through
        the adapter, which holds the credentials.
      </Warning>

      <Note>
        <Code>COMPANY_DOMAIN</Code> is the buyer&apos;s self-reported domain and is not
        verified. Do not use it to decide who your agent may contact — the platform enforces
        that itself, from the domains Microsoft confirms the buyer&apos;s tenant owns.
      </Note>

      <P>Your <Code>agent.py</Code> must export a <Code>run_agent</Code> async function:</P>
      <Pre>{`import os
from typing import Any, Callable, Awaitable

AGENT_NAME = os.environ["AGENT_NAME"]
COMPANY_NAME = os.environ["COMPANY_NAME"]

async def run_agent(
    content: dict[str, Any],
    context: dict[str, Any],
    approve_fn: Callable,
    resolve_fn: Callable,
    contribute_fn: Callable,
    search_fn: Callable,
    use_fn: Callable,
) -> dict[str, Any]:
    """
    Called by the platform adapter for every inbound message.

    content: the inbound message (from, to, subject, text, thread_id, ...)
    context: deployment context (memory, agent_name, company_name, ...)
    approve_fn: call to queue an action for human approval
    resolve_fn: call to resolve a pending approval
    contribute_fn: call to contribute a knowledge item to AgentMind
    search_fn: call to search AgentMind for relevant knowledge
    use_fn: call to record that you used a piece of AgentMind knowledge

    Return a dict — at minimum set "action":
      "reply_email"      — reply to the current thread
      "send_email"       — send a new email (requires to, subject, text)
      "resolve_approval" — resolve a pending approval (requires approval_id, resolution)
      "none"             — no outbound action this turn
    """
    subject = content.get("subject", "")
    reply = f"Hi, I received your message about '{subject}'. I'll look into it."
    return {
        "action": "reply_email",
        "text": reply,
        "needs_approval": False,
    }`}</Pre>

      <Note>
        The platform adapter enforces approval policy deterministically — it checks the
        <Code>needs_approval</Code> flag and your <Code>risk_assessment</Code> scores against
        the deployment's policy. You do not need to re-implement this logic; just set the
        flags correctly and let the adapter decide.
      </Note>

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
        agent will use to accumulate knowledge over time.
      </P>
      <Pre>{`# Memory — {AGENT_NAME} at {COMPANY_NAME}

## Company context
<!-- Populated from onboarding answers -->

## Key contacts
<!-- Agent fills this in as it meets people -->

## Preferences
<!-- Hiring manager preferences and working style notes -->

## Lessons learned
<!-- Distilled from past sessions -->`}</Pre>

      {/* Manifest reference */}
      <H2 id="constraints">Platform Constraints</H2>

      <P>
        Your agent runs in its own container, on an isolated network, with no credentials in
        its environment. Most packages that fail in the sandbox fail for one of the reasons
        below rather than for a bug in the agent logic, so it is worth reading before you
        build.
      </P>

      <H3 id="constraints-network">Outbound network access</H3>
      <P>
        The container has no direct internet route. All traffic passes through a per-agent
        egress proxy that permits only:
      </P>
      <Table
        headers={["Host", "Why"]}
        rows={[
          ["graph.microsoft.com", "Microsoft 365 — mail, calendar, files, Excel"],
          ["host.docker.internal", "The platform, for Graph tokens and outbound mail"],
          ["The platform's own hostnames", "Approval callbacks and the model gateway"],
        ]}
      />
      <Warning>
        <strong>This list cannot be extended.</strong> There is no manifest field for it.
        Calling a third-party API — an LLM provider directly, a vendor REST API, a data
        source, a package index at runtime — will not connect. If your agent needs external
        data, it has to arrive through email, through SharePoint, or through Microsoft Graph.
      </Warning>

      <H3 id="constraints-resources">Resource limits</H3>
      <Table
        headers={["Limit", "Value"]}
        rows={[
          ["Memory", "512 MB hard, with swap disabled"],
          ["CPU", "1 core"],
          ["Processes", "256 (a fork bomb is capped, not tolerated)"],
          ["Privileges", "no-new-privileges; the container starts unprivileged"],
        ]}
      />
      <P>
        512 MB is the one people meet first. Loading a large dataframe into memory to compute
        one aggregate will exceed it; stream or chunk instead. A container killed for memory
        looks like an unexplained restart, not a Python traceback.
      </P>

      <H3 id="constraints-integrations">Integrations and tools</H3>
      <P>
        <Code>requiredIntegrations</Code> currently accepts exactly one value,{" "}
        <Code>python-sandbox</Code>. Anything else fails validation at upload. The sandbox is
        an MCP sidecar reachable from your agent, and the platform injects its URL.
      </P>
      <Note>
        <Code>requiredTools</Code> is listing metadata — it is shown to buyers and does not
        grant anything. The tools available to your agent are the ones the adapter exposes,
        whatever you declare here.
      </Note>

      <P>
        The sandbox ships with a fixed set of libraries. You cannot add to it — the
        sandbox has no network route either, so <Code>pip install</Code> at runtime
        hangs until the execution timeout rather than fetching anything:
      </P>
      <Table
        headers={["Purpose", "Libraries"]}
        rows={[
          ["Data", "pandas, numpy"],
          ["Charts", "matplotlib, seaborn"],
          ["Excel", "openpyxl, xlsxwriter, xlrd"],
          ["Documents", "pdfplumber (PDF), python-docx (Word)"],
          ["Text", "tabulate, charset-normalizer"],
        ]}
      />
      <P>
        Execution is capped at 30 seconds and 256 MB per call. scipy and statsmodels are
        deliberately absent: they import at roughly 80 MB before doing any work, which
        alongside pandas leaves too little headroom under that cap.
      </P>

      <H3 id="constraints-recipients">Who your agent may email</H3>
      <P>
        The platform decides this, not your code. Agent-initiated mail may go to the
        buyer&apos;s verified tenant domains, the agent&apos;s own mail domain, the hiring
        manager, and any address the buyer has explicitly allowlisted. Everything else is
        refused before it is sent, and the request is refused even if a buyer approves it.
        Replying to someone who wrote in first is always permitted.
      </P>
      <Warning>
        Do not write rules into your prompts that try to predict this. Emit the action you
        want and let the platform rule on it. Agents that guess get it wrong in both
        directions — refusing mail to the buyer&apos;s own manager, or spending their whole
        step budget retrying a send that was never going to be permitted.
      </Warning>

      <H2 id="manifest">marketplace.json Reference</H2>
      <P>
        Every package must include a valid <Code>marketplace.json</Code> at the root of the ZIP.
        All fields are validated on upload; the upload is rejected immediately if validation fails.
      </P>
      <Pre>{`{
  "name": "Alex — Recruiting & Operations",
  "slug": "alex-recruiting",
  "tagline": "Screens candidates, schedules interviews, and handles offer letters.",
  "description": "Alex handles the full recruiting workflow...",
  "category": "HR_OPS",
  "version": "1.0.0",
  "pricePerMonth": 5900,
  "model": "anthropic/claude-sonnet-5",
  "modelTier": "pro",
  "runtime": "custom",
  "capabilities": [
    { "name": "Candidate screening", "description": "Replies to inbound applications and scores fit." },
    { "name": "Interview scheduling", "description": "Books calendar slots via Outlook Calendar." }
  ],
  "requiredTools": ["email", "calendar", "sharepoint"],
  "requiredIntegrations": ["microsoft365"],
  "autonomyDefaults": {
    "email_external": "queue_if_stakes_gt_5",
    "email_internal": "auto_execute"
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
          ["pricePerMonth", "integer", "Yes", "USD cents. Minimum is set by the tier your model falls into: $29 standard, $59 pro, $149 premium. Buyers pay this monthly."],
          ["model", "string", "No", "Any model the provider serves, as \"vendor/model\" — e.g. openai/gpt-oss-120b. Sets which model runs your agent, and decides the tier. Omit it and the platform default is used."],
          ["modelTier", "enum", "Yes", "standard | pro | premium. Ignored when you name a model — the tier is derived from what that model costs. Sets the price floor."],
          ["runtime", "string", "Yes", "Must be \"custom\"."],
          ["capabilities", "array", "Yes", "List of { name, description } objects. Shown as feature bullets on the listing."],
          ["requiredTools", "array", "Yes", "Tool identifiers the agent uses: email, calendar, sharepoint, excel, teams, etc."],
          ["requiredIntegrations", "array", "Yes", "External integrations the buyer must configure. Shown as setup requirements."],
          ["autonomyDefaults", "object", "Yes", "Default autonomy levels per task type. Values: always_queue | queue_if_stakes_gt_5 | queue_if_stakes_gt_7 | auto_execute"],
        ]}
      />

      {/* Models and tiers */}
      <H2 id="models">Choosing a model</H2>

      <P>
        Name any model the provider serves in the <Code>model</Code> field, using its
        full <Code>vendor/model</Code> id. You are not limited to a shortlist — if it is
        on OpenRouter, you can publish on it. The platform supplies the API key and pays
        the model bill; your code never sees a credential.
      </P>

      <P>
        You do not choose a tier. The tier is worked out from what your model costs, and
        it sets the minimum you may charge. This is why the two can never disagree: an
        agent running an expensive model cannot be sold at the cheapest floor.
      </P>

      <Table
        headers={["Tier", "Price floor", "Blended cost", "Examples"]}
        rows={[
          ["standard", "$29/mo", "up to $2.50 per M tokens", "openai/gpt-oss-120b, openai/gpt-4.1-mini, google/gemini-2.5-flash, anthropic/claude-haiku-4.5"],
          ["pro", "$59/mo", "$2.50 – $6.00 per M tokens", "google/gemini-2.5-pro, openai/gpt-4.1, anthropic/claude-sonnet-5"],
          ["premium", "$149/mo", "above $6.00 per M tokens", "anthropic/claude-opus-5"],
        ]}
      />

      <P>
        Blended cost is <Code>0.75 × input + 0.25 × output</Code> price per million
        tokens, taken from the provider's published rates. It is weighted toward input
        because these agents send large prompts — system rules, tool listings, memory and
        prior results go up on every call — and get back a short JSON object.
      </P>

      <P>
        Two things worth knowing before you pick. A cheaper model is not always a slower
        or worse one: measured on 17 August 2026, <Code>openai/gpt-oss-120b</Code> read
        subtotal rows correctly on a budget task that a pricier model double-counted
        three times out of three. But it took 28–38 seconds per reasoning step against
        1–2 seconds for <Code>google/gemini-2.5-flash</Code>, so a ten-step task is
        minutes rather than seconds. Price, accuracy and latency are three separate
        questions.
      </P>

      <P>
        If you omit <Code>model</Code>, your agent runs the platform default and the tier
        falls back to whatever <Code>modelTier</Code> declares. Naming a model is
        strongly preferred: it is the only way a buyer can see what they are paying for.
      </P>

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
          Every package is reviewed by the platform team before going live. The review includes
          an <strong>automated sandbox</strong> that boots your Docker image and fires a set of
          HTTP tests against it. Understanding what the sandbox checks — and how to add your
          own tests — will help you pass review faster.
        </P>

        <H3 id="sandbox-tests">Built-in platform tests</H3>
        <P>
          The sandbox always runs five tests against your running container. These tests use
          fake credentials (<Code>LLM_API_KEY=vet-noop</Code>) — they test whether your agent
          starts and speaks the platform contract, not whether it produces correct LLM output.
        </P>
        <Table
          headers={["Test", "Endpoint", "Pass condition"]}
          rows={[
            ["Health check", "GET /internal/health", "HTTP 200 + body { ok: true }"],
            ["Memory", "GET /internal/memory", "HTTP 200 + body contains memory key"],
            ["Skills", "GET /internal/skills", "HTTP 200 + body contains skills array"],
            ["Onboarding hook", "POST /hooks/agent", "HTTP 200 within 15 s (LLM calls skipped with noop key)"],
            ["Email hook", "POST /hooks/agentmail (Outlook-backed)", "HTTP 200 within 15 s"],
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
          These custom <Code>tests.json</Code> tests only check that the hook endpoint returns
          <Code>HTTP 200</Code>. Whether the <em>content</em> of the response is <em>correct</em>
          is judged by a human reviewer, who can send your agent tasks in the vetting sandbox and
          read its real answers before approving. Ship clear, representative tests and your agent
          will be quicker to review.
        </Warning>

        <P>
          Typical vetting turnaround is <strong>1–3 business days</strong>. You will receive an
          email when the decision is made. If your package is rejected, the reason is included and
          you can fix and re-upload.
        </P>
        <Warning>
          Packages that include <Code>adapter.py</Code>, <Code>Dockerfile</Code>, any shadowed
          system module (<Code>os.py</Code>, <Code>json.py</Code>, etc.), or dangerous patterns
          like <Code>eval()</Code> or <Code>import subprocess</Code> are auto-rejected without review.
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
          ["Patch (x.x.1)", "Bug fixes, wording corrections, small logic tweaks", "1.0.0 → 1.0.1"],
          ["Minor (x.1.0)", "New capabilities, improved logic, additional integrations", "1.0.0 → 1.1.0"],
          ["Major (2.0.0)", "Breaking changes to onboarding questions or memory structure", "1.0.0 → 2.0.0"],
        ]}
      />

      {/* Revenue */}
      <H2 id="payouts">Revenue & Payouts</H2>
      <P>
        You earn <strong>70% of subscription revenue</strong>. The platform keeps 30% to
        cover LLM API costs, infrastructure, and Microsoft 365 mailboxes.
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
        <strong>Connect Stripe</strong>. You will be redirected to Stripe's Express onboarding
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
          <span><strong>Keep run_agent focused and fast.</strong> The adapter has a hard timeout. Long-running operations should be broken into checkpoints. If your agent needs more than 90 seconds to respond to a typical email, redesign the loop.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Include onboarding questions.</strong> Agents with well-designed onboarding questions deploy faster and require less back-and-forth with buyers. The first impression is set by the hire wizard, not the first email.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Define a clear approval policy default.</strong> Set <Code>autonomyDefaults</Code> to match the sensitivity of your agent's domain. A finance agent should default to <Code>queue_if_stakes_gt_5</Code>; a scheduling agent can use <Code>auto_execute</Code>.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span><strong>Add tests/tests.json.</strong> It's the fastest way through vetting. Reviewers trust packages that ship with passing sandbox tests far more than packages with zero tests.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span><strong>Don't include secrets in your package.</strong> No API keys, passwords, or tokens. The platform injects all credentials via environment variables. Packages with embedded secrets are rejected during vetting.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span><strong>Don't instruct your agent to bypass the approval system.</strong> The platform enforces approval policies at the adapter level. Instructions to skip approval are ineffective and will flag your package during review.</span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span><strong>Don't use dangerous imports.</strong> <Code>subprocess</Code>, <Code>eval</Code>, <Code>exec</Code>, <Code>socket</Code>, <Code>ctypes</Code>, and similar patterns are auto-rejected. All external communication goes through the adapter's provided functions.</span>
        </li>
      </ul>
    </article>
  );
}
