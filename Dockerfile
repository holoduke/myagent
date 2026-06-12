FROM node:20-slim

# Install dependencies for Claude Code CLI, git, gh
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install AI CLI tools globally
RUN npm install -g @anthropic-ai/claude-code@2.1.175 @openai/codex @vibe-kit/grok-cli

# Create app directory
WORKDIR /app

# Copy package files and install
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Playwright Chromium + system dependencies
RUN npx playwright install --with-deps chromium

# Copy source
COPY tsconfig.json ./
COPY backend/ ./backend/

# Create directories for persistent data (will be mounted as volumes)
RUN mkdir -p /data/auth_state /data/claude /data/brain /data/agents /data/browser

# Symlink auth_state so the app finds it at ./auth_state
RUN ln -s /data/auth_state /app/auth_state

# Initialize git repo so self-improve worker can use git commands
RUN cd /app && git init && git config user.email "aria@myagent" && git config user.name "ARIA" && git add -A && git commit -m "deploy baseline"

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 3000

# Health check via HTTP
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
    CMD curl -f http://localhost:3000/ || exit 1

# Start via entrypoint (sets HOME=/data/claude for credential persistence)
CMD ["/app/entrypoint.sh"]
