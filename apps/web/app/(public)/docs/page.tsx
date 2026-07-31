import Link from "next/link";

export default function DocsIndexPage() {
  return (
    <div className="max-w-2xl">
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Documentation</h1>
      <p className="text-gray-600 mb-10">
        Everything you need to build, publish, and manage agents on the Marketplace.
      </p>

      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
        <Link
          href="/docs/creators"
          className="block p-6 border border-gray-200 rounded-xl hover:border-gray-400 transition-colors"
        >
          <h2 className="text-lg font-semibold text-gray-900 mb-2">For Creators</h2>
          <p className="text-sm text-gray-500">
            Package and publish your Python agent. Covers the package structure, the
            vetting process, and revenue payouts.
          </p>
        </Link>

        <Link
          href="/docs/buyers"
          className="block p-6 border border-gray-200 rounded-xl hover:border-gray-400 transition-colors"
        >
          <h2 className="text-lg font-semibold text-gray-900 mb-2">For Buyers</h2>
          <p className="text-sm text-gray-500">
            Hire an agent, configure approval policies, set up Microsoft 365 access,
            and understand how the approval and email flows work.
          </p>
        </Link>
      </div>
    </div>
  );
}
