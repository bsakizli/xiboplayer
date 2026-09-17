// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2024-2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Tizen native filesystem-backed store — StoreClient-compatible interface
 * (has/get/put/remove/list), for webviews that can neither register a
 * Service Worker (Tizen's packaged file:// content is fundamentally
 * incompatible with SW registration on every Tizen version) nor run a
 * companion local server (plain consumer Tizen has no SSSP
 * b2bcontrol.startNodeServer bridge — see the sibling `tizen-xibo-sssp`
 * project for that path).
 *
 * Uses the Tizen Web Device API's `tizen.filesystem`
 * (privileges: http://tizen.org/privilege/filesystem.read and .write) —
 * a packaged-app-only capability outside the normal web sandbox, callback
 * based, wrapped here in Promises.
 *
 * Renderer media src assignment (layout.js) happens synchronously — it
 * cannot await a Promise for a file:// URI. So writes/existence-checks
 * populate an in-memory URI cache (getCachedUri) that the renderer reads
 * synchronously; by the time layout rendering starts, the download phase
 * (which always runs first) has already populated it.
 */

const ROOT_LOCATION = 'documents';
// Bumped from 'xibo-cache' to force a clean cache: earlier test sessions (a
// different CMS/layout state, before the current single-layout "Default
// Layout" setup) left stale widget/media files on disk that were never
// invalidated (no modifiedDt/md5 staleness check — see cacheWidgetHtml
// caller in main.ts), and kept being served as "already cached" forever
// since `tizen uninstall` was deliberately removed from the deploy script
// to preserve the display's hardwareKey across redeploys.
const SUBDIR = 'xibo-cache-v2';

let _dirHandle = null;
let _dirReady = null;

function sanitizeKey(type, id) {
  return `${type}_${id}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

// Temporary direct-to-screen instrumentation, bypasses the SDK's own logger
// level entirely (CMS narrows it to ERROR once registered, hiding info-level
// logs) — TODO remove once Method 2 is verified end-to-end on real hardware.
function dbg(msg) {
  try { if (typeof window !== 'undefined' && window.__dbg) window.__dbg('[TizenFS] ' + msg); } catch (_e) {}
}

function ensureDir() {
  if (_dirReady) return _dirReady;
  dbg('ensureDir: resolving ' + ROOT_LOCATION + '...');
  _dirReady = new Promise((resolve, reject) => {
    if (typeof tizen === 'undefined' || !tizen.filesystem) {
      dbg('ensureDir FAILED: tizen.filesystem not available');
      reject(new Error('tizen.filesystem not available'));
      return;
    }
    tizen.filesystem.resolve(
      ROOT_LOCATION,
      (rootDir) => {
        try {
          _dirHandle = rootDir.resolve(SUBDIR);
          dbg('ensureDir OK (existing ' + SUBDIR + ')');
          resolve(_dirHandle);
        } catch (_notFound) {
          try {
            _dirHandle = rootDir.createDirectory(SUBDIR);
            dbg('ensureDir OK (created ' + SUBDIR + ')');
            resolve(_dirHandle);
          } catch (createErr) {
            dbg('ensureDir FAILED to create dir: ' + (createErr && createErr.message));
            reject(createErr);
          }
        }
      },
      (err) => {
        dbg('ensureDir FAILED to resolve ' + ROOT_LOCATION + ': ' + (err && err.message));
        reject(err);
      },
      'rw'
    );
  });
  return _dirReady;
}

// type/id -> file:// URI, populated on has()/get()/put(). Read synchronously
// by the renderer (see resolveMediaSrc in @xiboplayer/utils or renderer callers).
const uriCache = new Map();

/** Synchronous lookup — null if not yet resolved (not downloaded, or store not ready). */
export function getCachedUri(type, id) {
  return uriCache.get(`${type}/${id}`) || null;
}

/** True if tizen.filesystem is present in this JS context at all. */
export function isTizenFilesystemAvailable() {
  return typeof tizen !== 'undefined' && !!tizen.filesystem;
}

/**
 * Resolve a media src synchronously: a cached file:// URI when running in
 * Tizen native-filesystem mode and the file has already been downloaded,
 * otherwise `fallback` (the normal playerApiUrl()-constructed HTTP URL).
 * Used by renderer/layout.js and renderer/renderer-lite.js so the same
 * generateMediaJS()-style synchronous code path works in both modes without
 * needing to thread async/await through layout generation.
 */
export function resolveMediaSrc(type, id, fallback) {
  if (!isTizenFilesystemAvailable()) return fallback;
  const cached = getCachedUri(type, id);
  dbg('resolveMediaSrc(' + type + ', ' + id + ') -> ' + (cached ? 'CACHED: ' + cached : 'not cached, using fallback: ' + fallback));
  return cached || fallback;
}

export class TizenFileStoreClient {
  async has(type, id) {
    let dir;
    try {
      dir = await ensureDir();
    } catch (_e) {
      return false;
    }
    const key = sanitizeKey(type, id);
    try {
      const fileHandle = dir.resolve(key);
      uriCache.set(`${type}/${id}`, fileHandle.toURI());
      dbg('has(' + type + ', ' + id + ') -> true');
      return true;
    } catch (_notFound) {
      dbg('has(' + type + ', ' + id + ') -> false (not found)');
      return false;
    }
  }

  async get(type, id) {
    let dir;
    try {
      dir = await ensureDir();
    } catch (_e) {
      return null;
    }
    const key = sanitizeKey(type, id);
    let fileHandle;
    try {
      fileHandle = dir.resolve(key);
    } catch (_notFound) {
      return null;
    }
    uriCache.set(`${type}/${id}`, fileHandle.toURI());
    return new Promise((resolve) => {
      fileHandle.openStream(
        'r',
        (stream) => {
          try {
            const bytes = stream.readBytes(fileHandle.fileSize);
            stream.close();
            resolve(new Blob([new Uint8Array(bytes)]));
          } catch (readErr) {
            stream.close();
            resolve(null);
          }
        },
        () => resolve(null)
      );
    });
  }

  async put(type, id, body, _contentType = 'application/octet-stream') {
    dbg('put(' + type + ', ' + id + ') starting...');
    let dir;
    try {
      dir = await ensureDir();
    } catch (_e) {
      dbg('put(' + type + ', ' + id + ') FAILED: no dir');
      return false;
    }
    const key = sanitizeKey(type, id);

    // Blob.prototype.arrayBuffer() doesn't exist on this old Tizen webview
    // (Chromium ~69 — the method landed around Chrome 76). FileReader has
    // been universally supported forever, so use that instead.
    function blobToArrayBuffer(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
        reader.readAsArrayBuffer(blob);
      });
    }

    let buffer;
    if (body instanceof ArrayBuffer) {
      buffer = body;
    } else if (body instanceof Blob) {
      buffer = await blobToArrayBuffer(body);
    } else {
      buffer = await blobToArrayBuffer(new Blob([body]));
    }
    // writeBytes() needs a plain octet array, not a typed array — this is a
    // known slow path for very large files (multi-hundred-MB video); revisit
    // with chunked writes if real-device testing shows it's a bottleneck.
    const byteArray = Array.from(new Uint8Array(buffer));

    let fileHandle;
    try {
      fileHandle = dir.resolve(key);
    } catch (_notFound) {
      try {
        fileHandle = dir.createFile(key);
      } catch (createErr) {
        return false;
      }
    }

    return new Promise((resolve) => {
      fileHandle.openStream(
        'w',
        (stream) => {
          try {
            stream.writeBytes(byteArray);
            stream.close();
            const uri = fileHandle.toURI();
            uriCache.set(`${type}/${id}`, uri);
            dbg('put(' + type + ', ' + id + ') OK, ' + byteArray.length + ' bytes -> ' + uri);
            resolve(true);
          } catch (writeErr) {
            stream.close();
            dbg('put(' + type + ', ' + id + ') writeBytes FAILED: ' + (writeErr && writeErr.message));
            resolve(false);
          }
        },
        (err) => { dbg('put(' + type + ', ' + id + ') openStream(w) FAILED: ' + (err && err.message)); resolve(false); }
      );
    });
  }

  async remove(files) {
    let dir;
    try {
      dir = await ensureDir();
    } catch (_e) {
      return { deleted: 0, total: files.length };
    }
    let deleted = 0;
    for (const f of files) {
      const key = sanitizeKey(f.type, f.id);
      try {
        const fileHandle = dir.resolve(key);
        const uri = fileHandle.toURI();
        await new Promise((resolve) => {
          dir.deleteFile(uri, () => { deleted++; resolve(); }, () => resolve());
        });
        uriCache.delete(`${f.type}/${f.id}`);
      } catch (_notFound) {
        // Already gone — fine.
      }
    }
    return { deleted, total: files.length };
  }

  async list() {
    let dir;
    try {
      dir = await ensureDir();
    } catch (_e) {
      return [];
    }
    return new Promise((resolve) => {
      dir.listFiles(
        (files) => resolve(files.map((f) => ({ id: f.name, type: 'unknown', size: f.fileSize || 0 }))),
        () => resolve([])
      );
    });
  }
}
