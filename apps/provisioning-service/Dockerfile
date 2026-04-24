FROM node:20-slim

# Install Docker CLI so the provisioning service can manage agent containers
RUN apt-get update && apt-get install -y \
    docker.io \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY pnpm-workspace.yaml ./
COPY package.json pnpm-lock.yaml ./
COPY packages/db/package.json ./packages/db/
COPY packages/agent-package-schema/package.json ./packages/agent-package-schema/
COPY apps/provisioning-service/package.json ./apps/provisioning-service/

RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ ./packages/
COPY apps/provisioning-service/ ./apps/provisioning-service/

# Generate Prisma client
RUN pnpm --filter @marketplace/db exec prisma generate

# Build the provisioning service
RUN pnpm --filter provisioning-service build

WORKDIR /app/apps/provisioning-service

# The Docker socket is bind-mounted at runtime: -v /var/run/docker.sock:/var/run/docker.sock
CMD ["node", "dist/index.js"]
