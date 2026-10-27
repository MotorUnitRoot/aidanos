# node:22-bookworm-slim
# Build from the repo root: docker build -f relay/Dockerfile -t aidanos-relay .
# relay/src imports ../../editor, which is /editor when the server lives in /app/src.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
COPY relay/scripts/reject-optional-native.sh scripts/reject-optional-native.sh
RUN npm ci --omit=dev --omit=optional \
  && bash scripts/reject-optional-native.sh \
  && chown -R node:node /app
COPY --chown=node:node relay/src ./src
COPY --chown=node:node relay/Acknowledgements.txt ./
COPY --chown=node:node editor /editor

# linux-arm64 has no pinned directory helper. Fail the image build instead of
# shipping a relay that cannot open a checked folder on that platform.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "arm64" ] && [ ! -f /editor/bin/dirfd-tool-linux-arm64 ]; then \
      echo "linux-arm64 directory helper is not shipped (editor/bin/dirfd-tool-linux-arm64). Refusing to build this image." >&2; \
      exit 1; \
    fi

ENV AIDANOS_RELAY_PORT=3750
EXPOSE 3750

# Listens on 127.0.0.1 inside the container. Pass --vault, and --lan only when you mean to.
USER node
CMD ["node", "src/server.mjs"]
