FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (tsx is needed at runtime)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source
COPY src/ src/
COPY tsconfig.json entrypoint.sh ./
RUN chmod +x entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/ || exit 1

ENTRYPOINT ["./entrypoint.sh"]
