import { PanelError } from './workspace-service.mjs';

export async function readLimited(response, maximum = 2 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maximum) throw new PanelError(502, 'Odpowiedz zrodla jest zbyt duza.');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new PanelError(502, 'Odpowiedz zrodla jest zbyt duza.'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}
