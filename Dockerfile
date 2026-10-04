FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server/index.js"]
