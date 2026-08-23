/**
 * Bootstraps the Yandex Maps JS API and exposes its components as React ones.
 *
 * The module uses top-level await deliberately: it guarantees `ymaps3.ready` and
 * the reactify import have resolved before anything importing it renders, so the
 * map components can be used synchronously in JSX.
 */
import React from 'react';
import ReactDOM from 'react-dom';
import { MAP_LOAD_TIMEOUT } from './mapErrors';

const apiKey = import.meta.env.VITE_YANDEX_API_KEY;
if (!apiKey) {
  throw new Error(
    'VITE_YANDEX_API_KEY не задан. Скопируйте .env.example в .env и подставьте ключ Яндекс Карт.',
  );
}

/**
 * Ceiling on the whole bootstrap. Neither onload nor onerror fires on a stalled
 * connection — the request simply hangs — and the interface has nothing to show
 * for that but «Загружаю карту…» forever. Every other network call in this
 * project has a deadline; this one had none.
 */
const LOAD_TIMEOUT_MS = 20_000;

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        // Названо, чтобы интерфейс отличил обрыв сети от отвергнутого ключа:
        // подсказка про кабинет разработчика к таймауту отношения не имеет.
        const timeout = new Error(message);
        timeout.name = MAP_LOAD_TIMEOUT;
        reject(timeout);
      }, LOAD_TIMEOUT_MS);
    }),
  ]);
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('Не удалось загрузить JS API Яндекс Карт — проверьте ключ и сеть'));
    document.head.appendChild(script);
  });
}

await withTimeout(
  loadScript(`https://api-maps.yandex.ru/v3/?apikey=${apiKey}&lang=ru_RU`),
  `JS API Яндекс Карт не ответил за ${LOAD_TIMEOUT_MS / 1000} с — похоже на проблему с сетью`,
);

// The script can arrive and the API still never become usable: ymaps3.ready is
// a promise of its own, and the reactify module is a second request.
const [ymaps3React] = await withTimeout(
  Promise.all([ymaps3.import('@yandex/ymaps3-reactify'), ymaps3.ready]),
  `JS API Яндекс Карт загрузился, но не запустился за ${LOAD_TIMEOUT_MS / 1000} с`,
);

export const reactify = ymaps3React.reactify.bindTo(React, ReactDOM);

export const {
  YMap,
  YMapDefaultSchemeLayer,
  YMapDefaultFeaturesLayer,
  YMapFeature,
  YMapListener,
  YMapMarker,
  YMapControls,
  YMapZoomControl,
} = reactify.module(ymaps3);
