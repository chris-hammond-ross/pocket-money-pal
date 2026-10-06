import {
  accessInfoSchema,
  adjustmentSchema,
  approvalSchema,
  choreLibrarySchema,
  choreListSchema,
  choreSchema,
  claimResultSchema,
  dayPlanSchema,
  deviceListSchema,
  deviceMeSchema,
  devClockSchema,
  factoryResetResultSchema,
  familySettingsSchema,
  gameMasterListSchema,
  goalMoveResultSchema,
  healthSchema,
  kioskTodaySchema,
  moneyOverviewSchema,
  pairCheckResultSchema,
  pairingInviteSchema,
  paydaySummarySchema,
  playerCardSchema,
  playerListSchema,
  pushKeySchema,
  removedPlayerSchema,
  savingsBookSchema,
  setupDraftResponseSchema,
  setupKioskInfoSchema,
  setupResultSchema,
  setupStatusSchema,
  surpriseRunSchema,
  surpriseTaskListSchema,
  surpriseTaskSchema,
  surpriseTodaySchema,
  trayListSchema,
  type Grab,
  type ChildInput,
  type ChildPatch,
  type ChoreCreate,
  type ChoreLibraryItem,
  type ChorePatch,
  type ClaimRequest,
  type ClaimResult,
  type EnvelopeCreate,
  type GoalCreate,
  type GoalPatch,
  type KioskToday,
  type PhoneSettingsPatch,
  type SchedulePause,
  type PingRequest,
  type SendBackReason,
  type SetupDraft,
  type SetupRequestInput,
  type SpendInput,
  type SurpriseSend,
  type SurpriseTaskInput,
  type SurpriseTaskPatch,
} from '@pmp/shared';
import { noteReachable, noteUnreachable } from './offline';
import { setupTokenHeaders } from './setup-token';

/** A failed API call, keeping the status and the server's `error` code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A request to the PC. Not reaching it at all (it's off, or the phone is off the home
 * network) is an `ApiError` with status 0 and code `offline`, and is noted for the offline
 * queue (spec 007); any answer at all means it's on.
 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { ...(init?.body && { 'content-type': 'application/json' }), ...init?.headers },
    });
  } catch {
    noteUnreachable();
    throw new ApiError(0, 'offline', `${init?.method ?? 'GET'} ${path}: can't reach the PC`);
  }
  noteReachable(res.headers.get('date'));
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof body?.error === 'string' ? body.error : null;
    throw new ApiError(res.status, code, `${init?.method ?? 'GET'} ${path} failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const json = (method: string, body: unknown, headers?: HeadersInit): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers,
});

/**
 * Extra request options for a change that can wait in the offline queue (spec 007): its
 * `Idempotency-Key`, and a timeout so an unreachable PC is noticed quickly.
 */
export interface QueueableInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** The kiosk board, plus how far this browser's clock is from the server's. */
export type KioskBoard = KioskToday & { clockOffsetMs: number };

export const api = {
  health: async () => healthSchema.parse(await request('/api/health')),
  settings: async () => familySettingsSchema.parse(await request('/api/settings')),
  ping: (body: PingRequest) => request('/api/ping', json('POST', body)),

  setupStatus: async () => setupStatusSchema.parse(await request('/api/setup/status')),
  setupKiosk: async () => setupKioskInfoSchema.parse(await request('/api/setup/kiosk')),
  setupDraft: async () =>
    setupDraftResponseSchema.parse(
      await request('/api/setup/draft', { headers: setupTokenHeaders() }),
    ).draft,
  saveSetupDraft: (draft: SetupDraft) =>
    request('/api/setup/draft', json('PUT', draft, setupTokenHeaders())),
  finishSetup: async (body: SetupRequestInput) =>
    setupResultSchema.parse(await request('/api/setup', json('POST', body, setupTokenHeaders()))),
  choreLibrary: async (): Promise<ChoreLibraryItem[]> =>
    choreLibrarySchema.parse(await request('/api/chore-library')),

  /**
   * The kiosk board. The server's clock is the truth: `clockOffsetMs` is its reading
   * minus this browser's clock at the middle of the round trip.
   */
  kioskToday: async (): Promise<KioskBoard> => {
    const sent = Date.now();
    const board = kioskTodaySchema.parse(await request('/api/kiosk/today'));
    const received = Date.now();
    return { ...board, clockOffsetMs: board.serverNow - (sent + received) / 2 };
  },

  /** A child claims a quest. Refusals come back as an `ApiError` with the server's code. */
  claim: async (instanceId: number, body: ClaimRequest): Promise<ClaimResult> =>
    claimResultSchema.parse(
      await request(`/api/instances/${instanceId}/claim`, json('POST', body)),
    ),

  /** Development only: move the server's clock ("18:40"), or put it back (null). */
  setDevClock: async (at: string | null) =>
    devClockSchema.parse(await request('/api/dev/clock', json('PUT', { at }))),

  /** The parent this device is paired to, or null when it isn't (or was revoked). */
  deviceMe: async () => {
    try {
      return deviceMeSchema.parse(await request('/api/devices/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },

  // Pairing (ADR 0008)
  devices: async () => deviceListSchema.parse(await request('/api/devices')),
  revokeDevice: (id: number) => request(`/api/devices/${id}`, { method: 'DELETE' }),
  /** Wipes the family back to a fresh install (ADR 0014): `confirm` is the typed word. */
  factoryReset: async (confirm: string) =>
    factoryResetResultSchema.parse(await request('/api/factory-reset', json('POST', { confirm }))),
  /** A pairing code for another phone, or with `move` for this phone's HTTPS address. */
  invite: async (move = false) =>
    pairingInviteSchema.parse(await request('/api/devices/invites', json('POST', { move }))),
  /** The PC's code for the kiosk's pairing card; null when no card should show. */
  pcInvite: async () => {
    try {
      return pairingInviteSchema.parse(await request('/api/devices/pc-invite'));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 403)) return null;
      throw err;
    }
  },
  checkPairingCode: async (code: string) =>
    pairCheckResultSchema.parse(await request('/api/devices/pair/check', json('POST', { code }))),
  pair: async (code: string, parentId: number) =>
    deviceMeSchema.parse(await request('/api/devices/pair', json('POST', { code, parentId }))),

  // The phone's tray and chore actions (spec 003)
  claimed: async () => trayListSchema.parse(await request('/api/instances/claimed')),
  approve: async (items: { id: number }[]) => {
    const body = (await request('/api/instances/approve', json('POST', { items }))) as {
      approvals: unknown[];
    };
    return body.approvals.map((a) => approvalSchema.parse(a));
  },
  sendBack: (id: number, reason: SendBackReason) =>
    request(`/api/instances/${id}/send-back`, json('POST', { reason })),
  markDone: (id: number) => request(`/api/instances/${id}/mark-done`, { method: 'POST' }),
  undoApproval: (id: number) => request(`/api/instances/${id}/undo-approval`, { method: 'POST' }),

  /** A day on the phone's Day tab; `'today'` for today in the family time zone. */
  day: async (date: string) => dayPlanSchema.parse(await request(`/api/day/${date}`)),
  chores: async () => choreListSchema.parse(await request('/api/chores')),
  createChore: async (chore: ChoreCreate, init?: QueueableInit) =>
    choreSchema.parse(
      await request('/api/chores', { ...json('POST', chore, init?.headers), signal: init?.signal }),
    ),
  updateChore: async (id: number, patch: ChorePatch, init?: QueueableInit) =>
    choreSchema.parse(
      await request(`/api/chores/${id}`, {
        ...json('PATCH', patch, init?.headers),
        signal: init?.signal,
      }),
    ),
  deleteChore: (id: number, init?: QueueableInit) =>
    request(`/api/chores/${id}`, { method: 'DELETE', ...init }),
  skipToday: (id: number, skip: boolean) =>
    request(`/api/chores/${id}/skip-today`, { method: skip ? 'POST' : 'DELETE' }),

  // The Players tab (spec 003, ADR 0009)
  players: async () => playerListSchema.parse(await request('/api/children')),
  gameMasters: async () => gameMasterListSchema.parse(await request('/api/parents')),
  createPlayer: async (child: ChildInput) =>
    playerCardSchema.parse(await request('/api/children', json('POST', child))),
  updatePlayer: async (id: number, patch: ChildPatch) =>
    playerCardSchema.parse(await request(`/api/children/${id}`, json('PATCH', patch))),
  removePlayer: async (id: number) =>
    removedPlayerSchema.parse(await request(`/api/children/${id}`, { method: 'DELETE' })),
  sickToday: async (id: number, sick: boolean) =>
    playerCardSchema.parse(
      await request(`/api/children/${id}/sick-today`, { method: sick ? 'POST' : 'DELETE' }),
    ),
  adjustPoints: async (id: number, points: number) =>
    adjustmentSchema.parse(await request(`/api/children/${id}/adjust`, json('POST', { points }))),
  updateSettings: async (patch: PhoneSettingsPatch) =>
    familySettingsSchema.parse(await request('/api/settings', json('PATCH', patch))),
  /** The holiday pause (ADR 0016): set or change it, or null to resume right now. */
  setPause: async (pause: SchedulePause | null, init?: QueueableInit) =>
    familySettingsSchema.parse(
      await request('/api/pause', {
        ...(pause === null ? { method: 'DELETE' } : json('PUT', pause)),
        ...init,
      }),
    ),

  // Money and jars (spec 004)
  money: async () => moneyOverviewSchema.parse(await request('/api/money')),
  savings: async (childId: number) =>
    savingsBookSchema.parse(await request(`/api/children/${childId}/savings`)),
  /** The latest payday's summary for the show, or null before the first. */
  latestPayday: async () => {
    try {
      return paydaySummarySchema.parse(await request('/api/paydays/latest'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
  createGoal: async (goal: GoalCreate) =>
    (await request('/api/goals', json('POST', goal))) as { id: number },
  updateGoal: (id: number, patch: GoalPatch) => request(`/api/goals/${id}`, json('PATCH', patch)),
  deleteGoal: (id: number) => request(`/api/goals/${id}`, { method: 'DELETE' }),
  moveGoal: async (id: number, cents: number) =>
    goalMoveResultSchema.parse(await request(`/api/goals/${id}/move`, json('POST', { cents }))),
  smashGoal: (id: number) => request(`/api/goals/${id}/smash`, { method: 'POST' }),
  unsmashGoal: (id: number) => request(`/api/goals/${id}/smash`, { method: 'DELETE' }),
  buyGoal: (id: number) => request(`/api/goals/${id}/bought`, { method: 'POST' }),
  sendEnvelope: (childId: number, body: EnvelopeCreate) =>
    request(`/api/children/${childId}/envelopes`, json('POST', body)),
  openEnvelope: (id: number) => request(`/api/envelopes/${id}/open`, { method: 'POST' }),
  spend: (childId: number, body: SpendInput) =>
    request(`/api/children/${childId}/spend`, json('POST', body)),
  startPayday: () => request('/api/paydays', { method: 'POST' }),

  // Surprise quests (spec 006)
  surpriseTasks: async () => surpriseTaskListSchema.parse(await request('/api/surprise-tasks')),
  createSurpriseTask: async (task: SurpriseTaskInput) =>
    surpriseTaskSchema.parse(await request('/api/surprise-tasks', json('POST', task))),
  updateSurpriseTask: async (id: number, patch: SurpriseTaskPatch) =>
    surpriseTaskSchema.parse(await request(`/api/surprise-tasks/${id}`, json('PATCH', patch))),
  deleteSurpriseTask: (id: number) => request(`/api/surprise-tasks/${id}`, { method: 'DELETE' }),
  surprisesToday: async () => surpriseTodaySchema.parse(await request('/api/surprises/today')),
  sendSurprise: async (body: SurpriseSend) =>
    surpriseRunSchema.parse(await request('/api/surprises', json('POST', body))),
  updateSurprise: async (id: number, body: SurpriseSend) =>
    surpriseRunSchema.parse(await request(`/api/surprises/${id}`, json('PATCH', body))),
  cancelSurprise: (id: number) => request(`/api/surprises/${id}`, { method: 'DELETE' }),
  /** The kiosk's grab. A lost race comes back as an `ApiError` with the server's code. */
  grabSurprise: (id: number, grab: Grab) =>
    request(`/api/surprises/${id}/grab`, json('POST', grab)),

  // HTTPS and push (ADR 0002, ADR 0009)
  access: async () => accessInfoSchema.parse(await request('/api/access')),
  pushKey: async () => pushKeySchema.parse(await request('/api/push/key')),
  savePushSubscription: (sub: PushSubscriptionJSON) =>
    request('/api/devices/me/push-subscription', json('POST', sub)),
  deletePushSubscription: () => request('/api/devices/me/push-subscription', { method: 'DELETE' }),
  testPush: (delaySeconds = 0) =>
    request('/api/devices/me/push-test', json('POST', { delaySeconds })),
};
