FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY server.mjs app.js index.html day.css styles.css start.sh ./
COPY manifest.webmanifest sw.js icon-180.png icon-192.png apple-touch-icon.png ./
COPY vault ./vault
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN chown -R node:node /app
USER node
EXPOSE 8080
ENV PORT=8080
ENV AIDANOS_HOST=0.0.0.0
CMD ["node", "server.mjs"]
