# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev --offline --no-audit --no-fund

FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
WORKDIR /srv
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /srv/package.json ./
COPY --from=build --chown=node:node /srv/node_modules/ node_modules/
COPY --from=build --chown=node:node /srv/dist/ dist/
COPY --chown=node:node db/ db/
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
