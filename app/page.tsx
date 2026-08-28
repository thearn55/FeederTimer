'use client';

import { useEffect, useMemo, useState } from 'react';

type Side = 'left' | 'right';
type Feed = { id: string; side: Side; startedAt: number; endedAt: number; duration: number };
type Active = { side: Side; startedAt: number } | null;
const FEEDS_KEY = 'latch-feeds-v1';
const ACTIVE_KEY = 'latch-active-v1';

function clock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600), mins = Math.floor((safe % 3600) / 60), secs = safe % 60;
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}
function durationLabel(seconds: number) {
  const mins = Math.floor(seconds / 60), secs = seconds % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
}
function isToday(timestamp: number) { return new Date(timestamp).toDateString() === new Date().toDateString(); }

export default function Home() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [active, setActive] = useState<Active>(null);
  const [now, setNow] = useState(Date.now());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      setFeeds(JSON.parse(localStorage.getItem(FEEDS_KEY) || '[]'));
      setActive(JSON.parse(localStorage.getItem(ACTIVE_KEY) || 'null'));
    } catch { /* Ignore damaged local data. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(FEEDS_KEY, JSON.stringify(feeds));
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(active)); else localStorage.removeItem(ACTIVE_KEY);
  }, [feeds, active, ready]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsed = active ? Math.floor((now - active.startedAt) / 1000) : 0;
  const today = useMemo(() => feeds.filter((feed) => isToday(feed.startedAt)), [feeds]);
  const totals = useMemo(() => ({
    left: today.filter((f) => f.side === 'left').reduce((sum, f) => sum + f.duration, 0),
    right: today.filter((f) => f.side === 'right').reduce((sum, f) => sum + f.duration, 0),
  }), [today]);

  function saveCurrent(timestamp: number) {
    if (!active) return;
    const duration = Math.max(1, Math.floor((timestamp - active.startedAt) / 1000));
    setFeeds((current) => [{ id: crypto.randomUUID(), side: active.side, startedAt: active.startedAt, endedAt: timestamp, duration }, ...current]);
  }
  function chooseSide(side: Side) {
    const timestamp = Date.now();
    if (active?.side === side) { saveCurrent(timestamp); setActive(null); return; }
    if (active) saveCurrent(timestamp);
    setNow(timestamp); setActive({ side, startedAt: timestamp });
  }
  function stop() { if (active) { saveCurrent(Date.now()); setActive(null); } }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">L</div>
        <div><h1>Latch</h1><p>Simple feeding timer</p></div>
        <span className="privacy-pill">Private on this device</span>
      </header>

      <section className="hero" aria-labelledby="timer-heading">
        <div className="eyebrow">Current feed</div>
        <h2 id="timer-heading">{active ? `${active.side === 'left' ? 'Left' : 'Right'} side` : 'Ready when you are'}</h2>
        <div className={`timer ${active ? 'running' : ''}`} aria-live="polite">{clock(elapsed)}</div>
        <p className="started-time">{active ? `Started at ${new Date(active.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Tap a side to start. The time is logged automatically.'}</p>
        <div className="side-buttons">
          <button className={`side-button left ${active?.side === 'left' ? 'active' : ''}`} onClick={() => chooseSide('left')}>
            <span className="side-letter">L</span><span>{active?.side === 'left' ? 'Tap to finish' : active ? 'Switch to left' : 'Start left'}</span>
          </button>
          <button className={`side-button right ${active?.side === 'right' ? 'active' : ''}`} onClick={() => chooseSide('right')}>
            <span className="side-letter">R</span><span>{active?.side === 'right' ? 'Tap to finish' : active ? 'Switch to right' : 'Start right'}</span>
          </button>
        </div>
        {active && <button className="stop-button" onClick={stop}>Finish feeding</button>}
      </section>

      <section className="today" aria-labelledby="today-heading">
        <div className="section-heading"><div><div className="eyebrow">At a glance</div><h2 id="today-heading">Today</h2></div><strong>{today.length} {today.length === 1 ? 'feed' : 'feeds'}</strong></div>
        <div className="summary-grid">
          <article><span className="dot left-dot" />Left<strong>{durationLabel(totals.left)}</strong></article>
          <article><span className="dot right-dot" />Right<strong>{durationLabel(totals.right)}</strong></article>
          <article><span className="dot total-dot" />Total<strong>{durationLabel(totals.left + totals.right)}</strong></article>
        </div>
      </section>

      <section className="history" aria-labelledby="history-heading">
        <div className="section-heading"><div><div className="eyebrow">Saved automatically</div><h2 id="history-heading">Recent feeds</h2></div></div>
        {!feeds.length ? <div className="empty-state"><span>◷</span><p>Your feeding history will appear here.</p></div> : (
          <div className="feed-list">{feeds.slice(0, 30).map((feed) => (
            <article className="feed-row" key={feed.id}>
              <div className={`feed-icon ${feed.side}`}>{feed.side === 'left' ? 'L' : 'R'}</div>
              <div className="feed-main"><strong>{feed.side === 'left' ? 'Left side' : 'Right side'}</strong><span>{new Date(feed.startedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} · {new Date(feed.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
              <strong className="feed-duration">{durationLabel(feed.duration)}</strong>
              <button className="delete-button" aria-label={`Delete ${feed.side} feed`} onClick={() => setFeeds((current) => current.filter((item) => item.id !== feed.id))}>×</button>
            </article>
          ))}</div>
        )}
      </section>
      <footer>Free, simple, and made for sleepy moments.</footer>
    </main>
  );
}
