# Use the official Bun image
FROM oven/bun:1.1.27 as builder

WORKDIR /usr/src/app

# Install dependencies first
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

# Copy application source
COPY . .

# Build the OpenClaw production bundle
RUN bun run build

# Start a new runtime container
FROM oven/bun:1.1.27-slim

WORKDIR /usr/src/app

# Copy built files and production dependencies only
COPY --from=builder /usr/src/app/package.json ./
COPY --from=builder /usr/src/app/bun.lockb ./
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/assets ./assets
COPY --from=builder /usr/src/app/extensions ./extensions
COPY --from=builder /usr/src/app/node_modules ./node_modules

# Expose HTTP port (Cloud Run defaults to 8080)
ENV PORT=8080
EXPOSE 8080

# Expose the CLI binary without requiring npm global writes as non-root.
USER root
RUN ln -sf /app/openclaw.mjs /usr/local/bin/openclaw \
  && chmod 755 /app/openclaw.mjs

# Environment variables
ENV NODE_ENV=production
ENV OPENCLAW_DATA_DIR=/data

# Start OpenClaw via the cli entrypoint
CMD ["bun", "run", "dist/index.js", "gateway", "--bind", "lan"]
