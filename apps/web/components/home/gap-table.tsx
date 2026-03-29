import { Check, X, Minus } from "lucide-react";

const features = [
  {
    name: "Works in existing tools (email, Slack)",
    marketplace: true,
    chatbots: false,
    copilots: "partial",
  },
  {
    name: "Human-in-the-loop approval",
    marketplace: true,
    chatbots: false,
    copilots: "partial",
  },
  {
    name: "Trust score + earned autonomy",
    marketplace: true,
    chatbots: false,
    copilots: false,
  },
  {
    name: "No new interface to learn",
    marketplace: true,
    chatbots: false,
    copilots: "partial",
  },
  {
    name: "Works while you're away",
    marketplace: true,
    chatbots: false,
    copilots: false,
  },
  {
    name: "Onboarding that learns your org",
    marketplace: true,
    chatbots: false,
    copilots: false,
  },
];

function StatusIcon({ value }: { value: boolean | string }) {
  if (value === true)
    return <Check className="h-4 w-4 text-emerald-600" />;
  if (value === false)
    return <X className="h-4 w-4 text-red-400" />;
  return <Minus className="h-4 w-4 text-amber-500" />;
}

export function GapTable() {
  return (
    <section className="bg-muted/50 px-6 py-20 lg:px-8">
      <div className="mx-auto max-w-4xl">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          Not a Chatbot. Not a Copilot.
        </h2>
        <p className="mt-3 text-center text-muted-foreground">
          AI employees are a fundamentally different category.
        </p>
        <div className="mt-10 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="pb-3 text-left font-medium">Feature</th>
                <th className="pb-3 text-center font-medium text-primary">
                  AI Employees
                </th>
                <th className="pb-3 text-center font-medium text-muted-foreground">
                  Chatbots
                </th>
                <th className="pb-3 text-center font-medium text-muted-foreground">
                  Copilots
                </th>
              </tr>
            </thead>
            <tbody>
              {features.map((f) => (
                <tr key={f.name} className="border-b last:border-0">
                  <td className="py-3 pr-4">{f.name}</td>
                  <td className="py-3 text-center">
                    <div className="flex justify-center">
                      <StatusIcon value={f.marketplace} />
                    </div>
                  </td>
                  <td className="py-3 text-center">
                    <div className="flex justify-center">
                      <StatusIcon value={f.chatbots} />
                    </div>
                  </td>
                  <td className="py-3 text-center">
                    <div className="flex justify-center">
                      <StatusIcon value={f.copilots} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
