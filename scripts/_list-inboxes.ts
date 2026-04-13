async function main() {
  const r = await fetch('https://api.agentmail.to/v0/inboxes', {
    headers: { Authorization: 'Bearer am_us_418452a2d1d07f40fe418274c1ac9902d162d4036426399a4eb0ca383aea2e23' }
  });
  const data = await r.json() as any;
  for (const inbox of data.inboxes || []) {
    console.log(inbox.email, '|', inbox.inbox_id);
  }
  console.log('Total:', (data.inboxes || []).length);
}
main();
