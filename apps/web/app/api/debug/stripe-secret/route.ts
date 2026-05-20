import { NextResponse } from "next/server";

// Temporary debug endpoint — DELETE after confirming webhook secret
export async function GET() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
  return NextResponse.json({
    prefix: secret.slice(0, 14),
    length: secret.length,
  });
}
