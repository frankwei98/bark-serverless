// Exercise native Workers fetch validation; mock only the outbound HTTP boundary.
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const projectRequire = createRequire(path.join(root, 'package.json'));
const wranglerRequire = createRequire(projectRequire.resolve('wrangler'));
const { Miniflare } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');

async function main() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const bundle = await build({
    stdin: {
      contents: `
        import { HuaweiPushSender } from './worker/src/services/huawei-push-sender';
        export default { async fetch(request, env) {
          const sender = new HuaweiPushSender({ projectId: 'test-project',
            keyId: 'test-key', subAccount: 'test-account', privateKey: env.TEST_PRIVATE_KEY });
          try {
            await sender.send({ deviceKey: 'test', deviceToken: 'synthetic-token',
              title: 'Title', subtitle: '', body: 'Hello', sound: '1107', extParams: {} });
            return Response.json({ success: true });
          } catch (error) {
            return Response.json({ success: false, message: error.message,
              statusCode: error.statusCode, retryable: error.retryable });
          }
        }};
      `,
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'browser',
    tsconfig: path.join(root, 'tsconfig.json'),
  });
  let responseStatus = 200;
  let outboundCalls = 0;
  const mf = new Miniflare({
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-06-12',
    outboundService(request) {
      outboundCalls++;
      assert.equal(request.url, 'https://push-api.cloud.huawei.com/v3/test-project/messages:send');
      assert.equal(request.method, 'POST');
      return new Response(responseStatus === 200 ? JSON.stringify({ code: '80000000' }) : null, {
        status: responseStatus,
        headers: responseStatus === 200 ? {} : { location: 'https://example.invalid/never-follow' },
      });
    },
    bindings: { TEST_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) },
  });
  try {
    assert.deepEqual(await (await mf.dispatchFetch('http://localhost')).json(), { success: true });
    for (const statusCode of [301, 302, 303, 307, 308]) {
      responseStatus = statusCode;
      assert.deepEqual(await (await mf.dispatchFetch('http://localhost')).json(), {
        success: false, message: 'Huawei push redirect rejected', statusCode, retryable: false,
      });
    }
    assert.equal(outboundCalls, 6);
    console.log('Huawei native workerd fetch: success and all redirect rejection checks passed.');
  } finally {
    await mf.dispose();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
