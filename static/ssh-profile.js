export const profileKey = '360ya-explorer.sftp.v1';
const encoder = new TextEncoder();
const kdfIterations = 600000;
const toBase64 = bytes => btoa(Array.from(new Uint8Array(bytes),byte => String.fromCharCode(byte)).join(''));
const fromBase64 = value => Uint8Array.from(atob(value),char => char.charCodeAt(0));

async function profileCipher(password,salt) {
  const secret = await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:kdfIterations,hash:'SHA-256'},
    secret,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

export async function encryptProfile(password,profile) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await profileCipher(password,salt);
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv},key,encoder.encode(JSON.stringify(profile)));
  return JSON.stringify({salt:toBase64(salt),iv:toBase64(iv),data:toBase64(encrypted)});
}

export async function decryptProfile(password,stored) {
  try {
    const {salt,iv,data} = JSON.parse(stored);
    const key = await profileCipher(password,fromBase64(salt));
    const clear = await crypto.subtle.decrypt({name:'AES-GCM',iv:fromBase64(iv)},key,fromBase64(data));
    return JSON.parse(new TextDecoder().decode(clear));
  } catch {
    throw new Error('No se pudo abrir la conexión guardada con esta contraseña de Explorer. Completá los datos SSH para volver a guardarla.');
  }
}

