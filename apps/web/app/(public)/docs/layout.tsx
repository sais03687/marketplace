import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Documentation — Marketplace",
};

const nav = [
  {
    label: "Creators",
    links: [
      { href: "/docs/creators", label: "Publishing Agents" },
      { href: "/docs/creators#runtimes", label: "Choosing a Runtime" },
      { href: "/docs/creators#openclaw-package", label: "OpenClaw Package" },
      { href: "/docs/creators#custom-package", label: "Custom Package" },
      { href: "/docs/creators#manifest", label: "marketplace.json Reference" },
      { href: "/docs/creators#upload", label: "Uploading & Vetting" },
      { href: "/docs/creators#heartbeat", label: "Heartbeat Feature" },
      { href: "/docs/creators#payouts", label: "Revenue & Payouts" },
    ],
  },
  {
    label: "Buyers",
    links: [
      { href: "/docs/buyers", label: "Hiring an Agent" },
      { href: "/docs/buyers#approval-flow", label: "Approval Flow" },
      { href: "/docs/buyers#email-approvals", label: "Email-Based Approvals" },
      { href: "/docs/buyers#google-setup", label: "Google Workspace Setup" },
      { href: "/docs/buyers#agentmind", label: "AgentMind" },
      { href: "/docs/buyers#lifecycle", label: "Pause, Resume & Fire" },
    ],
  },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-white">
      {/* Top nav */}
      <header className="border-b border-gray-200 px-6 py-4 flex items-center gap-8">
        <Link href="/" className="text-sm font-semibold text-gray-900">
          ← Marketplace
        </Link>
        <span className="text-gray-300">|</span>
        <span className="text-sm text-gray-500">Documentation</span>
        <div className="ml-auto flex gap-4">
          <Link href="/docs/creators" className="text-sm text-gray-600 hover:text-gray-900">
            For Creators
          </Link>
          <Link href="/docs/buyers" className="text-sm text-gray-600 hover:text-gray-900">
            For Buyers
          </Link>
        </div>
      </header>

      <div className="max-w-7xl mx-auto flex">
        {/* Sidebar */}
        <aside className="w-56 shrink-0 py-10 pr-6 sticky top-0 h-screen overflow-y-auto">
          {nav.map((section) => (
            <div key={section.label} className="mb-8">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                {section.label}
              </p>
              <ul className="space-y-1">
                {section.links.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-gray-600 hover:text-gray-900 block py-0.5"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </aside>

        {/* Content */}
        <main className="flex-1 py-10 pl-10 border-l border-gray-100 min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
