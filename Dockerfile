FROM node:20-alpine

WORKDIR /app

# Install root dependencies (express, ioredis — shared by src and demo)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the library source and the demo
COPY src/ ./src/
COPY examples/demo/ ./examples/demo/

EXPOSE 3001

CMD ["node", "examples/demo/server.js"]
