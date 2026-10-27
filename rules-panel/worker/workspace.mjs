import { DurableObject } from 'cloudflare:workers';
import { WorkspaceService, PanelError } from '../server/workspace-service.mjs';
import { PrivateWorkspaceStore } from '../server/private-store.mjs';
import { GitHubRepository, githubConfigured } from './github.mjs';
import { processBaseline } from '../server/baseline-onboarding-service.mjs';
import { searchDiscovercarsLocations } from '../server/location-search.mjs';
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
        if (action === 'locationsSearch') return { status: 200, body: { candidates: await searchDiscovercarsLocations(input.query) } };
        if (action === 'reportBaselineCheck' || action === 'reportBaselinePublish') {
          const publish = action === 'reportBaselinePublish';
          if (publish && input.importConfirmed !== true) throw new PanelError(422, 'Potwierdz, ze ten plik zostal wgrany do DiscoverCars.');
          const file = await loadPublishedWorkbook({ kind: 'import', runId: input.runId, sha256: input.fileSha256 }, repository.fetcher);
          input = { ...input, ...workbookInput(file) };
          action = publish ? 'baselinePublish' : 'baselineCheck';
        }
        if (action === 'baselineCheck' || action === 'baselinePublish') {
          return { status: 200, body: await processBaseline({ repository, storage: this.ctx.storage, input, actor,
            publish: action === 'baselinePublish' }) };
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
