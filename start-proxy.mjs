// Standalone launcher for @xiboplayer/proxy with ContentStore enabled.
// The published CLI (bin/cli.js) doesn't expose --data-dir, so ContentStore
// (the /store/* filesystem cache used for offline layouts/media) is never
// initialized when using `xiboplayer-proxy` directly. This script calls
// startServer() with dataDir set, which the CLI omits.
import { startServer } from './packages/proxy/src/proxy.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await startServer({
  port: 8765,
  pwaPath: path.join(__dirname, 'packages/pwa/dist'),
  dataDir: path.join(__dirname, '.xibo-data'),
  appVersion: '0.2.0',
});
