# --- build: compile TypeScript (needs dev dependencies) ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- run: production dependencies and compiled code only ---
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# Apply pending migrations, then start. `exec` makes node the main process,
# so it receives SIGTERM from the host and shuts down cleanly.
CMD ["sh", "-c", "npm run migration:run && exec node dist/main"]
