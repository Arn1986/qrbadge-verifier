export function fromHex(value) {
  if (typeof value !== 'string' || value.length % 2 || !/^[a-fA-F0-9]+$/.test(value)) throw new Error('Invalid hex');
  return Uint8Array.from(value.match(/.{2}/g), pair => parseInt(pair, 16));
}
export function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}
export async function decodeBadge(raw, keyHex) {
  if (typeof raw !== 'string' || !/^[a-fA-F0-9]{84}$/.test(raw.trim())) return { result: 'malformed' };
  const bytes = fromHex(raw.trim());
  if (bytes[0] !== 1) return { result: 'unsupported' };
  let plaintext;
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(keyHex), 'AES-GCM', false, ['decrypt']);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(1, 13), tagLength: 128 }, key, bytes.slice(13)));
  } catch { return { result: 'cannot_verify' }; }
  if (plaintext.length !== 13) return { result: 'malformed' };
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  if (view.getUint8(4) !== 2) return { result: 'unsupported' };
  const identifier = view.getUint32(0, false);
  const startsAt = view.getUint32(5, false);
  const endsAt = view.getUint32(9, false);
  if (endsAt <= startsAt) return { result: 'malformed' };
  return { identifier, startsAt, endsAt };
}
export function timeResult(startsAt, endsAt, now) {
  if (now < startsAt) return 'not_yet_valid';
  if (now >= endsAt) return 'expired';
  return 'valid';
}
