'use client';

import { useEffect, useMemo, useState } from 'react';
import { connectHousehold, deleteHouseholdEntry, isFirebaseConfigured, saveHouseholdEntry, type CloudEntry } from './firebase';

type Side = 'left' | 'right';
type NursingEntry = { id:string; type:'nursing'; startedAt:number; endedAt:number; leftDuration:number; rightDuration:number };
type FormulaEntry = { id:string; type:'formula'; startedAt:number; endedAt:number; ml:number };
type FeedEntry = NursingEntry | FormulaEntry;
type Active = { startedAt:number; currentSide:Side; segmentStartedAt:number; leftDuration:number; rightDuration:number } | null;

const FEEDS_KEY = 'latch-feeds-v2';
const ACTIVE_KEY = 'latch-active-v2';
const HOUSEHOLD_KEY = 'latch-household-v1';

function clock(seconds:number) {
  const safe=Math.max(0,Math.floor(seconds)); const h=Math.floor(safe/3600),m=Math.floor((safe%3600)/60),s=safe%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function durationLabel(seconds:number) { const m=Math.floor(seconds/60),s=seconds%60; return m ? `${m}m ${s}s` : `${s}s`; }
function isToday(timestamp:number) { return new Date(timestamp).toDateString()===new Date().toDateString(); }
function newCode() { return Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n%32]).join(''); }

export default function Home() {
  const [entries,setEntries]=useState<FeedEntry[]>([]);
  const [active,setActive]=useState<Active>(null);
  const [now,setNow]=useState(Date.now());
  const [ready,setReady]=useState(false);
  const [formulaMl,setFormulaMl]=useState('');
  const [household,setHousehold]=useState('');
  const [codeInput,setCodeInput]=useState('');
  const [syncState,setSyncState]=useState<'local'|'connecting'|'synced'|'error'>('local');
  const [showSync,setShowSync]=useState(false);

  useEffect(()=>{
    try { setEntries(JSON.parse(localStorage.getItem(FEEDS_KEY)||'[]')); setActive(JSON.parse(localStorage.getItem(ACTIVE_KEY)||'null')); setHousehold(localStorage.getItem(HOUSEHOLD_KEY)||''); } catch { /* Ignore damaged local data. */ }
    setReady(true);
  },[]);
  useEffect(()=>{ if(!ready)return; localStorage.setItem(FEEDS_KEY,JSON.stringify(entries)); if(active)localStorage.setItem(ACTIVE_KEY,JSON.stringify(active));else localStorage.removeItem(ACTIVE_KEY); },[entries,active,ready]);
  useEffect(()=>{ if(!active)return; const timer=window.setInterval(()=>setNow(Date.now()),1000); return()=>window.clearInterval(timer); },[active]);
  useEffect(()=>{
    if(!ready||!household||!isFirebaseConfigured())return;
    setSyncState('connecting'); let unsubscribe:(()=>void)|undefined;
    const localEntries=entries;
    connectHousehold(household,(cloud)=>{
      if(!cloud.length&&localEntries.length) {
        Promise.all(localEntries.map(entry=>saveHouseholdEntry(household,entry as unknown as CloudEntry))).catch(()=>setSyncState('error'));
        return;
      }
      setEntries(cloud as FeedEntry[]); setSyncState('synced');
    }).then((stop)=>{unsubscribe=stop;}).catch(()=>setSyncState('error'));
    return()=>unsubscribe?.();
  },[household,ready]);

  const liveLeft=active ? active.leftDuration+(active.currentSide==='left'?Math.floor((now-active.segmentStartedAt)/1000):0) : 0;
  const liveRight=active ? active.rightDuration+(active.currentSide==='right'?Math.floor((now-active.segmentStartedAt)/1000):0) : 0;
  const today=useMemo(()=>entries.filter(e=>isToday(e.startedAt)),[entries]);
  const totals=useMemo(()=>({
    left:today.filter((e):e is NursingEntry=>e.type==='nursing').reduce((n,e)=>n+e.leftDuration,0),
    right:today.filter((e):e is NursingEntry=>e.type==='nursing').reduce((n,e)=>n+e.rightDuration,0),
    formula:today.filter((e):e is FormulaEntry=>e.type==='formula').reduce((n,e)=>n+e.ml,0),
  }),[today]);

  async function persist(entry:FeedEntry) {
    setEntries(current=>[entry,...current.filter(item=>item.id!==entry.id)]);
    if(household&&isFirebaseConfigured()) try { await saveHouseholdEntry(household,entry as unknown as CloudEntry); } catch { setSyncState('error'); }
  }
  function chooseSide(side:Side) {
    const timestamp=Date.now(); setNow(timestamp);
    if(!active) { setActive({startedAt:timestamp,currentSide:side,segmentStartedAt:timestamp,leftDuration:0,rightDuration:0}); return; }
    if(active.currentSide===side)return;
    const segment=Math.max(0,Math.floor((timestamp-active.segmentStartedAt)/1000));
    setActive({...active,currentSide:side,segmentStartedAt:timestamp,leftDuration:active.leftDuration+(active.currentSide==='left'?segment:0),rightDuration:active.rightDuration+(active.currentSide==='right'?segment:0)});
  }
  function finish() {
    if(!active)return; const timestamp=Date.now(),segment=Math.max(1,Math.floor((timestamp-active.segmentStartedAt)/1000));
    const entry:NursingEntry={id:crypto.randomUUID(),type:'nursing',startedAt:active.startedAt,endedAt:timestamp,leftDuration:active.leftDuration+(active.currentSide==='left'?segment:0),rightDuration:active.rightDuration+(active.currentSide==='right'?segment:0)};
    setActive(null); void persist(entry);
  }
  function addFormula() {
    const ml=Math.round(Number(formulaMl)); if(!ml||ml<1)return; const timestamp=Date.now();
    void persist({id:crypto.randomUUID(),type:'formula',startedAt:timestamp,endedAt:timestamp,ml}); setFormulaMl('');
  }
  async function removeEntry(id:string) {
    setEntries(current=>current.filter(e=>e.id!==id));
    if(household&&isFirebaseConfigured()) try { await deleteHouseholdEntry(household,id); } catch { setSyncState('error'); }
  }
  function joinHousehold(code:string) {
    const clean=code.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,8); if(clean.length!==8)return;
    localStorage.setItem(HOUSEHOLD_KEY,clean); setHousehold(clean); setCodeInput('');
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand-mark" aria-hidden="true">L</div><div><h1>Latch</h1><p>Simple feeding timer</p></div><button className={`sync-pill ${syncState}`} onClick={()=>setShowSync(!showSync)}>{household ? (syncState==='synced'?'● Synced':'Household') : 'Connect household'}</button></header>

    {showSync&&<section className="sync-card">
      <div><div className="eyebrow">Shared family log</div><h2>{household?'Household connected':'Keep both phones in sync'}</h2></div>
      {!isFirebaseConfigured()?<p className="setup-note">Firebase setup is needed before syncing can be turned on. The timer still works locally.</p>:household?<div className="household-code"><span>Your household code</span><strong>{household}</strong><button onClick={()=>navigator.clipboard.writeText(household)}>Copy</button></div>:<><p>Create a private code, or enter the code shown on your partner’s phone.</p><div className="code-actions"><button onClick={()=>joinHousehold(newCode())}>Create household</button><input value={codeInput} onChange={e=>setCodeInput(e.target.value)} placeholder="8-character code" aria-label="Household code"/><button onClick={()=>joinHousehold(codeInput)}>Join</button></div></>}
    </section>}

    <section className="hero" aria-labelledby="timer-heading"><div className="eyebrow">Current feed</div><h2 id="timer-heading">{active?`${active.currentSide==='left'?'Left':'Right'} side`:'Ready when you are'}</h2><div className={`timer ${active?'running':''}`} aria-live="polite">{clock(liveLeft+liveRight)}</div><p className="started-time">{active?`Started at ${new Date(active.startedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} · Nothing logs until you finish`:'Tap a side to begin. Switch sides anytime.'}</p>
      {active&&<div className="live-split"><span>Left <strong>{clock(liveLeft)}</strong></span><span>Right <strong>{clock(liveRight)}</strong></span></div>}
      <div className="side-buttons"><button className={`side-button left ${active?.currentSide==='left'?'active':''}`} onClick={()=>chooseSide('left')}><span className="side-letter">L</span><span>{active?.currentSide==='left'?'Timing left':active?'Switch to left':'Start left'}</span></button><button className={`side-button right ${active?.currentSide==='right'?'active':''}`} onClick={()=>chooseSide('right')}><span className="side-letter">R</span><span>{active?.currentSide==='right'?'Timing right':active?'Switch to right':'Start right'}</span></button></div>
      {active&&<button className="finish-button" onClick={finish}>Finish & save feeding</button>}
    </section>

    <section className="formula-card"><div><div className="eyebrow">Bottle feeding</div><h2>Add formula</h2><p>Record the amount when you use formula instead.</p></div><div className="formula-input"><input type="number" min="1" inputMode="numeric" value={formulaMl} onChange={e=>setFormulaMl(e.target.value)} placeholder="0" aria-label="Formula amount in milliliters"/><span>mL</span><button onClick={addFormula} disabled={!Number(formulaMl)}>Add bottle</button></div></section>

    <section className="today" aria-labelledby="today-heading"><div className="section-heading"><div><div className="eyebrow">At a glance</div><h2 id="today-heading">Today</h2></div><strong>{today.length} {today.length===1?'entry':'entries'}</strong></div><div className="summary-grid four"><article><span className="dot left-dot"/>Left<strong>{durationLabel(totals.left)}</strong></article><article><span className="dot right-dot"/>Right<strong>{durationLabel(totals.right)}</strong></article><article><span className="dot formula-dot"/>Formula<strong>{totals.formula} mL</strong></article><article><span className="dot total-dot"/>Total<strong>{today.length}</strong></article></div></section>

    <section className="history" aria-labelledby="history-heading"><div className="section-heading"><div><div className="eyebrow">Saved after finishing</div><h2 id="history-heading">Recent feeds</h2></div></div>{!entries.length?<div className="empty-state"><span>◷</span><p>Your feeding history will appear here.</p></div>:<div className="feed-list">{entries.slice(0,30).map(entry=><article className="feed-row" key={entry.id}><div className={`feed-icon ${entry.type}`}>{entry.type==='formula'?'mL':'B'}</div><div className="feed-main"><strong>{entry.type==='formula'?`Formula bottle · ${entry.ml} mL`:'Breastfeeding'}</strong><span>{new Date(entry.startedAt).toLocaleDateString([],{month:'short',day:'numeric'})} · {new Date(entry.startedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}{entry.type==='nursing'?` · L ${durationLabel(entry.leftDuration)} · R ${durationLabel(entry.rightDuration)}`:''}</span></div><strong className="feed-duration">{entry.type==='formula'?`${entry.ml} mL`:durationLabel(entry.leftDuration+entry.rightDuration)}</strong><button className="delete-button" aria-label="Delete feeding entry" onClick={()=>void removeEntry(entry.id)}>×</button></article>)}</div>}</section>
    <footer>Free, simple, and made for sleepy moments.</footer>
  </main>;
}
