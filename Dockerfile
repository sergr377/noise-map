# Единый образ: Node отдаёт фронтенд и API, JVM считает акустику.
#
# Собран и проверен 2026-09-02: сборка 5 мин 51 с, образ 999.6 МБ, холодный расчёт
# в контейнере доходит до конца при пике 1495 МиБ. Две вещи, которых с хоста не
# видно: JVM берёт кучу как четверть лимита контейнера (1 ГБ при mem_limit 4g,
# против 2203 МБ пика на хосте), и DNS внутри контейнера мигает — загрузка рельефа
# в dem.mjs ретрая не имеет и этого не переживает. Подробности в tasks.md.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY web ./web
# server/src и scripts/run-job.mjs импортируют shared/ относительным путём, так
# что каталог нужен обеим стадиям — и убирать его нельзя ни из одной: без него
# здесь падает tsc (TS2307), а в рантайме сервер умирает на первом импорте.
COPY shared ./shared

# Ключей на этапе сборки не нужно: подложка своя, геокодер по данным OSM.
RUN npm run build:server && npm run build:web


FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# JRE для NoiseModelling, unzip и curl для его загрузки на этапе сборки образа.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jre-headless curl unzip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Дистрибутив расчётного движка, 148 МБ. Тянется при сборке, чтобы образ был
# самодостаточным и не зависел от сети при запуске.
ARG NM_VERSION=6.0.0
RUN curl -fsSL -o /tmp/nm.zip \
      "https://github.com/Universite-Gustave-Eiffel/NoiseModelling/releases/download/v${NM_VERSION}/NoiseModelling_${NM_VERSION}.zip" \
 && mkdir -p /app/.tools/nm \
 && unzip -q /tmp/nm.zip -d /app/.tools/nm \
 && rm /tmp/nm.zip \
 && chmod +x "/app/.tools/nm/NoiseModelling_${NM_VERSION}/bin/ScriptRunner"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/dist-web ./dist-web
COPY pipeline ./pipeline
COPY scripts ./scripts
COPY shared ./shared

# jobs/ и cache/ — рабочие каталоги, tiles/ — подложка; в compose под них
# подключены тома. Тайлы в образ не кладутся: .pmtiles на сотни мегабайт
# пересобирается отдельно и живёт своей жизнью, см. scripts/build-tiles.mjs.
RUN mkdir -p jobs cache tiles

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Расчёт распространения держит пик около 1.8 ГБ, поэтому контейнеру нужно
# не меньше 2.5 ГБ памяти — иначе OOM во время первого же холодного клика.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
