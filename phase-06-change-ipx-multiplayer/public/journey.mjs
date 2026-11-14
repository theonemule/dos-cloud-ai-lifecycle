// First-party, tab-scoped acquisition and navigation attribution.
// Do not persist full referrer URLs, search terms, cookies, IPs, or user IDs.
const KEY = 'doscloud-journey-v1';
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const MAX_PATH = 240;
const MAX_FIELD = 80;
const SEARCH_DOMAINS = /(^|\.)(google\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2,3})|bing\.com|duckduckgo\.com|yahoo\.(com|co\.[a-z]{2}|com\.[a-z]{2}|[a-z]{2,3})|baidu\.com|yandex\.(com|ru))$/i;
const SOCIAL_DOMAINS = /(^|\.)(quora\.com|reddit\.com|linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|pinterest\.com)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeHost(host) {
  return (host || '').toLowerCase().replace(/^www\./, '').slice(0, 120);
}

export function safePath(value, base = 'https://example.com/') {
  try {
    const url = new URL(value, base);
    // Avoid leaking email addresses or token-shaped values in path segments.
    const pathname = url.pathname.split('/').map((part) => {
      if (/%40|@|^[0-9a-f]{20,}$|^[0-9]{9,}$|^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(part)) {
        return ':redacted';
      }
      return part;
    }).join('/');
    return pathname.slice(0, MAX_PATH) || '/';
  } catch {
    return '/';
  }
}

function campaignValue(search, key) {
  const value = (search.get(key) || '').trim();
  // Conservative ASCII-only campaign labels. Never forward arbitrary query text.
  return value.length <= MAX_FIELD && /^[a-z0-9][a-z0-9._-]*$/i.test(value) ? value : '';
}

export function entryAttribution(locationHref, documentReferrer = '') {
  const page = new URL(locationHref);
  const params = page.searchParams;
  const utm_source = campaignValue(params, 'utm_source');
  const utm_medium = campaignValue(params, 'utm_medium');
  const utm_campaign = campaignValue(params, 'utm_campaign');

  let referrerHost = '';
  let referrerPath = '';
  let internalReferrerPath = '';
  if (documentReferrer) {
    try {
      const referrer = new URL(documentReferrer);
      if (referrer.protocol === 'https:' || referrer.protocol === 'http:') {
        if (referrer.origin === page.origin) {
          internalReferrerPath = safePath(referrer.href, page.href);
        } else {
          referrerHost = safeHost(referrer.hostname);
          // The browser often supplies only an origin across sites. When a
          // public path is available, keep its pathname but not any query.
          // Hide likely private, credential, or account routes entirely.
          const candidatePath = safePath(referrer.href);
          if (!/^\/(account|auth|login|logout|user|users|profile|settings|reset|token|private)(\/|$)/i.test(candidatePath)) {
            referrerPath = candidatePath;
          }
        }
      }
    } catch {
      // Malformed or privacy-redacted referrers provide no usable attribution.
    }
  }

  let source_type = 'direct_or_unknown';
  let source = '';
  if (utm_source || utm_medium || utm_campaign) {
    source_type = 'campaign';
    source = utm_source || referrerHost;
  } else if (params.has('gclid')) {
    source_type = 'paid_search';
    source = 'google';
  } else if (params.has('msclkid')) {
    source_type = 'paid_search';
    source = 'bing';
  } else if (referrerHost && SEARCH_DOMAINS.test(referrerHost)) {
    source_type = 'organic_search';
    source = referrerHost;
  } else if (referrerHost && SOCIAL_DOMAINS.test(referrerHost)) {
    source_type = 'social_referral';
    source = referrerHost;
  } else if (referrerHost) {
    source_type = 'referral';
    source = referrerHost;
  } else if (internalReferrerPath) {
    source_type = 'internal';
  }

  return {
    landing_path: safePath(page.href),
    source_type,
    source,
    referrer_domain: referrerHost,
    referrer_path: referrerPath,
    internal_referrer_path: internalReferrerPath,
    utm_source,
    utm_medium,
    utm_campaign,
  };
}

function readState(storage, now) {
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || 'null');
    if (
      !saved || !UUID.test(saved.id) ||
      !Number.isSafeInteger(saved.last_seen) ||
      now < saved.last_seen ||
      now - saved.last_seen > IDLE_LIMIT_MS ||
      !Number.isSafeInteger(saved.page_number) ||
      saved.page_number < 1 || saved.page_number > 100000 ||
      !saved.entry || typeof saved.entry.landing_path !== 'string'
    ) return null;
    return saved;
  } catch {
    return null;
  }
}

function writeState(storage, state) {
  try {
    storage?.setItem(KEY, JSON.stringify(state));
  } catch {
    // Session storage may be unavailable in privacy modes. Page views still work.
  }
}

function newId(crypto) {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto?.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  }
  return ''; // Never fall back to guessable identifiers.
}

// Called once when the Faro browser bundle loads on a document.
export function installJourneyTracking(faro, win = window, doc = document, clock = () => Date.now()) {
  const now = clock();
  const location = new URL(win.location.href);
  const path = safePath(location.href);
  let storage;
  try {
    storage = win.sessionStorage;
  } catch {
    // Browser storage may be disabled.
  }
  const existing = readState(storage, now);
  const state = existing || {
    id: newId(win.crypto),
    entry: entryAttribution(location.href, doc.referrer),
    page_number: 0,
    last_path: '',
    last_seen: now,
  };
  const previousPath = existing && existing.last_path !== path
    ? safePath(existing.last_path, location.href)
    : (!existing ? state.entry.internal_referrer_path : '');

  state.page_number += 1;
  state.last_seen = now;
  state.last_path = path;
  writeState(storage, state);

  const entry = state.entry;
  const visit = {
    ...(state.id ? { visit_id: state.id } : {}),
    landing_path: entry.landing_path,
    source_type: entry.source_type,
    source: entry.source,
    referrer_domain: entry.referrer_domain,
    referrer_path: entry.referrer_path,
    utm_source: entry.utm_source,
    utm_medium: entry.utm_medium,
    utm_campaign: entry.utm_campaign,
  };

  // Faro already tracks sessions, errors and web vitals. Keep that identity;
  // attach only coarse attribution, which also enriches non-page-view signals.
  if (typeof faro.api.setSession === 'function') {
    const session = typeof faro.api.getSession === 'function'
      ? (faro.api.getSession() || {}) : {};
    faro.api.setSession({
      ...session,
      attributes: {
        ...(session.attributes || {}),
        ...(state.id ? { visit_id: state.id } : {}),
        landing_path: entry.landing_path,
        source_type: entry.source_type,
        source: entry.source,
        referrer_domain: entry.referrer_domain,
        referrer_path: entry.referrer_path,
      },
    });
  }
  faro.api.pushEvent('page_view', {
    ...visit,
    path,
    previous_path: previousPath || '',
    page_number: String(state.page_number),
  });

  // Captures navigation intent. The next page_view also records the previous
  // page, even if this event is interrupted by a full page navigation.
  const onClick = (event) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('#')) return;
    let target;
    try {
      target = new URL(href, location.href);
    } catch {
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return;
    if (target.origin === location.origin) {
      const destination = safePath(target.href);
      if (destination === path) return;
      faro.api.pushEvent('internal_link_click', {
        ...(state.id ? { visit_id: state.id } : {}),
        from_path: path,
        to_path: destination,
        page_number: String(state.page_number),
      });
    } else {
      faro.api.pushEvent('outbound_link_click', {
        ...(state.id ? { visit_id: state.id } : {}),
        from_path: path,
        destination_domain: safeHost(target.hostname),
        page_number: String(state.page_number),
      });
    }
  };
  doc.addEventListener('click', onClick, { capture: true, passive: true });
  return {
    visit,
    path,
    page_number: state.page_number,
    dispose: () => doc.removeEventListener('click', onClick, true),
  };
}