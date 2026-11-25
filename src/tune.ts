/**
 * Remote tuning sessions: a job queue between someone tuning the machine from elsewhere (Claude,
 * via curl) and the rig phone on /tune.html, which holds the Bluetooth connection and the camera.
 *
 * The phone is the only thing that touches the machine. This module only passes jobs one way and
 * results the other, and the phone re-checks every job against its own limits (cards per test,
 * the motion guardrail in x1pro-run.js) — so a leaked token can at most queue the experiments
 * the phone would run anyway, while someone stands at the rig.
 *
 * Deliberately in memory: a session lasts one sitting at the rig. A redeploy ends it, and the
 * phone just starts a new one.
 */
import crypto from 'crypto';

export type TuneJobType = 'probe' | 'test';
export type TuneJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface TuneJob {
  id: number;
  type: TuneJobType;
  params: Record<string, unknown>;
  status: TuneJobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  progress: unknown;
  result: unknown;
  error: string | null;
  photos: number;
  /** Set on a running job: the phone finishes the card in hand, then reports it as cancelled. */
  cancelRequested: boolean;
}

interface TuneSession {
  token: string;
  createdAt: number;
  lastActivity: number;
  phone: { lastSeen: number; state: unknown } | null;
  jobs: TuneJob[];
  nextJobId: number;
  photos: Map<string, Buffer>;  // `${jobId}/${idx}`
}

export const MAX_TEST_CARDS = 20;
const MAX_SESSIONS = 4;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_PHOTOS = 400;        // ~25 KB each at the size the phone sends
const MAX_PHOTO_BYTES = 300 * 1024;

const sessions = new Map<string, TuneSession>();

function prune(): void {
  const now = Date.now();
  for (const [t, s] of sessions) if (now - s.lastActivity > SESSION_IDLE_MS) sessions.delete(t);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.lastActivity - b.lastActivity)[0];
    sessions.delete(oldest.token);
  }
}

export function createTuneSession(): string {
  const token = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  sessions.set(token, { token, createdAt: now, lastActivity: now, phone: null, jobs: [], nextJobId: 1, photos: new Map() });
  prune();
  return token;
}

/** Constant-time lookup, so the token can't be guessed a character at a time from timings. */
export function getTuneSession(token: unknown): TuneSession | null {
  if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) return null;
  const want = Buffer.from(token);
  for (const s of sessions.values()) {
    if (crypto.timingSafeEqual(Buffer.from(s.token), want)) { s.lastActivity = Date.now(); return s; }
  }
  return null;
}

/** Shape check only. The phone owns the real limits, because only it knows the saved profile. */
export function validateTuneJob(type: unknown, params: unknown): string | null {
  if (type !== 'probe' && type !== 'test') return "type must be 'probe' or 'test'";
  const p = (params ?? {}) as Record<string, unknown>;
  if (typeof p !== 'object' || Array.isArray(p)) return 'params must be an object';
  if (type === 'test') {
    const cards = p.cards;
    if (!Number.isInteger(cards) || (cards as number) < 1 || (cards as number) > MAX_TEST_CARDS) return `cards must be 1-${MAX_TEST_CARDS}`;
    if (p.motion !== undefined) {
      if (typeof p.motion !== 'object' || p.motion === null || Array.isArray(p.motion)) return 'motion must be an object';
      for (const [k, v] of Object.entries(p.motion)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return `motion.${k} must be a number`;
      }
    }
    if (p.label !== undefined && typeof p.label !== 'string') return 'label must be a string';
  }
  return null;
}

export function addTuneJob(s: TuneSession, type: TuneJobType, params: Record<string, unknown>): TuneJob {
  const job: TuneJob = {
    id: s.nextJobId++, type, params, status: 'queued', createdAt: Date.now(),
    startedAt: null, finishedAt: null, progress: null, result: null, error: null, photos: 0,
    cancelRequested: false,
  };
  s.jobs.push(job);
  return job;
}

export function getTuneJob(s: TuneSession, id: number): TuneJob | undefined {
  return s.jobs.find((j) => j.id === id);
}

/** Phone heartbeat. Hands out the oldest queued job unless the phone is paused or busy. */
export function pollTune(s: TuneSession, state: { paused?: boolean; ready?: boolean } & Record<string, unknown>): TuneJob | null {
  s.phone = { lastSeen: Date.now(), state };
  // A job "running" that the phone isn't working on means the page was reloaded mid-job.
  // Close it out, or it would block the queue for good.
  for (const j of s.jobs) {
    if (j.status === 'running' && state.jobId !== j.id) finishTuneJob(j, 'failed', null, 'the phone page restarted during this job');
  }
  if (state.paused || !state.ready) return null;
  if (s.jobs.some((j) => j.status === 'running')) return null;
  const next = s.jobs.find((j) => j.status === 'queued');
  if (!next) return null;
  next.status = 'running';
  next.startedAt = Date.now();
  return next;
}

export function finishTuneJob(job: TuneJob, status: 'done' | 'failed' | 'cancelled', result: unknown, error: string | null): void {
  if (job.status !== 'running') return;
  job.status = job.cancelRequested && status === 'done' ? 'cancelled' : status;
  job.result = result ?? null;
  job.error = error;
  job.finishedAt = Date.now();
}

/** A queued job is dropped at once. A running one keeps running until the phone has routed the
 *  card in hand and reported back, so its partial results aren't lost. */
export function cancelTuneJob(job: TuneJob): void {
  if (job.status === 'queued') { job.status = 'cancelled'; job.finishedAt = Date.now(); }
  if (job.status === 'running') job.cancelRequested = true;
}

export function putTunePhoto(s: TuneSession, job: TuneJob, idx: number, jpeg: Buffer): string | null {
  if (!Number.isInteger(idx) || idx < 0 || idx > MAX_TEST_CARDS) return 'bad photo index';
  if (jpeg.length === 0 || jpeg.length > MAX_PHOTO_BYTES) return 'photo missing or too large';
  if (s.photos.size >= MAX_PHOTOS) {
    // Oldest first: Map keeps insertion order.
    s.photos.delete(s.photos.keys().next().value as string);
  }
  s.photos.set(`${job.id}/${idx}`, jpeg);
  job.photos = Math.max(job.photos, idx + 1);
  return null;
}

export function getTunePhoto(s: TuneSession, jobId: number, idx: number): Buffer | undefined {
  return s.photos.get(`${jobId}/${idx}`);
}

export function tuneState(s: TuneSession) {
  return {
    createdAt: s.createdAt,
    phone: s.phone ? { ...s.phone, secondsSinceSeen: Math.round((Date.now() - s.phone.lastSeen) / 1000) } : null,
    jobs: s.jobs,
  };
}
