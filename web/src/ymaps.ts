/**
 * Bootstraps the Yandex Maps JS API and exposes its components as React ones.
 *
 * The module uses top-level await deliberately: it guarantees `ymaps3.ready` and
 * the reactify import have resolved before anything importing it renders, so the
 * map components can be used synchronously in JSX.
 */
import React from 'react';
import ReactDOM from 'react-dom';

const apiKey = import.meta.env.VITE_YANDEX_API_KEY;
if (!apiKey) {
  throw new Error(
    'VITE_YANDEX_API_KEY не задан. Скопируйте .env.example в .env и подставьте ключ Яндекс Карт.',
  );
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

await loadScript(`https://api-maps.yandex.ru/v3/?apikey=${apiKey}&lang=ru_RU`);

const [ymaps3React] = await Promise.all([
  ymaps3.import('@yandex/ymaps3-reactify'),
  ymaps3.ready,
]);

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
