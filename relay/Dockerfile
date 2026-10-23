# node:22-bookworm-slim
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/reject-optional-native.sh scripts/reject-optional-native.sh
RUN npm ci --omit=dev --omit=optional \
  && bash scripts/reject-optional-native.sh \
  && chown -R node:node /app
COPY --chown=node:node src ./src
COPY --chown=node:node Acknowledgements.txt ./

ENV AIDANOS_RELAY_PORT=3750
EXPOSE 3750

# Listens on 127.0.0.1 inside the container. Pass --vault, and --lan only when you mean to.
USER node
CMD ["node", "src/server.mjs"]
