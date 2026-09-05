FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY server.mjs app.js index.html day.css styles.css start.sh ./
COPY manifest.webmanifest sw.js ./
COPY icon-180.png icon-192.png apple-touch-icon.png ./
COPY vault ./vault
EXPOSE 8080
ENV PORT=8080
ENV AIDANOS_HOST=0.0.0.0
CMD ["node", "server.mjs"]
