FROM node:22.23.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY distribution ./distribution
COPY integration ./integration
COPY tsconfig.json vite.config.ts ./
RUN npm run build
FROM node:22.23.1-bookworm-slim AS runtime
ENV NODE_ENV=production GROUPDESK_SUMMARY_LIBRARY=generic
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY migrations ./migrations
COPY catalog ./catalog
COPY scripts ./scripts
COPY integration ./integration
COPY distribution ./distribution
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3110
CMD ["npm","start"]
