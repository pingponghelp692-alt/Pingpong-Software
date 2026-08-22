FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p data logs public/uploads /app/uploads/music /app/uploads/photos /app/uploads/backgrounds /app/uploads/logos /app/uploads/frames /app/uploads/video-gifts /app/uploads/video-gifts-thumbs /app/uploads/svip-tags /app/uploads/group-icons /app/uploads/gift-images /app/uploads/gift-sounds /app/uploads/banners /app/uploads/vehicle-thumbs /app/uploads/vehicle-videos /app/uploads/vehicle-audio /app/uploads/level-themes /app/uploads/relationship-assets /app/data && chmod -R 777 /app/uploads /app/data
USER node
EXPOSE 3000
CMD ["node", "scripts/start-production.js"]
