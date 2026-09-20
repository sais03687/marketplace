// Outbound mail through Resend, exercised against the shipped module.
//
// Graph did two things for us that direct sending does not: it threaded replies
// (/messages/{id}/reply) and it put the mailbox's display name on the envelope.
// Both are now ours to get right, and both are invisible when wrong — a reply
// that starts a new thread still arrives, and so does one signed with a bare
// address. These pin them down.
import assert from "node:assert/strict";

process.env.RESEND_API_KEY = "test-key";
const { sendViaResend, resendConfigured } = await import("../apps/provisioning-service/src/clients/resend.ts");

const results = [];
function test(name, fn) {
  return fn().then(
    () => results.push(`ok   ${name}`),
    (e) => results.push(`FAIL ${name}: ${e.message}`),
  );
}

/** Capture the request Resend would receive, without making one. */
let lastRequest = null;
function stubFetch({ ok = true, status = 200, body = '{"id":"re_123"}' } = {}) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init, payload: JSON.parse(init.body) };
    return {
      ok,
      status,
      text: async () => body,
    };
  };
}

const BASE = {
  from: "agent@agents.example.net",
  to: ["buyer@example.com"],
  subject: "Re: September expenses",
  body: "<p>Here are the totals.</p>",
};

await test("the message is posted to resend with the api key", async () => {
  stubFetch();
  const r = await sendViaResend(BASE);
  assert.equal(r.ok, true);
  assert.equal(r.id, "re_123");
  assert.equal(lastRequest.url, "https://api.resend.com/emails");
  assert.equal(lastRequest.init.headers.Authorization, "Bearer test-key");
});

await test("a display name is carried so the agent writes under its own name", async () => {
  stubFetch();
  await sendViaResend({ ...BASE, fromName: "Data Analyst Test" });
  assert.equal(lastRequest.payload.from, '"Data Analyst Test" <agent@agents.example.net>');
});

await test("a name with a quote in it cannot rewrite the header", async () => {
  // The agent name is set by the buyer. A bare quote would close the
  // quoted-string early and let the rest be read as header syntax.
  stubFetch();
  await sendViaResend({ ...BASE, fromName: 'Evil" <attacker@elsewhere.test>, "x' });
  const from = lastRequest.payload.from;
  // The address must still be ours, and the name must remain a single quoted
  // string - an address inside the quotes is inert, one outside them is not.
  assert.ok(from.endsWith(" <agent@agents.example.net>"), `got: ${from}`);
  const name = from.slice(0, -" <agent@agents.example.net>".length);
  assert.ok(name.startsWith('"') && name.endsWith('"'), `name not quoted: ${name}`);
  assert.equal(name.slice(1, -1).includes('"'), false, `quote survived: ${name}`);
});

await test("a newline in the name cannot inject a header", async () => {
  stubFetch();
  await sendViaResend({ ...BASE, fromName: "Agent\r\nBcc: someone@elsewhere.test" });
  assert.ok(!/[\r\n]/.test(lastRequest.payload.from));
});

await test("no display name sends as the bare address", async () => {
  stubFetch();
  await sendViaResend(BASE);
  assert.equal(lastRequest.payload.from, "agent@agents.example.net");
});

await test("a reply carries in-reply-to so it stays in the thread", async () => {
  stubFetch();
  await sendViaResend({ ...BASE, inReplyTo: "<abc@mail.example.com>" });
  assert.equal(lastRequest.payload.headers["In-Reply-To"], "<abc@mail.example.com>");
  assert.equal(lastRequest.payload.headers["References"], "<abc@mail.example.com>");
});

await test("an existing references chain is extended, not replaced", async () => {
  stubFetch();
  await sendViaResend({
    ...BASE,
    inReplyTo: "<second@mail.example.com>",
    references: "<first@mail.example.com>",
  });
  assert.equal(
    lastRequest.payload.headers["References"],
    "<first@mail.example.com> <second@mail.example.com>",
  );
});

await test("a message that answers nothing sends no threading headers", async () => {
  // A fabricated In-Reply-To threads the message nowhere and looks forged.
  stubFetch();
  await sendViaResend(BASE);
  assert.equal(lastRequest.payload.headers, undefined);
});

await test("html and text bodies use their own field", async () => {
  stubFetch();
  await sendViaResend({ ...BASE, bodyType: "text", body: "plain words" });
  assert.equal(lastRequest.payload.text, "plain words");
  assert.equal(lastRequest.payload.html, undefined);

  stubFetch();
  await sendViaResend(BASE);
  assert.equal(lastRequest.payload.html, "<p>Here are the totals.</p>");
  assert.equal(lastRequest.payload.text, undefined);
});

await test("attachments are renamed to what resend expects", async () => {
  stubFetch();
  await sendViaResend({
    ...BASE,
    attachments: [{ name: "totals.xlsx", contentType: "application/vnd.ms-excel", content_base64: "AAA=" }],
  });
  const [a] = lastRequest.payload.attachments;
  assert.equal(a.filename, "totals.xlsx");
  assert.equal(a.content, "AAA=");
  assert.equal(a.content_type, "application/vnd.ms-excel");
});

await test("a rejection is reported rather than swallowed", async () => {
  // The caller falls back to Graph on a false, so this must not throw and must
  // not claim success - the whole point of the move is to stop reporting
  // "sent" for mail that was not.
  stubFetch({ ok: false, status: 422, body: '{"message":"domain not verified"}' });
  const r = await sendViaResend(BASE);
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.match(r.error, /not verified/);
});

await test("a network failure is reported rather than thrown", async () => {
  globalThis.fetch = async () => {
    throw new Error("socket hang up");
  };
  const r = await sendViaResend(BASE);
  assert.equal(r.ok, false);
  assert.match(r.error, /socket hang up/);
});

await test("a 2xx with an unreadable body still counts as sent", async () => {
  stubFetch({ body: "not json" });
  const r = await sendViaResend(BASE);
  assert.equal(r.ok, true);
  assert.equal(r.id, undefined);
});

assert.equal(resendConfigured(), true);

console.log(results.join("\n"));
if (results.some((r) => r.startsWith("FAIL"))) process.exit(1);
