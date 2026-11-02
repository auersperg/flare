FROM node:24-trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @openai/codex@0.166.0
COPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY run.mjs events.mjs /opt/flare/
WORKDIR /workspace
CMD ["sleep", "infinity"]
