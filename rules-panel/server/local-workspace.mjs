import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshot } from './snapshot.mjs';
import { PrivateWorkspaceStore } from './private-store.mjs';
import { WorkspaceService, PanelError } from './workspace-service.mjs';
import { readCalendarEvents, saveCalendarEvent } from './calendar-events.mjs';
import { loadPriceContext, loadPriceSource, loadPublishedReport } from './reports.mjs';
import { protectedReportHtml } from './report-viewer.mjs';

const storageQueues = new Map();
const pendingStatuses = ['running', 'requesting', 'queued'];

export class FileStorage {
  constructor(directory) { this.directory = resolve(directory); }
  path(key) { return join(this.directory, `${encodeURIComponent(key)}.json`); }
  async get(key) {
    try { return JSON.parse(await readFile(this.path(key), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  put(key, value) { return this.transaction(db => db.put(key, value)); }
  async #write(key, value) {
    if (typeof key === 'object') {
      for (const [name, data] of Object.entries(key)) await this.#write(name, data);
      return;
    }
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path(key)}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value));
    await rename(temporary, this.path(key));
  }
  async list({ prefix, limit }) {
    let files;
    try { files = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
    const keys = files.filter(name => name.endsWith('.json')).map(name => decodeURIComponent(name.slice(0, -5)))
      .filter(key => key.startsWith(prefix)).sort().slice(0, limit);
    return new Map(await Promise.all(keys.map(async key => [key, await this.get(key)])));
  }
  transaction(task) {
    const previous = storageQueues.get(this.directory) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => task({
      get: key => this.get(key), put: (key, value) => this.#write(key, value), list: options => this.list(options),
    }));
    storageQueues.set(this.directory, result);
    const release = () => { if (storageQueues.get(this.directory) === result) storageQueues.delete(this.directory); };
    result.then(release, release);
    return result;
  }
}

export function localWorkspaceMiddleware({ directory = fileURLToPath(new URL('../.local/workspace', import.meta.url)), previewRunner } = {}) {
  const storage = new FileStorage(directory);
  let initialized = false;
  async function initialize() {
    if (initialized) return;
    await storage.transaction(async db => {
      const preview = await db.get('preview');
      if (pendingStatuses.includes(preview?.status)) await db.put('preview', { ...preview, status: 'failure',
        interruptedAt: new Date().toISOString(), queued: false, testsSucceeded: false,
        error: 'Podgląd przerwany po restarcie lokalnego serwera. Uruchom go ponownie.' });
    });
    initialized = true;
  }
  const capabilities = { sharedDraft: true, preview: true, publish: false, mode: 'local-shared',
    reason: 'Wspólny szkic na tym komputerze. Zapis GitHub nie jest aktywny.' };
  const repository = {
    json:async (path,revision)=>{
      if(path!=='locations.config.json'||!/^[a-f0-9]{40}$/.test(revision))throw new PanelError(422,'Nieprawidłowe źródło lokalizacji.');
      const response=await fetch(`https://raw.githubusercontent.com/prejsik/discovercars-tool/${revision}/${path}`,{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw new PanelError(502,'Nie można odczytać lokalizacji raportu.');return response.json();
    },
    snapshot: () => readSnapshot(), publication: async () => null, verifyPreview: async () => false,
    publish: async () => { throw new PanelError(503, 'Lokalny serwer nigdy nie publikuje zasad.'); },
    pollPreview: pending => storage.get('preview').then(value => value ?? pending),
    requestPreview: async (draft, previewId) => {
      const pending = { previewId, draftRevision: draft.revision, sourceRevision: draft.sourceRevision,
        requestedAt: new Date().toISOString(), status: 'running', queued: true };
      const run = previewRunner ?? (async (...args) => {
        const module = await import('./run-preview-job.mjs');
        return module.runLocalPreview(...args);
      });
      const complete = result => storage.transaction(async db => {
        const current = await db.get('preview');
        if (current?.previewId !== previewId || !pendingStatuses.includes(current.status)) return;
        await db.put('preview', { ...result, previewId, revision: previewId, local: true, queued: false, testsSucceeded: false });
      });
      // A local job keeps running while the UI can refresh its status.
      setTimeout(() => {
        Promise.resolve().then(() => run(draft, pending)).then(complete)
          .catch(error => complete({ ...pending, status: 'failure', error: error.message }));
      }, 25);
      return pending;
    },
  };
  const store = new PrivateWorkspaceStore(storage, repository, { capabilities });
  const service = new WorkspaceService(store);
  let queue = Promise.resolve();
  return (req, res, next) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!path.startsWith('/api/')) return next();
    const execute = async () => {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      try {
        if(['/api/report/prices','/api/report/price-source','/api/report/open'].includes(path)) {
          if(req.method!=='GET')throw new PanelError(405,'Tylko odczyt.');
          const query=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
          if(path.endsWith('/open')) {res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Content-Security-Policy',"sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'");res.end(Buffer.from(protectedReportHtml(await loadPublishedReport(query.runId,repository))));return;}
          if(query.mode!=='market')throw new PanelError(503,'Historyczne pliki Excel są dostępne w opublikowanym panelu.');
          if(path.endsWith('/prices'))res.end(JSON.stringify(await loadPriceContext(query,repository)));
          else {res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.from(await loadPriceSource(query,repository)));}return;
        }
        const action = { '/api/calendar-events':'events','/api/calendar-events/save':'eventSave','/api/workspace': 'workspace', '/api/draft': 'save', '/api/preview': 'requestPreview', '/api/publish': 'publish', '/api/rollback': 'rollback' }[path];
        if (!action) throw new PanelError(404, 'Nieznana operacja.');
        const readOnly=['workspace','events'].includes(action);
        if ((readOnly && req.method !== 'GET') || (!readOnly && req.method !== 'POST')) throw new PanelError(405, 'Nieprawidłowa metoda.');
        let body = {};
        if (req.method === 'POST') {
          if (req.headers.origin !== `http://${req.headers.host}` || req.headers['x-panel-request'] !== '1'
            || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PanelError(403, 'Niedozwolone źródło żądania.');
          let length = 0; const chunks = [];
          for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024) throw new PanelError(413, 'Żądanie jest zbyt duże.'); chunks.push(chunk); }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { throw new PanelError(400, 'Nieprawidłowy JSON.'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PanelError(400, 'Nieprawidłowe dane.');
        }
        await initialize();
        if(action==='events'){res.end(JSON.stringify(await readCalendarEvents(storage)));return;}
        if(action==='eventSave'){const zones=(await readSnapshot()).documents.locations.locations.flatMap(row=>row.zones??[]);res.end(JSON.stringify(await saveCalendarEvent(storage,body,'local@localhost.test',zones)));return;}
        const result = await service[action](body, 'local@localhost.test');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error.status ?? 503;
        res.end(JSON.stringify({ error: error.status ? error.message : 'Nie można wykonać operacji lokalnej.', details: error.details }));
      }
    };
    queue = queue.catch(() => {}).then(execute);
  };
}
