FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

RUN mkdir -p \
    /app/data \
    /app/logs \
    /app/public/uploads \
    /app/uploads \
    /app/uploads/music \
    /app/uploads/group-icons \
    /app/uploads/svip-tags \
    /app/uploads/frames \
    /app/uploads/gifts \
    /app/uploads/avatars \
    && chown -R node:node /app/data /app/logs /app/public/uploads /app/uploads \
    && chmod -R 775 /app/data /app/logs /app/public/uploads /app/uploads

USER node

EXPOSE 3000

CMD ["node", "scripts/start-production.js"]
