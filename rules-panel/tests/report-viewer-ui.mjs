import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chromium } from '../../node_modules/playwright/index.mjs';
import { protectedReportHtml } from '../server/report-viewer.mjs';
const require=createRequire(import.meta.url);
const {buildHtmlReport}=require('../../src/reportHtml.js');
const html=buildHtmlReport({generated_at:'2026-10-15T08:00:00Z',scenarios:[]});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
try {
  await page.route('**/api/report/open?*',route=>route.fulfill({body:Buffer.from(protectedReportHtml(new TextEncoder().encode(html))),headers:{'content-type':'text/html','content-security-policy':"sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"}}));
  await page.goto('http://report.test/api/report/open?runId=123');
  await page.locator('#filter-transmission').selectOption('automatic');
  await page.waitForURL('**/*#*view=automatic*');
  assert.equal(new URL(page.url()).searchParams.get('runId'),'123');
  await page.reload();
  assert.equal(await page.locator('#filter-transmission').inputValue(),'automatic');
  assert.deepEqual(errors,[]);
  console.log('Protected report UI PASS: filters work in isolated report, shared URL preserves run and restores filters.');
} finally {await browser.close();}
