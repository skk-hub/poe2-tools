FROM node:22-alpine
WORKDIR /app
COPY . .
EXPOSE 17777
CMD ["node", "server.js"]
