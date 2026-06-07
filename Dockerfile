FROM node:22-alpine
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng imagemagick
WORKDIR /app
COPY . .
EXPOSE 17777
CMD ["node", "server.js"]
