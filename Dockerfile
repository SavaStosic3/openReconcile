FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    APP_DATA_DIR=/data \
    AUTH_MODE=password

WORKDIR /app

# The internal-server entry point uses Node's built-in HTTP and SQLite APIs.
# Hosted framework dependencies and credentials are not part of this image.
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node backend/ ./backend/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node drizzle/ ./drizzle/
COPY --chown=node:node deploy/ ./deploy/

RUN mkdir -p /data/backups && chown -R node:node /data

USER node
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "--input-type=module", "-e", "const response = await fetch('http://127.0.0.1:' + process.env.PORT + '/healthz', { signal: AbortSignal.timeout(3000) }); if (!response.ok) process.exit(1);"]

CMD ["node", "deploy/server.mjs"]
