FROM node:23.4.0-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY ./src ./src

COPY tsconfig.json ./

RUN npx tsc

EXPOSE 3000

CMD ["node", "dist/index.js"]