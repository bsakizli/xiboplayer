import { defineConfig } from 'vite';
import path from 'path';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));

const common = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
};

// App build (main + setup HTML pages)
const app = defineConfig({
  define: common,
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      external: ['hls.js'],
      input: {
        main: path.resolve(__dirname, 'index.html'),
        setup: path.resolve(__dirname, 'setup.html'),
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/xmds.php': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
});

// Tizen build — this Samsung TV's WebKit (Tizen 5.5, ~2019) fails to fetch
// ANY module-relative resource for packaged file:// content, both dynamic
// import() and static <script type="module" src="..."> — confirmed via an
// isolated on-device test (STEP5). ES modules are unusable here entirely,
// so the whole app is compiled to a single classic (non-module) IIFE script.
// codeSplitting:false requires a single input per build, hence two passes.
function tizenEntry(name, emptyOutDir) {
  return defineConfig({
    define: common,
    base: './',
    build: {
      outDir: 'dist',
      sourcemap: true,
      emptyOutDir,
      // Also down-level syntax: this engine's parser rejects ES2020 features
      // (confirmed via on-device "Unexpected token ?" — optional chaining
      // and/or nullish coalescing) even once module loading itself works.
      target: 'es2015',
      rollupOptions: {
        external: ['hls.js'],
        input: { [name]: path.resolve(__dirname, `${name}.html`) },
        output: {
          codeSplitting: false,
          format: 'iife',
          name: 'XiboTizenApp',
          globals: { 'hls.js': 'Hls' },
        },
      },
    },
  });
}

const tizenMain = tizenEntry('index', true);
const tizenSetup = tizenEntry('setup', false);

// Service Worker build — isolated so no DOM globals leak into SW context
const sw = defineConfig({
  define: common,
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    emptyOutDir: false,  // preserve app build output
    modulePreload: false,
    rollupOptions: {
      input: {
        sw: path.resolve(__dirname, 'public/sw-pwa.js'),
      },
      output: {
        entryFileNames: 'sw-pwa.js',
        chunkFileNames: 'assets/sw-[name]-[hash].js',
      },
    },
  },
});

export default process.env.BUILD_SW
  ? sw
  : process.env.BUILD_TIZEN_MAIN
    ? tizenMain
    : process.env.BUILD_TIZEN_SETUP
      ? tizenSetup
      : app;
