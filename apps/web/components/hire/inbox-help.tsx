"use client";

import { useState } from "react";
import { MailWarning } from "lucide-react";

/**
 * How to keep an email-only agent's replies out of spam.
 *
 * Every email-only agent sends from the platform's domain, which is new and has
 * little sending history, so Gmail in particular files its replies as spam even
 * though they authenticate. Found on 2026-10-10: every reply from every test
 * hire — the introduction included — landed in Gmail's Spam folder, and the
 * buyer had no way to know to look there. One rule per mailbox fixes it for
 * every agent they ever hire, because they all share the domain.
 *
 * Shown in the hire wizard and on the agent page before activation — never only
 * in the introduction email, which is itself the email most likely to be
 * filtered.
 */
export const AGENT_MAIL_DOMAIN = "agents.agentstore.it.com";

const PROVIDERS = {
  gmail: {
    label: "Gmail",
    steps: [
      <>Click the sliders icon at the right of the Gmail search bar (&ldquo;Show search options&rdquo;).</>,
      <>
        In <b>From</b>, enter <code className="font-mono">@{AGENT_MAIL_DOMAIN}</code>
      </>,
      <>Click <b>Create filter</b>.</>,
      <>Tick <b>Never send it to Spam</b>, then click <b>Create filter</b>.</>,
    ],
    note: "This covers every agent you hire, now and later.",
  },
  outlook: {
    label: "Outlook / Microsoft 365",
    steps: [
      <>Open <b>Settings</b> (the gear) → <b>Mail</b> → <b>Junk email</b>.</>,
      <>
        Under <b>Safe senders and domains</b>, click <b>Add</b> and enter{" "}
        <code className="font-mono">{AGENT_MAIL_DOMAIN}</code>
      </>,
      <>Click <b>Save</b>.</>,
    ],
    note:
      "In classic desktop Outlook: Home → Junk → Junk E-mail Options → Safe Senders → Add. " +
      "If your company filters mail centrally and replies still go missing, ask IT to allow this domain.",
  },
  other: {
    label: "Other",
    steps: [
      <>Find the agent&apos;s first email in your spam or junk folder.</>,
      <>Mark it <b>Not spam</b>, and add the sender to your contacts.</>,
      <>
        If your mail app has a safe-senders or allowed-domains list, add{" "}
        <code className="font-mono">{AGENT_MAIL_DOMAIN}</code>
      </>,
    ],
    note: "",
  },
} as const;

type Provider = keyof typeof PROVIDERS;

export function InboxHelp({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [provider, setProvider] = useState<Provider>("gmail");
  const p = PROVIDERS[provider];

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
      <div className="flex items-start gap-2">
        <MailWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-2 min-w-0">
          <p>
            <span className="font-medium">Check your spam folder for its replies.</span>{" "}
            The agent emails you from <code className="font-mono">@{AGENT_MAIL_DOMAIN}</code>, and some
            mail providers file new senders as spam. One setting stops that for every agent you hire.{" "}
            {compact && (
              <button type="button" className="underline" onClick={() => setOpen(!open)}>
                {open ? "Hide steps" : "Show me how"}
              </button>
            )}
          </p>

          {open && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1" role="tablist">
                {(Object.keys(PROVIDERS) as Provider[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={provider === key}
                    onClick={() => setProvider(key)}
                    className={`rounded px-2 py-0.5 border ${
                      provider === key ? "bg-amber-200 border-amber-300 font-medium" : "border-amber-200"
                    }`}
                  >
                    {PROVIDERS[key].label}
                  </button>
                ))}
              </div>
              <ol className="list-decimal pl-4 space-y-1">
                {p.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
              {p.note && <p className="text-amber-800">{p.note}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
