const esbuild = require('esbuild');
const path = require('path');
const DEFAULT_URL = 'https://telemetry.blaize.net/faro/paladin-chronicles/55b956833eac8972820004fb2b939ad9';

function collectorURL(raw) {
  const u = new URL(raw || DEFAULT_URL);
  if (u.protocol !== 'https:' || u.origin !== 'https://telemetry.blaize.net' ||
      !/^\/faro\/[a-z0-9_-]{1,80}\/[A-Za-z0-9_-]{16,128}$/.test(u.pathname) ||
      u.search || u.hash || u.username || u.password) {
    throw new Error('Faro must use the HTTPS scoped telemetry.blaize.net collector without query credentials');
  }
  return u.href;
}

async function build() {
  const url = process.env.DOS_CLOUD_FARO_DISABLED === '1' ? '' : collectorURL(process.env.FARO_COLLECTOR_URL);
  await esbuild.build({
    entryPoints: [path.join(__dirname, '../public/faro.js')],
    outfile: path.join(__dirname, '../public/faro.bundle.js'),
    bundle: true, platform: 'browser', target: ['es2020'], minify: true, sourcemap: false,
    define: {
      __FARO_COLLECTOR_URL__: JSON.stringify(url),
      __FARO_APP_VERSION__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 12) || 'production'),
    },
  });
}
if (require.main === module) build().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { collectorURL };