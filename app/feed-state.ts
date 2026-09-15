export type DatedFeed = { startedAt:number; endedAt:number };

export function needsDateCorrection(entry:DatedFeed, now:number) {
  return !Number.isFinite(entry.startedAt)||!Number.isFinite(entry.endedAt)||entry.startedAt>now||entry.endedAt>now||entry.endedAt<entry.startedAt;
}

export function sortFeeds<T extends DatedFeed>(entries:T[], now:number):T[] {
  return [...entries].sort((a,b)=>Number(needsDateCorrection(a,now))-Number(needsDateCorrection(b,now))||b.startedAt-a.startedAt);
}

// A device may only change the exact timer revision it last saw.
export function sameTimerRevision(current:Record<string,unknown>|null, expected:Record<string,unknown>|null) {
  if(!current||!expected)return current===expected;
  return ['startedAt','updatedAt','segmentStartedAt','currentSide','isPaused','leftDuration','rightDuration'].every(key=>current[key]===expected[key]);
}
