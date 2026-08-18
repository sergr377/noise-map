# Единый образ: Node отдаёт фронтенд и API, JVM считает акустику.
#
# ВНИМАНИЕ: образ не собирался и не проверялся — на машине разработки нет Docker.
# Первую сборку стоит прогнать локально и убедиться, что ScriptRunner стартует.

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig*.json vite.config.ts ./
COPY server ./server
COPY web ./web

# Vite вшивает ключ в бандл на этапе сборки, поэтому он нужен здесь, а не при
# запуске. Это безопасно: ключ JS API ограничен по HTTP Referer и всё равно
# виден в исходниках страницы. Ключ геокодера сюда не передаётся — он серверный
# и в браузер не попадает.
ARG VITE_YANDEX_API_KEY
ENV VITE_YANDEX_API_KEY=$VITE_YANDEX_API_KEY
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

# jobs/ и cache/ — рабочие каталоги; в compose под них подключён том.
RUN mkdir -p jobs cache

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Расчёт распространения держит пик около 1.8 ГБ, поэтому контейнеру нужно
# не меньше 2.5 ГБ памяти — иначе OOM во время первого же холодного клика.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
