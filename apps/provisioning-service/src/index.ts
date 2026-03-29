import { startWorker } from "./worker.js";

console.log("[provisioning-service] Starting...");

const worker = startWorker();

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`[provisioning-service] Received ${signal}, shutting down...`);
  await worker.close();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
