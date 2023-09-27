FROM node:18-alpine3.17

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./

USER node

RUN npm install -g yarn && yarn install

COPY --chown=node:node . .

RUN yarn build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
