import { DurableObject } from 'cloudflare:workers';
import { WorkspaceService, PanelError } from '../server/workspace-service.mjs';
import { PrivateWorkspaceStore } from '../server/private-store.mjs';
import { GitHubRepository, githubConfigured } from './github.mjs';
import { decodeBaseline, inspectBaseline, compareBaselineCoverage } from '../server/baseline.mjs';
import { loadPublishedWorkbook, workbookInput } from '../server/reports.mjs';
import { tickSchedule } from './scheduler.mjs';

// One coordination atom is one repository, shared by its authorized directors.
export class RulesWorkspace extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.queue = Promise.resolve(); }

  async scheduleTick(now) {
    const task = this.queue.catch(() => {}).then(async () => {
      if (this.env.SCRAPER_SCHEDULE_ENABLED !== 'true' || !githubConfigured(this.env)) throw new Error('Scraper scheduler is disabled');
      return tickSchedule({ now, repository: new GitHubRepository(this.env), storage: this.ctx.storage });
    });
    this.queue = task;
    return task;
  }

  async handle(action, input, actor) {
    const task = this.queue.catch(() => {}).then(async () => {
      try {
        const allowed = (this.env.ACCESS_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase());
        if (!allowed.includes(actor)) throw new PanelError(403, 'Brak dostepu.');
        if (!githubConfigured(this.env)) throw new PanelError(503, 'Integracja GitHub nie jest skonfigurowana.');
        const repository = new GitHubRepository(this.env);
        if (action === 'reportBaselineCheck' || action === 'reportBaselinePublish') {
          const publish = action === 'reportBaselinePublish';
          if (publish && input.importConfirmed !== true) throw new PanelError(422, 'Potwierdz, ze ten plik zostal wgrany do DiscoverCars.');
          const file = await loadPublishedWorkbook({ kind: 'import', runId: input.runId, sha256: input.fileSha256 }, repository.fetcher);
          input = { ...input, ...workbookInput(file) };
          action = publish ? 'baselinePublish' : 'baselineCheck';
        }
        if (action === 'baselineCheck' || action === 'baselinePublish') {
          const snapshot = await repository.snapshot();
          const summary = await inspectBaseline(decodeBaseline(input), snapshot.documents);
          if (action === 'baselinePublish' && typeof input.importConfirmed !== 'boolean') throw new PanelError(422, 'Potwierdz status importu pliku.');
          if (action === 'baselinePublish' && summary.sha256 === snapshot.baseline.sha256 && snapshot.baseline.filename === input.filename && snapshot.baseline.importConfirmed === input.importConfirmed) {
            return { status: 200, body: { revision: snapshot.source.revision, sha256: summary.sha256, alreadyCurrent: true } };
          }
          const cacheKey = `baseline-coverage:${snapshot.baseline.sha256}`;
          let previous = await this.ctx.storage.get(cacheKey);
          if (!previous) {
            previous = await inspectBaseline(await repository.baselineBytes(snapshot.source.revision), snapshot.documents);
            if (previous.sha256 !== snapshot.baseline.sha256) throw new PanelError(409, 'Obecna baza nie zgadza sie z manifestem.');
            await this.ctx.storage.put(cacheKey, previous);
          }
          compareBaselineCoverage(summary, previous);
          if (action === 'baselineCheck') return { status: 200, body: { summary, sourceRevision: snapshot.source.revision, previousSha256: snapshot.baseline.sha256 } };
          if (input.sourceRevision !== snapshot.source.revision || input.previousSha256 !== snapshot.baseline.sha256 || input.checkedSha256 !== summary.sha256) throw new PanelError(409, 'Konfiguracja lub wybrany plik zmienily sie. Sprawdz plik ponownie.');
          const approvedAt = new Date().toISOString();
          const receipt = await repository.publishBaseline({ input, summary, snapshot, approvedAt });
          await this.ctx.storage.put(cacheKey.replace(snapshot.baseline.sha256, summary.sha256), summary);
          await this.ctx.storage.put(`baseline-audit:${receipt.revision}`, { ...receipt, actor, approvedAt, filename: input.filename });
          return { status: 200, body: receipt };
        }
        const store = new PrivateWorkspaceStore(this.ctx.storage, repository);
        const service = new WorkspaceService(store);
        const methods = { workspace: 'workspace', draft: 'save', preview: 'requestPreview', publish: 'publish', rollback: 'rollback' };
        if (!Object.hasOwn(methods, action)) throw new PanelError(404, 'Nieznana operacja.');
        const body = await service[methods[action]](input, actor);
        return { status: 200, body };
      } catch (error) {
        if (!(error instanceof PanelError)) console.error(JSON.stringify({ event: 'workspace_operation_failed', action, errorType: error.name, frames: error.stack?.split('\n').slice(1, 4) }));
        return { status: error.status ?? 503, diagnostic: error.status ? undefined : { errorType: error.name, frames: error.stack?.split('\n').slice(1, 4) }, body: { error: error.status ? error.message : 'Operacja nie zostala potwierdzona. Odswiez dane przed ponowieniem.', details: error.details } };
      }
    });
    this.queue = task;
    return task;
  }
}
