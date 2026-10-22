FROM node:24-bookworm-slim AS build
WORKDIR /app
# Generate and review package-lock.json locally before building this image.
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
COPY db ./db
COPY clients ./clients
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/db ./dist/db
# dist/src/capture imports ../../clients/hooks/*.mjs, which tsc does not emit.
COPY --from=build --chown=node:node /app/clients/hooks ./dist/clients/hooks
USER node
EXPOSE 8787
CMD ["node", "dist/src/server.js"]
