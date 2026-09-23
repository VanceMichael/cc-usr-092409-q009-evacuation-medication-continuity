FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm config set fetch-retries 5 && npm config set fetch-retry-maxtimeout 120000 && npm ci
COPY src ./src
COPY test ./test
RUN npm test && npm prune --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "src/server.js"]
