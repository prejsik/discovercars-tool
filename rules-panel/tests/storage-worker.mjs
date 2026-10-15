import { DurableObject } from 'cloudflare:workers';
import { PrivateWorkspaceStore } from '../server/private-store.mjs';
export class StorageProbe extends DurableObject {
  async read() { return new PrivateWorkspaceStore(this.ctx.storage, {}).draft(); }
  async save(input) {
    try {
      const store = new PrivateWorkspaceStore(this.ctx.storage, {});
      return { status: 200, draft: await store.saveDraft({ model: { amount: input.amount }, savedBy: 'runtime-test', reason: 'test', savedAt: new Date().toISOString() }, input.expectedRevision) };
    } catch (error) { return { status: error.status ?? 500 }; }
  }
}
export default {
  async fetch(request, env) {
    const name = new URL(request.url).searchParams.get('name') ?? 'one';
    const object = env.PROBE.getByName(name);
    return Response.json(request.method === 'POST' ? await object.save(await request.json()) : await object.read());
  },
};
