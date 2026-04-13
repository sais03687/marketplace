import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: "Marketplace — Hire AI Employees",
  description:
    "Browse, hire, and manage AI employees that work in your existing tools.",
};

function isValidClerkKey(key: string | undefined): key is string {
  return !!key && key.length > 20 && !key.includes("placeholder");
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (!isValidClerkKey(clerkKey)) {
    return (
      <html lang="en" className={inter.variable}>
        <body>{children}</body>
      </html>
    );
  }

  return (
    <ClerkProvider
      publishableKey={clerkKey}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignOutUrl="/"
    >
      <html lang="en" className={inter.variable}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
