import assert from 'node:assert/strict';
import { unstable_dev } from 'wrangler';

const worker = await unstable_dev('tests/report-runtime-worker.mjs', {
  config:'tests/report-runtime-wrangler.jsonc', local:true, ip:'127.0.0.1', port:0,
  experimental:{disableExperimentalWarning:true},
});
const failures = [];
try {
  for (const path of ['/status','/incident','/status-redirect','/incident-redirect']) {
    try {
      const response = await worker.fetch(path);
      const body = await response.json();
      if (path === '/status') {
        assert.equal(body.result.available,true,JSON.stringify(body));
        assert.equal(body.result.report.runId,'123');
        assert.equal(body.result.excel.runId,'123');
        assert.deepEqual(body.result.warnings,[]);
      } else if (path === '/incident') {
        assert.equal(response.status,200,JSON.stringify(body));
        assert.equal(body.result.report.incident.positions[0].rate,80);
        assert.equal(body.result.report.incident.positions[0].limit,77);
        assert.equal(body.calls.at(-1).authorization,false);
      } else if (path === '/status-redirect') {
        assert.equal(body.result.available,false);
        assert.match(body.result.warnings[0],/HTTP 302/);
        assert.equal(body.calls.length,2);
      } else {
        assert.equal(response.status,500);
        assert.match(body.error,/Nie mozna odczytac wyniku/);
        assert.equal(body.calls.length,4);
      }
      assert.ok(body.calls.every(call => !call.url.startsWith('https://unexpected.example')));
      console.log(`Workers report runtime PASS ${path}`);
    } catch(error) { failures.push(error); console.error(`Workers report runtime FAIL ${path}: ${error.message}`); }
  }
} finally { await worker.stop(); }
assert.equal(failures.length,0,'Workers report runtime regressions failed');
