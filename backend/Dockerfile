# Build from the repository root: docker build -f backend/Dockerfile .
FROM node:24.21.0-bookworm-slim AS dependencies
WORKDIR /app/backend
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app/backend
COPY --from=dependencies /app/backend/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY backend/src ./src
COPY shared /app/shared
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
