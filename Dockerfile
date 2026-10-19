# Imagem para o Northflank (ou qualquer host com Docker). Debian (glibc) porque o ffmpeg-static não roda em Alpine.
FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY index.js server.js servidor.js ./
ENV NODE_ENV=production PORT=10000
EXPOSE 10000
USER node
CMD ["node", "servidor.js"]
