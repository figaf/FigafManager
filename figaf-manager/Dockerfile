FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY cloud/      ./cloud/
COPY installer/  ./installer/
COPY lib/        ./lib/
COPY bin/        ./bin/
COPY figaf-logo.png ./

RUN chmod +x bin/btp bin/cf 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "cloud/server.js"]
