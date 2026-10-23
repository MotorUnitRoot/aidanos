FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/reject-optional-native.sh scripts/reject-optional-native.sh
RUN npm ci --omit=dev --omit=optional \
  && bash scripts/reject-optional-native.sh
COPY src ./src

ENV AIDANOS_RELAY_PORT=3750
EXPOSE 3750

# Listens on 127.0.0.1 inside the container. Pass --lan only when you mean to.
CMD ["node", "src/server.mjs"]
