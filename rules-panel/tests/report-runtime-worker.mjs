import { readOperationalStatus } from '../server/reports.mjs';
import { GitHubRepository } from '../worker/github.mjs';
import { zipSync, strToU8 } from 'fflate';
import { priceFixture } from './price-fixture.mjs';

const manifest = {
  generated_at:'2026-11-03T03:34:00Z', source_started_at:'2026-11-02T17:07:00Z',
  run_id:'123', git_sha:'a'.repeat(40), status:'failure',
  quality:{blocking_alerts:['Final rates violate the city Top1 airport cap after group parity. CDMV/KRDW/2026-12-09 M: 80 > 77']},
};

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const calls = [];
    try {
      if(path==='/prices') return Response.json({result:await priceFixture(),calls});
      // Construct real Workers Requests before supplying upstream fixture responses.
      // Node-only mocks previously hid unsupported redirect modes.
      const fetcher = async (url, init) => {
        const outgoing = new Request(url, init);
        calls.push({url:outgoing.url, authorization:outgoing.headers.has('authorization')});
        if (outgoing.url.startsWith('https://prejsik.github.io/')) {
          return path.endsWith('redirect') ? Response.redirect('https://unexpected.example/report',302) : Response.json(manifest);
        }
        if (outgoing.url.endsWith('/actions/runs/123')) return Response.json({id:123,path:'.github/workflows/discovercars-daily.yml',head_sha:'a'.repeat(40)});
        if (outgoing.url.includes('/artifacts?')) return Response.json({artifacts:[{id:456,name:'discovercars-results-1',size_in_bytes:1024,expired:false}]});
        if (outgoing.url.endsWith('/actions/artifacts/456/zip')) return Response.redirect('https://test.blob.core.windows.net/archive',302);
        if (outgoing.url === 'https://test.blob.core.windows.net/archive') {
          return path.endsWith('redirect') ? Response.redirect('https://unexpected.example/archive',302)
            : new Response(zipSync({'run-manifest.json':strToU8(JSON.stringify(manifest))}));
        }
        throw new Error('Unexpected upstream request');
      };
      if (path.startsWith('/status')) return Response.json({result:await readOperationalStatus({},fetcher),calls});
      const repository = new GitHubRepository({}, {fetcher});
      repository.token = async () => 'fixture-token';
      return Response.json({result:await repository.runIncident('123'),calls});
    } catch(error) {
      return Response.json({error:error.message,calls},{status:500});
    }
  },
};
