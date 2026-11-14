
FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=development

# Run the TypeScript worker directly under Node.
# Docker Compose init supervises this process.
CMD ["node", "--import", "tsx", "src/workers/worker-main.ts"]
