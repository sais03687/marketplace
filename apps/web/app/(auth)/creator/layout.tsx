"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SafeUserButton } from "@/components/auth/safe-user-button";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Upload, BarChart3, DollarSign, Settings } from "lucide-react";

const NAV_ITEMS = [
  { href: "/creator", label: "Dashboard", icon: LayoutDashboard },
  { href: "/creator/publish", label: "Publish", icon: Upload },
  { href: "/creator/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/creator/payouts", label: "Payouts", icon: DollarSign },
  { href: "/creator/settings", label: "Settings", icon: Settings },
];

export default function CreatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r bg-muted/30 lg:block">
        <div className="flex h-14 items-center border-b px-4">
          <Link href="/" className="text-lg font-bold text-primary">
            Marketplace
          </Link>
        </div>
        <div className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Creator
        </div>
        <nav className="space-y-1 px-3">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.href === "/creator"
                ? pathname === "/creator"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b px-6">
          <div className="flex items-center gap-4 lg:hidden">
            <Link href="/" className="text-lg font-bold text-primary">
              Marketplace
            </Link>
          </div>
          <div className="ml-auto">
            <SafeUserButton />
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
