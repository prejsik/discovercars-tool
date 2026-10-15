import { readFile, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSnapshot } from './snapshot.mjs';
import { PrivateWorkspaceStore } from './private-store.mjs';
import { WorkspaceService, PanelError } from './workspace-service.mjs';

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
        error: 'Podglad przerwany po restarcie lokalnego serwera. Uruchom go ponownie.' });
    });
    initialized = true;
  }
  const capabilities = { sharedDraft: true, preview: true, publish: false, mode: 'local-shared',
    reason: 'Wspolny szkic na tym komputerze. Zapis GitHub nie jest aktywny.' };
  const repository = {
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
        const action = { '/api/workspace': 'workspace', '/api/draft': 'save', '/api/preview': 'requestPreview', '/api/publish': 'publish', '/api/rollback': 'rollback' }[path];
        if (!action) throw new PanelError(404, 'Nieznana operacja.');
        if ((action === 'workspace' && req.method !== 'GET') || (action !== 'workspace' && req.method !== 'POST')) throw new PanelError(405, 'Nieprawidlowa metoda.');
        let body = {};
        if (req.method === 'POST') {
          if (req.headers.origin !== `http://${req.headers.host}` || req.headers['x-panel-request'] !== '1'
            || req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new PanelError(403, 'Niedozwolone zrodlo zadania.');
          let length = 0; const chunks = [];
          for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024) throw new PanelError(413, 'Zadanie jest zbyt duze.'); chunks.push(chunk); }
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { throw new PanelError(400, 'Nieprawidlowy JSON.'); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PanelError(400, 'Nieprawidlowe dane.');
        }
        await initialize();
        const result = await service[action](body, 'local@localhost.test');
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = error.status ?? 503;
        res.end(JSON.stringify({ error: error.status ? error.message : 'Nie mozna wykonac operacji lokalnej.', details: error.details }));
      }
    };
    queue = queue.catch(() => {}).then(execute);
  };
}
