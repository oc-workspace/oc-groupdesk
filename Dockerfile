FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY . .
RUN npm run build && npm test

FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY migrations ./migrations
COPY catalog ./catalog
COPY skills ./skills
COPY integration ./integration
COPY scripts/import-model-credential.ts ./scripts/import-model-credential.ts
COPY scripts/import-model-providers.ts ./scripts/import-model-providers.ts
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3110
CMD ["npm","start"]

FROM build AS test
CMD ["npm","run","test:integration"]
