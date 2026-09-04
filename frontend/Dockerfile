# Build stage
FROM node:20-alpine AS build
ARG NUXT_API_URL
ENV NUXT_API_URL=${NUXT_API_URL}
WORKDIR /app

COPY package.json package-lock.json* ./
# package-lock.json must list the linux-x64-musl native bindings (oxc, rollup,
# esbuild, parcel). If a lock generated on macOS drops them (npm/cli#4828),
# regenerate it with `rm package-lock.json && npm install` before deploying.
RUN npm ci

COPY . .
RUN npm run build

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app

COPY --from=build /app/.output .output

RUN chown -R node:node /app

USER node

ENV HOST=0.0.0.0
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", ".output/server/index.mjs"]
