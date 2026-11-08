# syntax=docker/dockerfile:1
# Vendor-side MCP gateway (docs/architecture/22-gateway.md). Build from the repository root:
#   docker build -f gateway/Dockerfile -t hahaness-gateway .
FROM node:22-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node src ./src
COPY --chown=node:node gateway/upstreams.json ./gateway/upstreams.json

ENV HOST=0.0.0.0 \
    PORT=7332 \
    GATEWAY_UPSTREAMS=/app/gateway/upstreams.json
EXPOSE 7332
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/gateway/index.ts"]
