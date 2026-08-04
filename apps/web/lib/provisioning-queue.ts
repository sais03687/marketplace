import { Queue } from "bullmq";

/**
 * The one way the web app talks to the provisioning queue.
 *
 * Every route used to build its own connection, and all but one of them built it
 * wrong — passing host and port while dropping the username, password and TLS
 * flag out of REDIS_URL. Upstash speaks rediss:// and requires a password, so
 * those connections could never authenticate and the jobs never arrived.
 *
 * It looked intermittent rather than total, which is why it survived: hiring
 * worked, because the hire route happened to pass the credentials, so the queue
 * was demonstrably functional. The fire route grew a retry and an HTTP fallback
 * to work around "the enqueue really does fail sometimes" without anyone asking
 * why it failed. Pause had neither, so pausing an agent silently did nothing —
 * the row said PAUSED and the agent kept answering mail.
 *
 * Parsed once here so a route cannot get it wrong again.
 */
let queue: Queue | null = null;

export function getProvisioningQueue(): Queue {
  if (queue) return queue;

  const raw = process.env.REDIS_URL || "redis://localhost:6379";
  const url = new URL(raw);

  queue = new Queue("provisioning", {
    connection: {
      host: url.hostname,
      port: parseInt(url.port || "6379", 10),
      username: url.username || undefined,
      // Passwords arrive percent-encoded in a URL and must be decoded, or a
      // password containing a reserved character authenticates as the wrong
      // string.
      password: url.password ? decodeURIComponent(url.password) : undefined,
      tls: url.protocol === "rediss:" ? {} : undefined,
    },
  });
  return queue;
}
