FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production=false

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

EXPOSE 8080 3001

# Start with ts-node
CMD ["npx", "ts-node", "src/index.ts"]
