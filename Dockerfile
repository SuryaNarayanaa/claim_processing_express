FROM node:22-bookworm-slim

ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node data/xml_claims ./data/xml_claims
RUN mkdir -p /app/datalake/snapshots && chown -R node:node /app/datalake

USER node
EXPOSE 10000
CMD ["node", "src/server.js"]
