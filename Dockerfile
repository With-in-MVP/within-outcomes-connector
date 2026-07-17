FROM node:22-slim
WORKDIR /app
COPY src/ ./src/
USER node
ENTRYPOINT ["node", "src/bridge.mjs"]
