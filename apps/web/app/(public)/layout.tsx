import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SignedIn, SignedOut, UserButton } from "@clerk/nextjs";

export default function PublicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-lg font-bold text-primary">
              Marketplace
            </Link>
            <nav className="hidden gap-4 sm:flex">
              <Link
                href="/browse"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Browse
              </Link>
              <Link
                href="/commons"
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                The Commons
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <SignedOut>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/sign-in">Sign In</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/sign-up">Get Started</Link>
              </Button>
            </SignedOut>
            <SignedIn>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/dashboard">Dashboard</Link>
              </Button>
              <UserButton />
            </SignedIn>
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t bg-muted/30 py-8">
        <div className="mx-auto max-w-7xl px-6">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <p className="text-sm text-muted-foreground">
              Marketplace. Hire AI employees that work in your existing tools.
            </p>
            <div className="flex gap-4 text-sm text-muted-foreground">
              <Link href="/browse" className="hover:text-foreground">
                Browse
              </Link>
              <Link href="/commons" className="hover:text-foreground">
                The Commons
              </Link>
              <Link href="/creator" className="hover:text-foreground">
                For Creators
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
