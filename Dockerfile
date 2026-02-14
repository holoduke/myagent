FROM node:20-slim

# Install dependencies for Claude Code CLI, git, gh
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Create directories for persistent data (will be mounted as volumes)
RUN mkdir -p /data/auth_state /data/claude

# Symlink auth_state so the app finds it at ./auth_state
RUN ln -s /data/auth_state /app/auth_state

# Health check - just verify node is running
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD pgrep -f "tsx" > /dev/null || exit 1

# Start the agent
CMD ["npx", "tsx", "src/index.ts"]
