FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=4310 DATABASE_PATH=/app/data/hookledger.db
EXPOSE 4310
CMD ["node", "src/main.ts"]
