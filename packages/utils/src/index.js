// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
// @xiboplayer/utils - Shared utilities
import pkg from '../package.json' with { type: 'json' };
export const VERSION = pkg.version;
export { createLogger, setLogLevel, getLogLevel, isDebug, applyCmsLogLevel, mapCmsLogLevel, registerLogSink, unregisterLogSink, LOG_LEVELS } from './logger.js';
export { EventEmitter } from './event-emitter.js';
import { config as _config } from './config.js';
export { config, SHELL_ONLY_KEYS, extractPwaConfig, computeCmsId, warnPlatformMismatch } from './config.js';
export { fetchWithRetry } from './fetch-retry.js';
export { openIDB, queryByIndex, deleteByIds } from './idb.js';
export { CmsApiClient, CmsApiError } from './cms-api.js';

/**
 * CMS Player API base path — all media, dependencies, and widgets are served
 * under this prefix.
 *
 * Default: '/player/api/v2' (standalone index.php endpoint).
 * Override: set `playerApiBase` in config.json / localStorage, or call
 *           setPlayerApi('/new/path') before route registration (proxy).
 *
 * Browser: reads from config.data.playerApiBase at import time.
 * Node:    call setPlayerApi() before createProxyApp().
 */
const DEFAULT_PLAYER_API = '/player/api/v2';
let _playerApi = _config.data?.playerApiBase || DEFAULT_PLAYER_API;

/** Current Player API base path (no trailing slash). */
export let PLAYER_API = _playerApi;

function stripOrigin(base) {
  return /^https?:\/\//i.test(base) ? new URL(base).pathname.replace(/\/+$/, '') : base;
}

/**
 * PLAYER_API's path only, with any scheme+host stripped (Tizen/SSSP sets
 * PLAYER_API to a full `http://127.0.0.1:PORT/...` origin — code that nests
 * PLAYER_API as a path segment under another route, e.g. `/store${PLAYER_API}`
 * or `STORE_PREFIX = PLAYER_API.slice(1)`, needs the bare path form or it
 * produces a mangled URL).
 */
export let PLAYER_API_PATH = stripOrigin(_playerApi);

/** Override the Player API base path at runtime (call before route registration). */
export function setPlayerApi(base) {
  _playerApi = base.replace(/\/+$/, '');
  PLAYER_API = _playerApi;
  PLAYER_API_PATH = stripOrigin(_playerApi);
}

/**
 * Origin of the local proxy/companion server. Same derivation PLAYER_API
 * uses: when PLAYER_API has been set to a full URL (Tizen/SSSP — see
 * localApiUrl below), reuse ITS origin; otherwise fall back to the page's
 * own origin (Electron/browser/Chromium-kiosk, where the proxy serves the
 * page itself, so they share an origin).
 */
function localOrigin() {
  if (/^https?:\/\//i.test(PLAYER_API)) {
    return new URL(PLAYER_API).origin;
  }
  return window.location.origin;
}

/**
 * Build a full Player API URL, handling both relative and absolute PLAYER_API
 * bases. Packaged Tizen apps load from a `file://` document — for those,
 * PLAYER_API is set to a full `http://127.0.0.1:PORT/player/api/v2` origin
 * (see the SSSP Node-service bridge), so naively prefixing
 * `window.location.origin` would produce a broken `file://http://...` URL.
 * @param {string} pathSuffix - appended as-is (include the leading slash)
 */
export function playerApiUrl(pathSuffix) {
  const base = /^https?:\/\//i.test(PLAYER_API) ? PLAYER_API : `${window.location.origin}${PLAYER_API}`;
  return `${base}${pathSuffix}`;
}

/**
 * Build a full URL for a local-proxy route that lives OUTSIDE the
 * PLAYER_API prefix (e.g. StoreClient's `/store/*`, which is a sibling of
 * `/player/api/v2` on the same proxy, not nested under it). Same file://
 * concern as playerApiUrl — see localOrigin() above.
 * @param {string} pathSuffix - appended as-is (include the leading slash)
 */
export function localApiUrl(pathSuffix) {
  return `${localOrigin()}${pathSuffix}`;
}
