FROM node:24-alpine

WORKDIR /app

# Install root dependencies (express, ioredis — shared by src and demo)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the library source and the demo
COPY src/ ./src/
COPY examples/demo/ ./examples/demo/

ENV HOSTNAME=0.0.0.0
ENV PORT=5003

EXPOSE 5003

ENTRYPOINT ["node", "examples/demo/server.js"]
