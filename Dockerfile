# Line by Line — API + screens. Built by the hosting builder from the GitHub repo.
# ECR Public mirror of the official Node image avoids Docker Hub's anonymous pull limit on shared builders.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# Infisical CLI (pinned release, checksum-verified): secrets are injected at start by `infisical run`.
ARG INFISICAL_VERSION=0.43.145
ARG TARGETARCH
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sha="36732e9c108feb3916eabd5be35db7a56431c383b766a6c3b1afa05cb27696ae" ;; \
      arm64) sha="9b559ed2bd639c59999eb181270aca975554ca45fcdf2eaf118d53a8fce4b98c" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/infisical.deb \
      "https://github.com/Infisical/cli/releases/download/v${INFISICAL_VERSION}/infisical_${INFISICAL_VERSION}_linux_${arch}.deb"; \
    echo "${sha}  /tmp/infisical.deb" | sha256sum -c -; \
    apt-get install -y --no-install-recommends /tmp/infisical.deb; \
    rm -f /tmp/infisical.deb; \
    apt-get purge -y curl; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*; \
    infisical --version

ENV NODE_ENV=production \
    PORT=8080 \
    SECRETS_SOURCE=infisical

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY data ./data
COPY eval/audio ./eval/audio
COPY eval/recordings ./eval/recordings
COPY eval/findings.json ./eval/findings.json

COPY --chmod=0755 tools/docker-entrypoint.sh /app/docker-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/app/docker-entrypoint.sh"]
# Shell form keeps the PORT fallback (the platform sets PORT; default 8080).
CMD ["sh", "-c", "exec node dist/server.js"]
