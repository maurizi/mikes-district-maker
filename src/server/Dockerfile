FROM node:24-bookworm-slim

RUN mkdir -p /home/node/app/server
WORKDIR /home/node/app/server

RUN set -ex \
    && apt-get update && apt-get install -yq \
    procps \
    python3 \
    make \
    g++ \
    --no-install-recommends

COPY package.json /home/node/app/server
COPY yarn.lock /home/node/app/server
RUN set -ex \
    && yarn install --ignore-engines

COPY . /home/node/app/server

ENTRYPOINT ["yarn"]
CMD ["start:prod"]
