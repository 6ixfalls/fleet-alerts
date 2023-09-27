FROM node:18-alpine3.17

RUN mkdir -p /home/node/app/node_modules && chown -R node:node /home/node/app

WORKDIR /home/node/app

COPY package*.json ./
COPY yarn.lock ./

USER node

RUN yarn install --frozen-lockfile

COPY --chown=node:node . .

RUN yarn build

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
