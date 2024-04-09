FROM node:20-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY index.ts tsconfig.json ./

RUN npx tsc

EXPOSE 3000

CMD ["node", "dist/index.js"]