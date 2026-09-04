# Build stage
FROM node:20-alpine AS build
ARG NUXT_API_URL
ENV NUXT_API_URL=${NUXT_API_URL}
WORKDIR /app

COPY package.json package-lock.json* ./
# The lock file is generated on macOS and lacks the linux-musl native binding
# for oxc-parser (npm/cli#4828); install it explicitly before nuxt prepare runs.
RUN npm ci --ignore-scripts \
    && npm install --no-save --force "@oxc-parser/binding-linux-x64-musl@$(node -p "require('oxc-parser/package.json').version")" \
    && npx nuxt prepare

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
