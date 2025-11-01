# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:20-alpine AS builder
WORKDIR /app
ENV SKIP_ENV_VALIDATION=true \
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db \
  OPENAI_API_KEY=dummy-openai-key \
  NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run db:generate && npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache netcat-openbsd
COPY --from=builder /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV SKIP_ENV_VALIDATION=false
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
