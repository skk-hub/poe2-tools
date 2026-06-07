FROM node:22-alpine
RUN apk add --no-cache tesseract-ocr imagemagick
WORKDIR /app
COPY . .
EXPOSE 17777
CMD ["node", "server.js"]
