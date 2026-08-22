FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data logs public/uploads
USER node
EXPOSE 3000
CMD ["node", "scripts/start-production.js"]
