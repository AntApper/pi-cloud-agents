# MicroVM Image for pi-cloud-agents (Final - ARM64 AL2023 base)
FROM public.ecr.aws/lambda/microvms:al2023-minimal:latest

# Install Node.js 22, Git, and essential toolchain utilities
RUN dnf install -y \
    nodejs22 \
    npm \
    git \
    tar \
    gzip \
    zstd \
    which \
    findutils \
    procps-ng \
    ca-certificates \
    && dnf clean all \
    && rm -rf /var/cache/dnf

# Globally install pinned pi coding agent matching package.json
RUN npm install -g @earendil-works/pi-coding-agent@0.85.1

# Configure directory structure
RUN mkdir -p /opt/pi-cloud/pi-extensions \
    /root/.pi/agent \
    /work \
    /workspace

# Copy runner bundle, extensions, and git credential helper into /opt/pi-cloud/
COPY runner.js /opt/pi-cloud/runner.js
COPY askpass.sh /opt/pi-cloud/askpass.sh
COPY pi-extensions/ /opt/pi-cloud/pi-extensions/

RUN chmod +x /opt/pi-cloud/askpass.sh

# Configure runtime environment
ENV HOOK_PORT=9000
ENV HOME=/root
ENV PI_CODING_AGENT_DIR=/root/.pi/agent
ENV NODE_ENV=production

# Set default workspace directory
WORKDIR /work

# Default entrypoint for Lambda MicroVM runtime hooks
ENTRYPOINT ["node", "/opt/pi-cloud/runner.js"]
