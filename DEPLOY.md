# Deployment Guide

## Overview

| Service | Platform | Cost |
|---------|----------|------|
| Web app (Next.js) | Vercel | Free |
| Database (Postgres) | Neon | Free tier |
| Queue (Redis) | Upstash | Free tier |
| Package storage | Vercel Blob | Free tier |
| Provisioning service + agents | Hetzner CX22 | ~$5/month |

---

## Step 1 — Neon (Postgres)

1. Go to neon.tech → Create account → New project
2. Choose region closest to your users
3. Copy the **connection string** — looks like:
   `postgresql://user:password@ep-xxx.us-east-1.aws.neon.tech/neondb?sslmode=require`
4. Save it as `DATABASE_URL`

---

## Step 2 — Upstash (Redis)

1. Go to upstash.com → Create account → New Database
2. Choose **Redis**, same region as Neon
3. Enable **TLS** (required)
4. Copy the **Redis URL** — looks like:
   `rediss://default:password@xxx.upstash.io:6379`
5. Save it as `REDIS_URL`

---

## Step 3 — Clerk (Auth)

1. Go to clerk.com → Create application
2. Under **Instances**, create a **Production** instance
3. Configure your domain (e.g. `yourdomain.com`)
4. Go to **API Keys** → copy:
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
   - `CLERK_SECRET_KEY`
5. After deploying, set yourself as admin:
   - Clerk dashboard → Users → click your user → Metadata → Public
   - Set: `{ "role": "admin" }`

---

## Step 4 — Stripe

1. Go to stripe.com → Activate your account (fill in business details)
2. **API Keys** → copy live keys:
   - `STRIPE_SECRET_KEY` (starts with `sk_live_`)
   - `STRIPE_PUBLISHABLE_KEY` (starts with `pk_live_`)
3. **Webhooks** → Add endpoint:
   - URL: `https://yourdomain.com/api/webhooks/stripe`
   - Events to listen for:
     - `checkout.session.completed`
     - `invoice.paid`
     - `invoice.payment_failed`
     - `customer.subscription.deleted`
     - `account.updated`
   - Copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`
4. Generate a cron secret:
   ```bash
   openssl rand -hex 32
   ```
   Save as `CRON_SECRET`

---

## Step 5 — Vercel (Web app + Blob)

### Deploy the web app

1. Go to vercel.com → New Project → Import your Git repository
2. Set **Root Directory** to `apps/web`
3. Set **Framework** to Next.js
4. Add all environment variables from `.env.example`:
   - Everything marked as required
   - Use the values from steps 1–4 above
   - Set `NEXT_PUBLIC_APP_URL` to your production domain (e.g. `https://yourdomain.com`)
   - Set `MARKETPLACE_APPROVAL_WEBHOOK` to the same URL
5. Deploy

### Set up Vercel Blob

1. In your Vercel project → **Storage** tab → **Create Database** → **Blob**
2. Name it (e.g. `marketplace-packages`)
3. Click **Connect** — Vercel automatically adds to your project:
   - `BLOB_READ_WRITE_TOKEN`
4. Go to the Blob store → Settings → copy the **Store URL**
   - Save as `BLOB_BASE_URL` (looks like `https://abc.public.blob.vercel-storage.com`)
5. Add `BLOB_BASE_URL` to your Vercel environment variables
6. Redeploy (Vercel → Deployments → Redeploy)

### Add your domain

1. Vercel project → **Domains** → Add your domain
2. Follow DNS instructions (usually two records in your registrar)

---

## Step 6 — Hetzner VPS

### Create the server

1. Go to hetzner.com/cloud → New project → Add server
2. Choose:
   - **Location**: closest to your users
   - **Image**: Ubuntu 24.04
   - **Type**: CX22 (2 vCPU, 4GB RAM)
   - **SSH keys**: add your public key
3. Create the server — note the IP address

### Prepare your .env.prod file

Copy `.env.example` to `.env.prod` and fill in every value.
Key differences from local `.env`:
```
DATABASE_URL=<your Neon connection string>
REDIS_URL=<your Upstash rediss:// URL>
MARKETPLACE_APPROVAL_WEBHOOK=https://yourdomain.com
NEXT_PUBLIC_APP_URL=https://yourdomain.com
BLOB_READ_WRITE_TOKEN=<from Vercel Blob>
BLOB_BASE_URL=<your blob store URL>
RUNNER_MODE=local
```

### Run the setup script

```bash
# From your local machine — copies env file and runs setup
scp .env.prod root@<VPS_IP>:/root/.env.prod

ssh root@<VPS_IP>

# On the VPS:
export REPO_URL=https://github.com/you/marketplace.git
export ENV_FILE=/root/.env.prod
curl -fsSL https://raw.githubusercontent.com/you/marketplace/main/scripts/setup-vps.sh | bash
```

Or if you prefer to review first:
```bash
scp scripts/setup-vps.sh root@<VPS_IP>:/root/
ssh root@<VPS_IP>
export REPO_URL=https://github.com/you/marketplace.git
export ENV_FILE=/root/.env.prod
bash setup-vps.sh
```

---

## Step 7 — Run database migrations

On the VPS after setup:
```bash
cd /opt/marketplace
bash scripts/migrate-prod.sh --env .env.prod
```

Type `yes` when prompted. This applies all pending migrations to your Neon database.

---

## Step 8 — Smoke test

From your local machine:
```bash
APP_URL=https://yourdomain.com CRON_SECRET=your-cron-secret node scripts/smoke-test.mjs
```

All checks should pass. If any fail the output tells you exactly what is wrong.

---

## Step 9 — Verify end to end

1. Go to `https://yourdomain.com/browse` — agents should be listed
2. Sign up as a new user
3. Hire an agent — you should be redirected to Stripe Checkout
4. Complete checkout with a test card (`4242 4242 4242 4242`)
5. After payment, go to Dashboard — deployment should appear with "Activate Agent" button
6. Click Activate — intro email should arrive at your `weeklyDigestEmail` address

---

## Ongoing operations

**View provisioning logs:**
```bash
ssh root@<VPS_IP>
pm2 logs marketplace-provisioning
```

**Restart provisioning service after a code update:**
```bash
ssh root@<VPS_IP>
cd /opt/marketplace
git pull
pnpm install --frozen-lockfile
pnpm --filter provisioning-service build
pm2 restart marketplace-provisioning
```

**Check queue health:**
```bash
pm2 status
```

**Monthly payouts:**
Run automatically on the 1st of each month at 6 AM UTC via Vercel Cron.
To test manually:
```bash
curl -X POST https://yourdomain.com/api/cron/creator-payouts?dryRun=true \
  -H "Authorization: Bearer $CRON_SECRET"
```
