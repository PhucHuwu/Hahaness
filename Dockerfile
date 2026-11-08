# syntax=docker/dockerfile:1

# Stage 1: build the web UI (ui/dist) with all dev dependencies.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY ui ./ui
RUN npm run ui:build

# Stage 2: runtime. Node for the server, bash + python3 for the `bash` tool.
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates tzdata python3 python3-pip python3-pandas python3-openpyxl \
  && rm -rf /var/lib/apt/lists/* \
  # Debian blocks `pip install` outside a venv (PEP 668). Agents install extra packages with
  # `pip install --user`, which lands in the workspace volume because HOME points there.
  && printf '[global]\nbreak-system-packages = true\n' > /etc/pip.conf \
  && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node catalog.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node examples ./examples
COPY --from=build --chown=node:node /app/ui/dist ./ui/dist

ENV HOST=0.0.0.0 \
    PORT=7331 \
    HAHANESS_DB=/data/hahaness.db
VOLUME /data
EXPOSE 7331
USER node

# /api/auth is the only GET that answers without a login session.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/auth').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server/index.ts"]
