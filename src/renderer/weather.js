  const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
  const GEO_CACHE_LIMIT = 24;

  let state, els, setStatus, trimMapSize;

  function init(ctx) {
    state = ctx.state;
    els = ctx.els;
    setStatus = ctx.setStatus;
    trimMapSize = ctx.trimMapSize;
  }

  function normalizeWeatherUnit(value) {
    return String(value || '').toLowerCase() === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  }

  function normalizeWeatherCity(value) {
    return String(value || '').trim() || 'Moscow';
  }

  function weatherUnitSuffix(unit) {
    return normalizeWeatherUnit(unit) === 'fahrenheit' ? '°F' : '°C';
  }

  function weatherCodeToIcon(code, isDay = 1) {
    const value = Number(code);
    const daytime = Number(isDay) === 1;
    if (value === 0) return daytime ? '☀️' : '🌙';
    if ([1, 2].includes(value)) return daytime ? '🌤️' : '☁️';
    if (value === 3) return '☁️';
    if ([45, 48].includes(value)) return '🌫️';
    if ([51, 53, 55, 56, 57, 80, 81, 82].includes(value)) return '🌧️';
    if ([61, 63, 65, 66, 67].includes(value)) return '🌦️';
    if ([71, 73, 75, 77, 85, 86].includes(value)) return '🌨️';
    if ([95, 96, 99].includes(value)) return '⛈️';
    return '🌡️';
  }

  function weatherCodeToRu(code) {
    const value = Number(code);
    if (value === 0) return 'Ясно';
    if ([1, 2].includes(value)) return 'Переменная облачность';
    if (value === 3) return 'Облачно';
    if ([45, 48].includes(value)) return 'Туман';
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'Дождь';
    if ([71, 73, 75, 77, 85, 86].includes(value)) return 'Снег';
    if ([95, 96, 99].includes(value)) return 'Гроза';
    return 'Погода';
  }

  function renderWeatherSummary({ city, icon, temperature, unit, loading }) {
    // Toolbar widget is the only mandatory target now — city/icon/temp.
    // weatherUnit toggle + popover were removed; update them defensively.
    if (!els.weatherIcon || !els.weatherTemp) return;
    const safeCity = normalizeWeatherCity(city || state.settings?.weatherCity);
    const safeUnit = normalizeWeatherUnit(unit || state.settings?.weatherUnit);
    if (els.weatherCity) els.weatherCity.textContent = safeCity;
    els.weatherIcon.textContent = icon || '🌙';
    els.weatherTemp.textContent = Number.isFinite(temperature) ? `${Math.round(temperature)}${weatherUnitSuffix(safeUnit)}` : `--${weatherUnitSuffix(safeUnit)}`;
    els.weatherToggle?.classList.toggle('is-loading', Boolean(loading));
  }

  async function fetchJsonWithTimeout(url, timeoutMs = 9000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`http_${response.status}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveWeatherCoords(city) {
    const safeCity = normalizeWeatherCity(city);
    const cacheKey = safeCity.toLowerCase();
    if (state.weatherGeoCache.has(cacheKey)) {
      return state.weatherGeoCache.get(cacheKey);
    }
    const geocodeUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(safeCity)}&count=1&language=ru&format=json`;
    const payload = await fetchJsonWithTimeout(geocodeUrl, 9000);
    const row = Array.isArray(payload?.results) ? payload.results[0] : null;
    if (!row) {
      throw new Error('city_not_found');
    }
    const coords = {
      city: String(row.name || safeCity),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    };
    // The cache has no TTL: caching NaN coords from a malformed geocoding
    // response would make every 10-minute refresh 400 until app restart.
    if (!Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
      throw new Error('city_not_found');
    }
    state.weatherGeoCache.set(cacheKey, coords);
    trimMapSize(state.weatherGeoCache, GEO_CACHE_LIMIT);
    return coords;
  }

  // Generation token: the 10-min interval and a manual city save can race —
  // a late response from the OLD request must not overwrite the NEW one.
  let _weatherGen = 0;

  async function refreshWeather(forceCity = '') {
    const gen = ++_weatherGen;
    const city = normalizeWeatherCity(forceCity || state.settings?.weatherCity);
    const unit = normalizeWeatherUnit(state.settings?.weatherUnit);
    renderWeatherSummary({ city, unit, loading: true });

    try {
      const coords = await resolveWeatherCoords(city);
      const forecastUrl =
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}` +
        `&longitude=${coords.longitude}` +
        '&current=temperature_2m,weather_code,is_day' +
        '&timezone=auto' +
        `&temperature_unit=${unit}`;
      const payload = await fetchJsonWithTimeout(forecastUrl, 9000);
      if (gen !== _weatherGen) return; // superseded by a newer refresh
      const current = payload?.current || {};
      const weatherCode = Number(current.weather_code);
      const temperature = Number(current.temperature_2m);
      const isDay = Number(current.is_day || 0);
      const icon = weatherCodeToIcon(weatherCode, isDay);
      const weatherText = weatherCodeToRu(weatherCode);

      renderWeatherSummary({
        city: coords.city,
        icon,
        temperature,
        unit,
        loading: false,
      });
    } catch (error) {
      if (gen !== _weatherGen) return; // a newer refresh owns the UI now
      renderWeatherSummary({ city, unit, loading: false });
      /* Обе ветки были пустыми: неизвестный город и обрыв сети выглядели
         одинаково — «загрузка кончилась, ничего не изменилось». */
      const msg = String(error?.message || '');
      if (msg.includes('city_not_found')) {
        setStatus?.(`Погода: город «${city}» не найден`);
      } else if (/timeout|abort/i.test(msg)) {
        setStatus?.('Погода: сервис не ответил, попробуйте позже');
      } else {
        setStatus?.('Погода: не удалось обновить (нет сети или сервис недоступен)');
      }
    }
  }

  function startWeatherRefreshLoop() {
    if (state.weatherRefreshTimer) {
      clearInterval(state.weatherRefreshTimer);
      state.weatherRefreshTimer = null;
    }
    state.weatherRefreshTimer = setInterval(() => {
      refreshWeather().catch((e) => console.warn('[weather]', e));
    }, REFRESH_INTERVAL_MS);
  }

  export const WaDeckWeatherModule = {
    init,
    normalizeWeatherUnit,
    normalizeWeatherCity,
    renderWeatherSummary,
    refreshWeather,
    startWeatherRefreshLoop,
  };
  window.WaDeckWeatherModule = WaDeckWeatherModule;
