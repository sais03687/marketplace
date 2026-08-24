import { prisma } from "@/lib/db";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CreatorRequests } from "./creator-requests";

export const dynamic = "force-dynamic";

export default async function AdminCreatorsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/");

  const creators = await prisma.creator.findMany({
    where: { status: { in: ["PENDING", "DENIED"] } },
    select: {
      id: true,
      displayName: true,
      email: true,
      requestNote: true,
      status: true,
      createdAt: true,
      reviewedAt: true,
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  const requests = creators.map((c) => ({
    id: c.id,
    displayName: c.displayName,
    email: c.email,
    requestNote: c.requestNote,
    status: c.status,
    createdAt: c.createdAt.toISOString(),
    reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
  }));

  return (
    <div>
      <h1 className="text-2xl font-bold">Creator Requests</h1>
      <p className="text-muted-foreground">
        People asking for permission to publish agents. Reach out on their email, then approve or deny.
      </p>
      <div className="mt-6">
        <CreatorRequests initial={requests} />
      </div>
    </div>
  );
}
