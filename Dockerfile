FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src/ ./src/
COPY certs/ ./certs/
USER node
ENTRYPOINT ["node", "src/bridge.mjs"]
