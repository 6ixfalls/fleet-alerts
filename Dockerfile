FROM node:18-alpine3.17
WORKDIR /home/node/app
COPY . /home/node/app
ENV NODE_ENV=production
CMD ["node", "/home/node/app/dist/index.js"]
