FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080
ENV HOST=0.0.0.0
ENV PORT=8080
ENV SNM_DB=/data/shop.db
ENV SNM_BACKUPS=/data/backups

CMD ["npm", "run", "shop"]
