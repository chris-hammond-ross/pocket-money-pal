import { familySettingsSchema, healthSchema, type PingRequest } from '@pmp/shared';

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  health: async () => healthSchema.parse(await request('/api/health')),
  settings: async () => familySettingsSchema.parse(await request('/api/settings')),
  ping: (body: PingRequest) => request('/api/ping', { method: 'POST', body: JSON.stringify(body) }),
};
