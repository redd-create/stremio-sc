FROM node:20-alpine

WORKDIR /app

ENV PORT=7860
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY scraper.js server.js ./

EXPOSE 7860

CMD ["node", "server.js"]
