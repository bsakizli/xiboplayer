// Build-only entry point for bundling @xiboplayer/proxy into a single
// CommonJS file that can run under Samsung SSSP's embedded Node.js runtime
// (started via b2bapis.b2bcontrol.startNodeServer — see lib/nodelogic.js
// in the Tizen SSSP package). Not part of the published npm package.
import { startServer } from './src/proxy.js';
import path from 'path';

// __dirname is injected by esbuild's CJS output — this file ends up at
// <wgt-root>/lib/xibo-proxy-bundle.cjs once bundled, so '..' is the wgt root
// (where index.html and the web app assets live).
const wgtRoot = path.join(__dirname, '..');

function start(port) {
  // pwaConfig.cmsUrl seeds ContentStore init at startup (without it, /store/*
  // routes 501 with "ContentStore not configured" until a runtime /config
  // POST arrives). TODO: read this from a deployment-time config file instead
  // of hardcoding once this moves beyond initial validation.
  return startServer({
    port: port || 9696,
    listenAddress: '127.0.0.1',
    pwaPath: wgtRoot,
    dataDir: path.join(wgtRoot, 'data'),
    appVersion: '1.0.0',
    allowShellCommands: false,
    pwaConfig: { cmsUrl: 'http://10.112.38.117' },
  });
}

start()
  .then(() => {
    console.log('[XiboProxy] started on port 9696, dataDir=' + path.join(wgtRoot, 'data'));
  })
  .catch((err) => {
    console.error('[XiboProxy] failed to start:', err && err.message, err && err.stack);
  });
