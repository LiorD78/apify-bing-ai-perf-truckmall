# Apify base image: Node 20 + Playwright + Chromium pre-installed
FROM apify/actor-node-playwright-chrome:20

# Copy package files first for Docker layer caching
COPY --chown=myuser package*.json ./

# Install dependencies (Apify base already has playwright; we only need apify SDK)
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version

# Copy source
COPY --chown=myuser . ./

# Run
CMD ["npm", "start", "--silent"]
