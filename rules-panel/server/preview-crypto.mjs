const aad = new TextEncoder().encode('discovercars-rules-preview-v1');
const encode = bytes => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) text += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(text);
};
const decode = text => Uint8Array.from(atob(text), character => character.charCodeAt(0));

async function importKey(secret) {
  const bytes = decode(secret ?? '');
  if (bytes.length !== 32) throw new Error('A 32-byte preview encryption key is required.');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptEnvelope(payload, secret, maxBytes = 1024 * 1024) {
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  if (plain.length > maxBytes) throw new Error('Preview payload too large.');
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
  const envelope = new Uint8Array(12 + cipher.length);
  envelope.set(iv); envelope.set(cipher, 12);
  return encode(envelope);
}

export async function decryptEnvelope(encoded, secret, maxBytes = 1024 * 1024) {
  if (typeof encoded !== 'string' || encoded.length > Math.ceil((maxBytes + 28) / 3) * 4) throw new Error('Invalid preview envelope size.');
  const envelope = decode(encoded);
  if (envelope.length < 29) throw new Error('Invalid preview envelope.');
  const key = await importKey(secret);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: envelope.subarray(0, 12), additionalData: aad }, key, envelope.subarray(12));
  if (plain.byteLength > maxBytes) throw new Error('Preview payload too large.');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
}
