ARG BUILD_IMAGE
ARG RUNTIME_IMAGE
FROM ${BUILD_IMAGE} AS build
WORKDIR /app
RUN cp package-lock.json /tmp/onboarding-build-lock.json
COPY . .
RUN cmp package-lock.json /tmp/onboarding-build-lock.json && npm run build && npm test
FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=build --chown=node:node /app/dist /app/dist
COPY --chown=node:node server /app/server
COPY --chown=node:node shared /app/shared
COPY --chown=node:node migrations /app/migrations
COPY --chown=node:node integration /app/integration
COPY --chown=node:node skills /app/skills
COPY --chown=node:node catalog /app/catalog
COPY --chown=node:node scripts /app/scripts
COPY --chown=node:node package.json /app/package.json
