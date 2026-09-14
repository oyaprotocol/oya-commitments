FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf /root/.npm

COPY src/ ./src/

USER node
ENTRYPOINT ["node", "src/main.mjs"]
CMD ["/config/node.json"]
