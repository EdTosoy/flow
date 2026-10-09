# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /workspace
ENV NEXT_TELEMETRY_DISABLED=1 NX_DAEMON=false
ARG FLOW_IMAGE_REVISION=local
ENV FLOW_IMAGE_REVISION=$FLOW_IMAGE_REVISION
RUN npm install --global pnpm@11.27.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN node tools/build-containers.mjs
RUN pnpm exec tsc -b libs/operations-read-postgres libs/money
RUN pnpm --filter @flow/ops build

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
WORKDIR /app
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/app/rds-ca.pem
COPY --chown=node:node container/rds-ca.pem /app/rds-ca.pem
USER node

FROM base AS ops
ENV PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1 FLOW_DEPLOYMENT_MODE=demo
COPY --from=build --chown=node:node /workspace/apps/ops/.next/standalone /app
COPY --from=build --chown=node:node /workspace/apps/ops/.next/static /app/apps/ops/.next/static
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/ops/server.js"]

FROM base AS stripe
ENV STRIPE_MODE=sandbox STRIPE_INGRESS_HOST=0.0.0.0
COPY --from=build --chown=node:node /workspace/container/build/tools/ingress.cjs /workspace/container/build/tools/worker.cjs /app/tools/
EXPOSE 4242
CMD ["node", "tools/ingress.cjs"]

FROM base AS admin
ENV STRIPE_MODE=sandbox
COPY --from=build --chown=node:node /workspace/container/build/tools /app/tools
COPY --chown=node:node database/migrations /app/database/migrations
COPY --chown=node:node container/demo /app/demo
CMD ["node", "tools/provision.cjs"]
