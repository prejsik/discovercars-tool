import { DurableObject } from 'cloudflare:workers';
import { WorkspaceService, PanelError } from '../server/workspace-service.mjs';
import { PrivateWorkspaceStore } from '../server/private-store.mjs';
import { GitHubRepository, githubConfigured } from './github.mjs';

// One coordination atom is one repository, shared by its authorized directors.
export class RulesWorkspace extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.queue = Promise.resolve(); }

  async handle(action, input, actor) {
    const task = this.queue.catch(() => {}).then(async () => {
      try {
        const allowed = (this.env.ACCESS_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase());
        if (!allowed.includes(actor)) throw new PanelError(403, 'Brak dostepu.');
        if (!githubConfigured(this.env)) throw new PanelError(503, 'Integracja GitHub nie jest skonfigurowana.');
        const store = new PrivateWorkspaceStore(this.ctx.storage, new GitHubRepository(this.env));
        const service = new WorkspaceService(store);
        const methods = { workspace: 'workspace', draft: 'save', preview: 'requestPreview', publish: 'publish', rollback: 'rollback' };
        if (!Object.hasOwn(methods, action)) throw new PanelError(404, 'Nieznana operacja.');
        const body = await service[methods[action]](input, actor);
        return { status: 200, body };
      } catch (error) {
        if (!(error instanceof PanelError)) console.error(JSON.stringify({ event: 'workspace_operation_failed', action }));
        return { status: error.status ?? 503, body: { error: error.status ? error.message : 'Operacja nie zostala potwierdzona. Odswiez dane przed ponowieniem.', details: error.details } };
      }
    });
    this.queue = task;
    return task;
  }
}
