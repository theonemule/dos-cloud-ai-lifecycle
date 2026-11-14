import { getWebInstrumentations, initializeFaro } from '@grafana/faro-web-sdk';
import { installJourneyTracking } from './journey.mjs';

if (__FARO_COLLECTOR_URL__) {
  const faro = initializeFaro({
    url: __FARO_COLLECTOR_URL__,
    app: { name: 'doscloud', version: __FARO_APP_VERSION__ },
    instrumentations: [...getWebInstrumentations({ captureConsole: false })],
  });
  installJourneyTracking(faro);
}