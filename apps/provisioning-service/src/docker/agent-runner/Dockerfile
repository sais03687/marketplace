FROM node:22-slim

RUN apt-get update && apt-get install -y curl jq sed && rm -rf /var/lib/apt/lists/*

# Install openclaw globally
RUN npm install -g openclaw@latest

# Create working directories
RUN mkdir -p /agent/workspace /agent/internal-api /data

# Copy internal API
COPY internal-api/ /agent/internal-api/

# Copy startup script
COPY startup.sh /agent/startup.sh
RUN chmod +x /agent/startup.sh

# Copy agent package (injected at build time or mount)
COPY agent-package/ /agent/workspace/

# Install internal API deps
WORKDIR /agent/internal-api
RUN npm install

WORKDIR /agent

EXPOSE 4000

CMD ["./startup.sh"]
