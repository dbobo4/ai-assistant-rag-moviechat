# syntax=docker/dockerfile:1

FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

FROM node:20-bookworm AS builder
WORKDIR /app
# A build fázisban NEM kapcsolódunk DB-hez; ezek csak placeholder env-k
ENV SKIP_ENV_VALIDATION=true \
    DATABASE_URL=postgresql://postgres:postgres@db:5432/app_db \
    OPENAI_API_KEY=dummy-openai-key \
    NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run db:generate && npm run build

FROM node:20-bookworm AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV SKIP_ENV_VALIDATION=false
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
