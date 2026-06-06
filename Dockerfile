FROM node:20-alpine

WORKDIR /app

# Dependências primeiro (cache de camada)
COPY package*.json ./
RUN npm ci --omit=dev

# Código-fonte
COPY server.js ./
COPY public ./public

# Pasta de dados persistida via volume
RUN mkdir -p /app/data

EXPOSE 4000

CMD ["node", "server.js"]
