// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Widget HTML processing — preprocesses widget HTML and stores via REST
 *
 * Handles:
 * - <base> tag injection for relative path resolution (CMS mirror paths)
 * - Interactive Control hostAddress rewriting
 * - CSS object-position fix for CMS template alignment
 *
 * URL rewriting is no longer needed — the CMS serves CSS with relative paths
 * (${PLAYER_API}/dependencies/font.otf), and the <base> tag resolves widget
 * media references via mirror routes. Zero translation, zero regex.
 *
 * Runs on the main thread (needs window.location for URL construction).
 * Stores content via PUT /store/... — no Cache API needed.
 */

import { createLogger, PLAYER_API, PLAYER_API_PATH, localApiUrl } from '@xiboplayer/utils';
import { isTizenFilesystemAvailable, TizenFileStoreClient, resolveMediaSrc } from './tizen-filesystem-store.js';

const log = createLogger('Cache');

// Shared with getWidgetHtml's Tizen-filesystem read branch in the pwa package —
// TizenFileStoreClient's directory handle/URI cache are module-scoped in
// tizen-filesystem-store.js, so a second instance here stays in sync with it.
const tizenStore = new TizenFileStoreClient();

// Dynamic base path for multi-variant deployment (pwa, pwa-xmds, pwa-xlr)
const BASE = (typeof window !== 'undefined')
  ? window.location.pathname.replace(/\/[^/]*$/, '').replace(/\/$/, '') || '/player/pwa'
  : '/player/pwa';

/**
 * Store widget HTML in ContentStore for iframe loading.
 * Stored at mirror path ${PLAYER_API}/widgets/{L}/{R}/{M} — same URL the
 * CMS serves from, so iframes load directly from Express mirror routes.
 *
 * @param {string} layoutId - Layout ID
 * @param {string} regionId - Region ID
 * @param {string} mediaId - Media ID
 * @param {string} html - Widget HTML content
 * @returns {Promise<string>} Cache key URL (absolute path for iframe src)
 */
export async function cacheWidgetHtml(layoutId, regionId, mediaId, html) {
  const cacheKey = `${PLAYER_API}/widgets/${layoutId}/${regionId}/${mediaId}`;
  const tizenMode = isTizenFilesystemAvailable();

  let modifiedHtml = html;

  // Interactive Control (xiboIC) requires a real local HTTP endpoint
  // (BASE + '/ic') to report clicks/actions to — meaningless in Tizen
  // filesystem ('direct') mode where there is no local server at all. CMS
  // widget HTML unconditionally calls `xiboIC.setTargetId(...)` as part of
  // its standard boilerplate (not just for widgets that use IC); without a
  // stub this throws a ReferenceError that aborts the REST of that inline
  // script — including the code further down that actually populates the
  // widget's #content div — which is why widgets rendered as fully blank.
  // A no-op Proxy stub absorbs any xiboIC.* call harmlessly.
  const icStub = tizenMode
    ? `<script>if(typeof xiboIC==='undefined'){window.xiboIC=new Proxy({},{get:function(){return function(){};}});}</script>`
    : '';

  // TEMPORARY: relay iframe-internal JS errors to the outer page's on-screen
  // debug console (window.onerror set by the parent AFTER the iframe's own
  // load event fires would miss errors thrown during initial script exec —
  // this must run before any other script in the widget HTML).
  // TODO remove once Method 2 widget rendering is verified end-to-end.
  if (tizenMode) {
    const errorRelay = `<script>(function(){function relay(m){try{if(window.parent&&window.parent.__dbg)window.parent.__dbg('[widget-iframe] '+m);}catch(e){}}window.onerror=function(msg,src,line,col){relay('JS ERROR: '+msg+' @'+line+':'+col);return false;};window.addEventListener('unhandledrejection',function(ev){relay('UNHANDLED REJECTION: '+(ev.reason&&ev.reason.message?ev.reason.message:ev.reason));});relay('iframe script starting, body present: '+!!document.body);})();</script>` + icStub;
    if (html.includes('<head>')) {
      modifiedHtml = html.replace('<head>', '<head>' + errorRelay);
    } else if (html.includes('<HEAD>')) {
      modifiedHtml = html.replace('<HEAD>', '<HEAD>' + errorRelay);
    } else {
      modifiedHtml = errorRelay + html;
    }
  }

  // <base href> only works when every relative ref resolves against ONE common
  // prefix (a proxy mirror route). In Tizen-filesystem mode each cached file's
  // file:// URI is independent (no shared directory+name pattern), so there is
  // no valid base — refs are rewritten individually further down instead.
  const baseTag = tizenMode ? null : `<base href="${PLAYER_API}/media/file/">`;

  // Insert base tag after <head> opening tag (skip if already present)
  if (baseTag && !html.includes('<base ')) {
    if (html.includes('<head>')) {
      modifiedHtml = html.replace('<head>', '<head>' + baseTag);
    } else if (html.includes('<HEAD>')) {
      modifiedHtml = html.replace('<HEAD>', '<HEAD>' + baseTag);
    } else {
      modifiedHtml = baseTag + html;
    }
  }

  // Inject CSS default for object-position to suppress CMS template warning
  const cssFixTag = '<style>img,video{object-position:center center}</style>';
  if (!modifiedHtml.includes('object-position:center center')) {
    if (modifiedHtml.includes('</head>')) {
      modifiedHtml = modifiedHtml.replace('</head>', cssFixTag + '</head>');
    } else if (modifiedHtml.includes('</HEAD>')) {
      modifiedHtml = modifiedHtml.replace('</HEAD>', cssFixTag + '</HEAD>');
    }
  }

  // Replace CMS placeholders left for "client-side SDK handling"
  modifiedHtml = modifiedHtml.replace(/\[\[ViewPortWidth]]/g, 'device-width');

  if (tizenMode) {
    // No local proxy exists to serve /dependencies/ or /stream-proxy — rewrite
    // bare relative refs (Xibo's convention: src="42" for media, src="bundle.min.js"
    // /"fonts.css" for dependencies) directly to their resolved file:// URI.
    // XMDS RequiredFiles reports dependencies with the same type="media" as
    // regular media (confirmed via direct XMDS query), and the download
    // pipeline stores them the same way (type 'media', id = saveAs filename) —
    // so the same 'media' store type resolves both.
    modifiedHtml = modifiedHtml.replace(
      /((?:src|href)=")([^"]*)(")/g,
      (match, pre, ref, post) => {
        // Only bare filenames (no path separators/protocol/whitespace) are
        // real media/dependency saveAs names. Skip: absolute/protocol URLs,
        // already-rewritten file:// URIs (idempotent re-processing — this
        // function may run again on stored HTML), and unprocessed Handlebars
        // placeholders like "{{#if assetId}}{{else}}{{url}}{{/if}}" (contain
        // braces/spaces) which bundle.min.js resolves client-side at runtime.
        if (!ref || /[/{}\s]/.test(ref) || /^(https?:|data:|#)/.test(ref)) return match;
        const fallback = `${PLAYER_API}/media/file/${ref}`;
        return pre + resolveMediaSrc('media', ref, fallback) + post;
      }
    );
  } else {
    // Route HLS streams through local proxy (adds CORS headers, rewrites segments)
    modifiedHtml = modifiedHtml.replace(
      /https?:\/\/[^\s"')<]+\.m3u8\b/gi,
      (url) => '/stream-proxy?url=' + encodeURIComponent(url)
    );

    // Rewrite dependency URLs to absolute local paths. CMS SOAP GetResource sends
    // bare filenames (e.g. src="bundle.min.js") which resolve against <base> to the
    // wrong /media/file/ path. Normalize all dependency references to absolute paths.
    const depsPattern = new RegExp(
      `https?://[^"'\\s)]+?(${PLAYER_API.replace(/\//g, '\\/')}/dependencies/[^"'\\s?)]+)(\\?[^"'\\s)]*)?`,
      'g'
    );
    modifiedHtml = modifiedHtml.replace(depsPattern, (_, path) => path);
    modifiedHtml = modifiedHtml.replace(
      /(<(?:script|link)\b[^>]*(?:src|href)=")(?!\/|https?:\/\/)(bundle\.min\.js|fonts\.css)(")/g,
      `$1${PLAYER_API}/dependencies/$2$3`
    );
  }

  // Inject xiboICTargetId — XIC library reads this global before its IIFE runs
  // to set _lib.targetId, which is included in every IC HTTP request as {id: ...}
  if (!modifiedHtml.includes('xiboICTargetId')) {
    const targetIdScript = `<script>var xiboICTargetId = '${mediaId}';</script>`;
    if (baseTag && modifiedHtml.includes(baseTag)) {
      modifiedHtml = modifiedHtml.replace(baseTag, baseTag + targetIdScript);
    } else if (modifiedHtml.includes('<head>')) {
      modifiedHtml = modifiedHtml.replace('<head>', '<head>' + targetIdScript);
    } else {
      modifiedHtml = targetIdScript + modifiedHtml;
    }
  }

  // Rewrite Interactive Control hostAddress to SW-interceptable path
  modifiedHtml = modifiedHtml.replace(
    /hostAddress\s*:\s*["']https?:\/\/[^"']+["']/g,
    `hostAddress: "${BASE}/ic"`
  );

  log.info(tizenMode ? 'Rewrote media refs in widget HTML' : 'Injected base tag in widget HTML');

  const widgetStoreId = `${layoutId}/${regionId}/${mediaId}`;
  if (tizenMode) {
    // Same 'widget' type + id convention as main.ts's getWidgetHtml read branch —
    // TizenFileStoreClient's dir handle/URI cache are module-scoped, so this
    // instance and the pwa's own instance stay in sync.
    const ok = await tizenStore.put('widget', widgetStoreId, new Blob([modifiedHtml], { type: 'text/html;charset=utf-8' }));
    if (ok) {
      log.info(`Stored widget HTML in Tizen filesystem (${modifiedHtml.length} bytes)`);
    } else {
      log.warn(`Failed to store widget HTML in Tizen filesystem: ${widgetStoreId}`);
    }
  } else {
    // Store widget HTML — deps are already downloaded by the pipeline
    const putResp = await fetch(localApiUrl(`/store${PLAYER_API_PATH}/widgets/${layoutId}/${regionId}/${mediaId}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: modifiedHtml,
    });
    putResp.body?.cancel();
    log.info(`Stored widget HTML at ${cacheKey} (${modifiedHtml.length} bytes)`);
  }

  return { cacheKey, html: modifiedHtml };
}
