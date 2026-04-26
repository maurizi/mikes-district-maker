FROM node:24-bookworm-slim AS tippecanoe

ENV TIPPECANOE_VERSION="2.79.0"

RUN set -ex \
  && deps=" \
  g++ \
  libsqlite3-dev \
  libz-dev \
  make \
  wget \
  " \
  && apt-get update && apt-get install -yq $deps

WORKDIR /usr/local/src

RUN wget -qO- https://github.com/felt/tippecanoe/archive/${TIPPECANOE_VERSION}.tar.gz \
  | tar xvz -C /usr/local/src
RUN make -j2 -C /usr/local/src/tippecanoe-${TIPPECANOE_VERSION}
RUN make -C /usr/local/src/tippecanoe-${TIPPECANOE_VERSION} install


FROM node:24-bookworm-slim

RUN mkdir -p /home/node/app/manage
WORKDIR /home/node/app/manage

RUN set -ex \
  && deps=" \
  libsqlite3-dev \
  libgeos-dev \
  libproj-dev \
  libgdal-dev \
  python3 \
  python3-venv \
  python3-dev \
  procps \
  make \
  g++ \
  curl \
  ca-certificates \
  " \
  && apt-get update && apt-get install -yq $deps --no-install-recommends

COPY package.json /home/node/app/manage
COPY yarn.lock /home/node/app/manage
RUN set -ex \
  && yarn install --ignore-engines

# Python pipeline (prepare-region-data) lives alongside the Node CLI. We
# create a venv at /opt/py-venv and install the pinned dependencies; only
# the pyproject.toml is copied in this layer so a pure-source change
# doesn't bust the dep install cache.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

COPY python/pyproject.toml /home/node/app/manage/python/pyproject.toml
RUN set -ex \
  && uv venv /opt/py-venv --python python3 \
  && VIRTUAL_ENV=/opt/py-venv uv pip install --no-cache \
       'geopandas>=1.0' \
       'shapely>=2.0' \
       'maup>=2.0' \
       'pandas>=2.0' \
       'pyproj>=3.6' \
       'fiona>=1.10' \
       'click>=8.1' \
       'requests>=2.31' \
       'numpy>=1.26' \
       'pytest>=8.0'

ENV PATH="/opt/py-venv/bin:${PATH}"
ENV PYTHONPATH="/home/node/app/manage/python"

COPY --from=tippecanoe /usr/local/bin/tippecanoe /usr/local/bin/tippecanoe
COPY --from=tippecanoe /usr/local/bin/tile-join /usr/local/bin/tile-join

COPY . /home/node/app/manage

# Limit V8 heap so GC returns memory to OS between phases.
# GEOS native memory is outside this limit.
ENV NODE_OPTIONS="--max-old-space-size=24576"

CMD ["/home/node/app/manage/bin/run"]
