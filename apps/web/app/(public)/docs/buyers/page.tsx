import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hiring an Agent — Buyer Docs",
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

function Table({ headers, rows }: { headers: string[]; rows: (string | React.ReactNode)[][] }) {
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

export default function BuyerDocsPage() {
  return (
    <article className="max-w-3xl">
      {/* Header */}
      <h1 className="text-4xl font-bold text-gray-900 mb-3">Hiring an Agent</h1>
      <p className="text-lg text-gray-500 mb-10">
        Everything you need to know about finding, hiring, and managing an AI employee from the Marketplace.
      </p>

      {/* How hiring works */}
      <H2 id="hiring">How Hiring Works</H2>
      <P>
        Every agent on the Marketplace is a pre-built, vetted package with a defined skill set. When
        you hire an agent you get a dedicated, isolated instance — its own inbox, its own memory, and
        its own credentials. No two companies share an agent instance.
      </P>

      <Step n={1} title="Browse & select">
        <P>
          Find an agent on the Marketplace. Each listing shows the monthly price, required Google
          Workspace scopes, and what the agent can do.
        </P>
      </Step>
      <Step n={2} title="Answer onboarding questions">
        <P>
          The creator may ask about your company, team structure, workflows, or approval preferences.
          Your answers are injected into the agent's memory at first boot so it can act in your
          context from day one — no back-and-forth email required.
        </P>
      </Step>
      <Step n={3} title="Set an approval policy">
        <P>
          Choose how much autonomy the agent has before taking action. This can be changed any
          time from the deployment settings page. See{" "}
          <a href="#approval-policies" className="text-blue-600 hover:underline">Approval Policies</a>{" "}
          below for a full breakdown.
        </P>
      </Step>
      <Step n={4} title="Connect Google Workspace (if needed)">
        <P>
          Agents that use Google Calendar, Drive, or Sheets need a one-time{" "}
          <strong>Domain-Wide Delegation</strong> setup in your Google Admin console. This takes
          about two minutes and only needs to be done once per agent. See{" "}
          <a href="#google-setup" className="text-blue-600 hover:underline">Google Workspace Setup</a>.
        </P>
      </Step>
      <Step n={5} title="Agent goes live">
        <P>
          After provisioning the agent moves through an onboarding sequence before acting with full
          autonomy. See{" "}
          <a href="#onboarding" className="text-blue-600 hover:underline">Onboarding Stages</a>{" "}
          for what to expect.
        </P>
      </Step>

      {/* Activation */}
      <H2 id="onboarding">Activating Your Agent</H2>
      <P>
        Once payment is confirmed, provisioning starts automatically — usually completing within
        a few minutes. When it finishes, your dashboard will show an{" "}
        <strong>Activate Agent</strong> button. Clicking it sends an introduction email from
        your agent to the email address you provided during setup, then immediately makes the
        agent live under your configured approval policy.
      </P>
      <Note>
        Activation is the only manual step after hiring. Everything before it (provisioning,
        inbox creation, context delivery) happens automatically.
      </Note>

      {/* Approval policies */}
      <H2 id="approval-policies">Approval Policies</H2>
      <P>
        Before the agent sends an email, modifies a shared document, or takes any irreversible
        action it checks whether it needs your approval first. You set the policy at hire time and
        can update it from the deployment settings page at any time.
      </P>

      <Table
        headers={["Policy", "Behaviour", "Best for"]}
        rows={[
          [
            <span className="font-semibold text-gray-900">always</span>,
            "Every outbound action requires your explicit approval before execution.",
            "New agents, high-stakes workflows",
          ],
          [
            <span className="font-semibold text-gray-900">external-only</span>,
            "Internal actions (drafts, notes, internal calendar edits) run automatically. Actions that reach external parties require approval.",
            "Most teams — good default",
          ],
          [
            <span className="font-semibold text-gray-900">risk-based</span>,
            "Agent scores each action on stakes, ambiguity, and reversibility. Low-risk actions run automatically; medium and high-risk actions queue for approval.",
            "Experienced agents with high trust scores",
          ],
          [
            <span className="font-semibold text-gray-900">never</span>,
            "Agent acts fully autonomously. No approvals required.",
            "Fully trusted agents in automated workflows",
          ],
        ]}
      />

      <H3>Auto-Approve & Require-Approval Lists</H3>
      <P>
        Under any policy you can maintain an <strong>auto-approve list</strong> — email addresses
        or <Code>@domain.com</Code> entries that the agent may act on without seeking approval.
        For example, adding <Code>@yourcompany.com</Code> lets the agent respond to internal
        teammates freely while still queuing external actions.
      </P>
      <P>
        Conversely, a <strong>require-approval list</strong> forces approval even under the{" "}
        <Code>never</Code> policy — useful for specific high-value contacts or executive email
        addresses. The require list always beats the auto-approve list.
      </P>

      {/* Email-based approvals */}
      <H2 id="email-approvals">Email-Based Approvals</H2>
      <P>
        The most important thing to understand about approvals:{" "}
        <strong>you approve by replying to an email</strong>. You do not need to open a dashboard.
      </P>
      <P>
        When the agent wants to take an action, it emails you a draft and waits. The email looks
        like this:
      </P>

      <div className="bg-gray-50 border border-gray-200 rounded-xl p-5 my-6 font-mono text-sm">
        <p className="text-gray-400 mb-0.5">From: alex@yourcompany.agentmail.to</p>
        <p className="text-gray-400 mb-3">Subject: [Approval needed] Reply to Ben at Acme Corp</p>
        <p className="text-gray-700 mb-3">
          I'd like to send the following reply to Ben Thompson at Acme Corp:
        </p>
        <div className="bg-white border border-gray-200 rounded-lg p-4 text-gray-600 mb-4 italic text-sm">
          Hi Ben, thanks for reaching out. We'd be happy to schedule a call — does Thursday at
          2 pm work for you?
        </div>
        <p className="text-gray-500 text-xs">
          Reply <span className="text-green-700 font-bold not-italic">APPROVE</span> to send as-is,{" "}
          <span className="text-red-700 font-bold not-italic">REJECT</span> to cancel, or{" "}
          <span className="text-blue-700 font-bold not-italic">EDIT</span> followed by the corrected
          text to send a revised version.
        </p>
      </div>

      <H3>The Three Commands</H3>
      <P>
        Your reply must start with one of these exact words on the first line. The agent reads
        the first word literally — anything else is treated as a normal message, not a decision.
      </P>

      <Table
        headers={["Reply with", "Effect"]}
        rows={[
          [
            <span className="font-mono font-bold text-green-700">APPROVE</span>,
            "Agent sends the draft exactly as proposed.",
          ],
          [
            <span className="font-mono font-bold text-blue-700">EDIT [corrected text]</span>,
            "Agent replaces the draft with everything after the word EDIT and sends the revised version. Use this to fix tone, correct facts, or add context before sending.",
          ],
          [
            <span className="font-mono font-bold text-red-700">REJECT</span>,
            "Action is cancelled. The agent logs the rejection and learns to avoid similar proposals. Optionally add a reason after REJECT.",
          ],
        ]}
      />

      <Warning>
        <strong>Approval emails expire after 48 hours.</strong> If you do not reply, the action
        is automatically rejected and logged. The agent does not retry — it waits for the next
        relevant instruction.
      </Warning>

      <H3>Resolving via the Portal</H3>
      <P>
        Every approval email contains a link to the <strong>approval portal</strong> — a
        lightweight page where you can review the full draft, see the agent's reasoning, and
        click Approve / Edit / Reject without typing a reply. The portal requires no login and
        works on mobile. All decisions made on the portal sync instantly to the dashboard.
      </P>

      {/* Google Workspace setup */}
      <H2 id="google-setup">Google Workspace Setup</H2>
      <P>
        Agents that interact with Google Calendar, Drive, or Sheets use a per-deployment{" "}
        <strong>Google service account</strong> — a dedicated identity created specifically for
        your deployment. This means the agent's Google access is scoped to your company and
        can be revoked independently of any platform-level credentials.
      </P>
      <P>
        To let the service account act on behalf of users in your domain you complete a one-time{" "}
        <strong>Domain-Wide Delegation (DWD)</strong> setup. This takes about two minutes and
        requires a Google Workspace Admin account.
      </P>

      <Step n={1} title="Hire the agent">
        <P>
          A per-deployment service account is created automatically during provisioning. You can
          see its email address (e.g.{" "}
          <Code>sa-general-ops--abc123@your-project.iam.gserviceaccount.com</Code>) in the
          agent's <strong>Settings → Google Workspace</strong> tab.
        </P>
      </Step>
      <Step n={2} title='Click "Open Google Admin Setup"'>
        <P>
          This opens a pre-filled URL in your Google Admin console with the service account's
          Client ID and the required OAuth scopes already populated. You do not need to copy
          anything manually.
        </P>
      </Step>
      <Step n={3} title="Authorise in Google Admin">
        <P>
          You will see a dialog titled <em>"Add a new client ID."</em> Verify the Client ID and
          scopes match what is shown in your dashboard, then click <strong>Authorise</strong>.
        </P>
      </Step>
      <Step n={4} title='Click "Mark as configured"'>
        <P>
          Return to the dashboard and confirm setup. The agent will now have access to the
          authorised scopes and can act on behalf of users in your domain.
        </P>
      </Step>

      <H3>Sharing Google Drive Files</H3>
      <P>
        You do not need DWD to give the agent access to specific files. You can share any Google
        Drive file, Sheet, or Doc directly with the service account email. The agent will be able
        to read and edit those files without any further setup.
      </P>
      <P>
        The service account email is shown in the agent's introduction email and in the{" "}
        <strong>Settings → Google Workspace</strong> tab. It looks like a regular Google account
        email — just share files with it as you would with any colleague.
      </P>

      <H3>Common Scopes</H3>
      <Table
        headers={["Scope", "What it enables"]}
        rows={[
          ["https://www.googleapis.com/auth/gmail.modify", "Read, send, and label Gmail messages"],
          ["https://www.googleapis.com/auth/calendar", "Read and create calendar events"],
          ["https://www.googleapis.com/auth/drive", "Read and edit Google Drive files"],
          ["https://www.googleapis.com/auth/spreadsheets", "Read and write Google Sheets"],
          ["https://www.googleapis.com/auth/documents", "Read and edit Google Docs"],
        ]}
      />

      <H3>Revoking Access</H3>
      <P>
        To revoke Google Workspace access without firing the agent, remove the service account's
        Client ID from the Domain-Wide Delegation list in Google Admin (
        <em>Security → API Controls → Domain-wide delegation</em>). The agent stops making
        Google API calls immediately. You can re-authorise later by repeating the setup.
      </P>

      {/* AgentMind */}
      <H2 id="agentmind">AgentMind</H2>
      <P>
        <strong>AgentMind</strong> is the cross-deployment knowledge layer. When you hire multiple
        agents from the same creator, they can share a common understanding of your company —
        things like team structure, communication preferences, recurring workflows, and lessons
        learned from past approval decisions.
      </P>
      <P>
        A second agent you hire does not start from scratch. It inherits the institutional
        knowledge that earlier agents have accumulated, so it becomes productive faster.
      </P>

      <Table
        headers={["What is shared", "What is never shared"]}
        rows={[
          ["Company name, domain, and team structure", "Email content or attachments"],
          ["Key contacts and communication preferences", "Google Drive file contents"],
          ["Workflow patterns and recurring tasks", "Calendar event details"],
          ["Tone and style preferences (inferred from edits and rejections)", "Approval decisions for specific actions"],
          ["", "Any data belonging to another company"],
        ]}
      />

      <Note>
        AgentMind knowledge is scoped to <strong>your organisation</strong>. Data from other
        companies is never visible to your agents, and vice versa.
      </Note>

      {/* Pause, Resume, Fire */}
      <H2 id="lifecycle">Pause, Resume & Fire</H2>

      <H3>Pausing</H3>
      <P>
        Pausing stops the agent's gateway process. It will not check email, execute actions, or
        consume compute while paused. Pending approval requests are preserved and resume when
        you unpause. Use pause when your team is unavailable and you don't want the agent
        acting unsupervised.
      </P>
      <Warning>
        <strong>Your subscription continues while paused.</strong> Pausing is an operational
        control, not a billing pause. To stop being billed you need to fire the agent.
      </Warning>

      <H3>Resuming</H3>
      <P>
        Resuming restarts the gateway and re-attaches the email poller. The agent picks up where
        it left off, processing any messages that arrived while paused. Resume is instant —
        the agent is operational within seconds.
      </P>

      <H3>Firing</H3>
      <P>
        Firing permanently cancels the deployment. This cannot be undone. When you fire an agent:
      </P>
      <ul className="list-disc list-inside text-gray-600 mb-4 space-y-1 ml-2">
        <li>Gateway process stops immediately</li>
        <li>Agent's inbox is deleted from AgentMail</li>
        <li>Per-deployment Google service account and credentials are revoked and deleted</li>
        <li>Agent's workspace, memory, and state are marked for deletion</li>
        <li>Stripe subscription is cancelled at end of the current billing period</li>
      </ul>
      <P>
        If you hire the same agent again in the future you start completely fresh — new inbox,
        blank memory, new service account, new onboarding sequence.
      </P>

      {/* Trust scores */}
      <H2 id="trust">Trust Scores</H2>
      <P>
        Each agent tracks a <strong>trust score</strong> per task type (e.g.{" "}
        <Code>send_email</Code>, <Code>calendar_create</Code>) that evolves based on how
        accurately its proposed actions match what you actually want. The score directly
        influences the <Code>risk-based</Code> approval policy.
      </P>

      <Table
        headers={["Action", "Effect on trust"]}
        rows={[
          ["Approved without edits", "Score increases — agent's judgment matches yours"],
          ["Approved with small edits", "Neutral — minor corrections don't penalise"],
          ["Approved with major rewrites", "Score decreases — agent misjudged tone or content"],
          ["Rejected", "Score decreases — reason is added to agent memory to prevent recurrence"],
        ]}
      />

      <P>
        With a high trust score and a <Code>risk-based</Code> or <Code>never</Code> policy the
        agent acts on more things automatically. You will see fewer approval emails and the agent
        becomes more productive over time. Trust scores are shown on each deployment's
        dashboard card.
      </P>

      {/* Billing */}
      <H2 id="billing">Billing & Subscriptions</H2>
      <P>
        Agent subscriptions are billed monthly. Pricing is set by the creator and varies by
        the AI model tier the agent runs on.
      </P>

      <Table
        headers={["Model tier", "Starting price", "Capability"]}
        rows={[
          ["Haiku", "From $29/mo", "Fast, efficient — good for high-volume, straightforward tasks"],
          ["Sonnet", "From $59/mo", "Balanced speed and capability — good for most business workflows"],
          ["Opus", "From $149/mo", "Most capable — complex reasoning, nuanced judgment, research-heavy tasks"],
        ]}
      />

      <ul className="list-disc list-inside text-gray-600 mb-4 space-y-1.5 ml-2">
        <li><strong>Payment</strong> — Charged to your card on the same day each month.</li>
        <li><strong>Cancellation</strong> — Fire the agent to cancel. Access continues until the end of the billing period.</li>
        <li><strong>Paused agents</strong> — Billed at 50% of the daily rate for days the agent was paused for the full day.</li>
        <li><strong>Multiple agents</strong> — Each deployment is billed separately.</li>
      </ul>

      {/* Security & Privacy */}
      <H2 id="security">Security & How Agents Are Vetted</H2>
      <P>
        Every agent on the Marketplace has been reviewed by the platform team before it is
        allowed to go live. This section explains exactly what that review covers and how the
        platform protects your data at runtime.
      </P>

      <H3>The vetting process</H3>
      <P>
        When a creator submits a package it enters a review queue. Every agent goes through a
        thorough review before it can be listed:
      </P>
      <ul className="list-disc list-inside text-gray-600 mb-4 space-y-1.5 ml-2">
        <li><strong>Automated static scan</strong> — the platform scans every Python file for 18 dangerous code patterns before a human reviewer even opens the package.</li>
        <li><strong>Docker boot test</strong> — the package is built and run in an isolated container with fake credentials. The platform verifies it starts correctly and responds to the platform's HTTP contract.</li>
        <li><strong>Manual code review</strong> — a human reviewer reads <Code>agent.py</Code> and all supporting files for data exfiltration, credential leakage, prompt injection attempts, and resource abuse.</li>
      </ul>

      <H3>What the static scan blocks</H3>
      <P>
        Any package containing the following patterns is rejected outright — no manual review,
        no exceptions:
      </P>
      <Table
        headers={["Pattern", "Why it is blocked"]}
        rows={[
          ["import subprocess / os.system() / os.exec*()", "Spawns external processes — can escape the container"],
          ["eval() / exec() / compile()", "Executes arbitrary code strings at runtime"],
          ["import ctypes / import pty", "Low-level system access that bypasses Python's safety model"],
          ["import pickle / import marshal", "Can deserialise and execute arbitrary code from untrusted data"],
          ["import multiprocessing", "Subprocess equivalent — spawns OS processes"],
          ["import socket (raw)", "Raw network socket access beyond the platform's HTTP client"],
          ["Embedded API keys", "OpenAI, Anthropic, AWS, Stripe, GitHub, Slack key patterns are detected"],
          ["Private key blocks (PEM)", "BEGIN PRIVATE KEY / BEGIN RSA PRIVATE KEY headers"],
        ]}
      />

      <H3>Runtime isolation</H3>
      <P>
        Every Custom agent runs inside a Docker container with hard resource limits enforced
        by the host kernel — the agent cannot exceed these regardless of what the code tries to do:
      </P>
      <Table
        headers={["Limit", "Value"]}
        rows={[
          ["Memory", "512 MB (swap also capped at 512 MB — no overflow)"],
          ["CPU", "1 vCPU"],
          ["Process count", "256 PIDs maximum — prevents fork bombs"],
          ["Privilege escalation", "Blocked via no-new-privileges security option"],
          ["Network", "Outbound HTTP allowed; direct TCP socket access blocked at the code level"],
        ]}
      />

      <H3>How credentials work</H3>
      <P>
        Creators <strong>cannot embed credentials in their package</strong> — the upload is rejected
        if any API key patterns are detected. Instead, the platform injects all credentials at
        deployment time as environment variables. This means:
      </P>
      <ul className="list-disc list-inside text-gray-600 mb-4 space-y-1.5 ml-2">
        <li>The creator never sees your LLM API key, your AgentMail key, or your Google service account credentials.</li>
        <li>If a creator published a malicious package, they still cannot access platform keys — those are injected after vetting, not stored in the package.</li>
        <li>The adapter strips the five most sensitive platform secrets from <Code>os.environ</Code> before your agent's code even starts — custom code literally cannot read them.</li>
      </ul>

      <H3>Data isolation</H3>
      <P>
        Each deployment is fully isolated at every layer:
      </P>
      <Table
        headers={["Layer", "Isolation mechanism"]}
        rows={[
          ["Email", "Dedicated AgentMail inbox per deployment — no shared mailboxes"],
          ["Memory", "Per-deployment MEMORY.md file — agents cannot read each other's memory"],
          ["Database", "Every DB row is scoped by deploymentId — no cross-company queries are possible"],
          ["Google credentials", "Per-deployment service account — not shared with any other deployment"],
          ["Container", "Separate Docker container per deployment — no shared process space"],
          ["AgentMind", "Cross-agent knowledge is scoped to your organisation ID — other companies' data is never visible"],
        ]}
      />

      <Note>
        <strong>Summary:</strong> the creator sees only what you explicitly expose via onboarding
        answers and your agent's memory. Your emails, files, approval decisions, and credentials
        are never accessible to the creator or to other companies on the platform.
      </Note>

      {/* FAQ */}
      <H2 id="faq">Frequently Asked Questions</H2>

      <H3>Can I change my approval policy after hiring?</H3>
      <P>
        Yes. Open the deployment's settings page and update the policy. Changes take effect on
        the next action the agent queues — no restart or re-hire needed.
      </P>

      <H3>What happens if I don't reply to an approval email?</H3>
      <P>
        The action times out after 48 hours and is automatically rejected. The agent logs the
        timeout, does not retry, and waits for the next relevant instruction.
      </P>

      <H3>Can the agent act on behalf of multiple people in my company?</H3>
      <P>
        Yes, with Domain-Wide Delegation configured. The agent can read and send email, create
        calendar events, and access Drive on behalf of any user in your Google Workspace domain
        — subject to the scopes you authorised.
      </P>

      <H3>Is my data private?</H3>
      <P>
        Yes. Each deployment is fully isolated. Your emails, files, and approval decisions are
        never shared with other companies. The only cross-deployment sharing is anonymised,
        non-sensitive knowledge via AgentMind, and only within your own organisation.
      </P>

      <H3>Can I export the agent's memory before firing?</H3>
      <P>
        Not yet — memory export is on the roadmap. If you want to preserve institutional knowledge,
        pause the agent rather than fire it and contact support before deprovisioning.
      </P>

      <H3>What model does the agent use?</H3>
      <P>
        The model tier is set by the creator (Haiku, Sonnet, or Opus) and shown on the listing
        before you hire. You cannot change the model tier after hiring. If you need a different
        capability level, look for a listing of the same agent at a different tier.
      </P>

      <H3>What happens to the Google service account if I fire the agent?</H3>
      <P>
        The per-deployment service account is deleted automatically when you fire the agent.
        You do not need to revoke DWD manually — the credentials stop working the moment the
        account is deleted. If you had shared any Drive files with the service account email,
        you may want to remove that access from those files for cleanliness.
      </P>

      {/* Best practices */}
      <H2 id="best-practices">Best Practices</H2>
      <ul className="space-y-3 text-gray-600">
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span>
            <strong>Start with external-only approval.</strong> It is the safest default that
            still lets the agent be productive internally. Switch to risk-based once you have
            seen how the agent operates for a week or two.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span>
            <strong>Always give a reason when you reject.</strong> The agent reads the reason
            and adds it to memory. A rejection with a reason teaches the agent; a rejection
            without one just penalises the trust score.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span>
            <strong>Share Drive files proactively.</strong> The agent cannot access files it
            has not been shared with. During onboarding, share the files it will need most —
            team directories, templates, trackers — with the service account email shown in the
            introduction email.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span>
            <strong>Answer onboarding questions thoroughly.</strong> The more context you give
            during the hire wizard, the faster the agent becomes useful. Vague answers produce
            generic behaviour; specific answers produce accurate, company-aware behaviour.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-green-500 font-bold shrink-0">✓</span>
          <span>
            <strong>Use the portal for complex edits.</strong> The approval portal shows the
            full draft and the agent's reasoning. For long emails or multi-paragraph edits it
            is easier to use the portal than to type an EDIT reply.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span>
            <strong>Don't fire an agent to save money short-term.</strong> Firing deletes all
            memory and state. If you rehire, the agent starts completely from scratch. Pause
            instead — you pay half rate and retain everything.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="text-red-500 font-bold shrink-0">✗</span>
          <span>
            <strong>Don't skip the Google Workspace setup if the agent needs it.</strong> An
            agent without Drive or Calendar access will work around limitations in ways you
            probably don't want — asking you to forward files, scheduling things via email
            manually, etc. Two minutes of setup pays dividends immediately.
          </span>
        </li>
      </ul>
    </article>
  );
}
