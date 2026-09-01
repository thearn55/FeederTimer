'use client';

import { useEffect, useMemo, useState } from 'react';
import { connectHousehold, deleteHouseholdEntry, isFirebaseConfigured, refreshHouseholdEntries, saveHouseholdEntry, type CloudEntry } from './firebase';

type Side = 'left' | 'right';
type BottleUnit = 'mL' | 'oz';
type BottleKind = 'formula' | 'breastmilk';
type NursingEntry = { id:string; type:'nursing'; startedAt:number; endedAt:number; leftDuration:number; rightDuration:number; startSide?:Side; endSide?:Side };
type FormulaEntry = { id:string; type:'formula'; startedAt:number; endedAt:number; amount?:number; unit?:BottleUnit; ml?:number; bottleKind?:BottleKind };
type FeedEntry = NursingEntry | FormulaEntry;
type ActiveSession = { startedAt:number; currentSide:Side; startSide:Side; segmentStartedAt:number; leftDuration:number; rightDuration:number; isPaused:boolean; updatedAt:number };
type Active = ActiveSession | null;
type EditDraft = { id?:string; kind:'nursing'|'bottle'; dateTime:string; leftMinutes:string; rightMinutes:string; amount:string; unit:BottleUnit; bottleKind:BottleKind };
type UndoAction = { message:string; action:()=>Promise<void> } | null;

const FEEDS_KEY = 'latch-feeds-v2';
const ACTIVE_KEY = 'latch-active-v2';
const HOUSEHOLD_KEY = 'latch-household-v1';
const REMINDER_KEY = 'latch-reminder-hours-v1';
const ACTIVE_CLOUD_ID = '_active';

function clock(seconds:number) {
  const safe=Math.max(0,Math.floor(seconds)); const h=Math.floor(safe/3600),m=Math.floor((safe%3600)/60),s=safe%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function durationLabel(seconds:number) { const m=Math.floor(seconds/60),s=seconds%60; return m ? `${m}m ${s}s` : `${s}s`; }
function isToday(timestamp:number) { return new Date(timestamp).toDateString()===new Date().toDateString(); }
function newCode() { return Array.from(crypto.getRandomValues(new Uint8Array(8)),n=>'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[n%32]).join(''); }
function sinceLabel(milliseconds:number) { const mins=Math.max(0,Math.floor(milliseconds/60000)); if(mins<1)return 'just now'; if(mins<60)return `${mins}m ago`; const hours=Math.floor(mins/60),rest=mins%60; return `${hours}h ${rest}m ago`; }
function inputDateTime(timestamp:number) { const date=new Date(timestamp-dateOffset(timestamp)); return date.toISOString().slice(0,16); }
function dateOffset(timestamp:number) { return new Date(timestamp).getTimezoneOffset()*60000; }

export default function Home() {
  const [entries,setEntries]=useState<FeedEntry[]>([]);
  const [active,setActive]=useState<Active>(null);
  const [now,setNow]=useState(Date.now());
  const [ready,setReady]=useState(false);
  const [formulaAmount,setFormulaAmount]=useState('');
  const [bottleUnit,setBottleUnit]=useState<BottleUnit>('mL');
  const [bottleKind,setBottleKind]=useState<BottleKind>('formula');
  const [household,setHousehold]=useState('');
  const [codeInput,setCodeInput]=useState('');
  const [syncState,setSyncState]=useState<'local'|'connecting'|'synced'|'error'>('local');
  const [showSync,setShowSync]=useState(false);
  const [reminderHours,setReminderHours]=useState(0);
  const [editDraft,setEditDraft]=useState<EditDraft|null>(null);
  const [undo,setUndo]=useState<UndoAction>(null);

  useEffect(()=>{
    try { setEntries(JSON.parse(localStorage.getItem(FEEDS_KEY)||'[]')); setActive(JSON.parse(localStorage.getItem(ACTIVE_KEY)||'null')); setHousehold(localStorage.getItem(HOUSEHOLD_KEY)||''); setReminderHours(Number(localStorage.getItem(REMINDER_KEY)||0)); } catch { /* Ignore damaged local data. */ }
    setReady(true);
  },[]);
  useEffect(()=>{ if(!ready)return; localStorage.setItem(FEEDS_KEY,JSON.stringify(entries)); if(active)localStorage.setItem(ACTIVE_KEY,JSON.stringify(active));else localStorage.removeItem(ACTIVE_KEY); },[entries,active,ready]);
  useEffect(()=>{ const timer=window.setInterval(()=>setNow(Date.now()),active?1000:30000); return()=>window.clearInterval(timer); },[active]);
  useEffect(()=>{ if(ready)localStorage.setItem(REMINDER_KEY,String(reminderHours)); },[reminderHours,ready]);
  useEffect(()=>{ if(!undo)return; const timer=window.setTimeout(()=>setUndo(null),7000); return()=>window.clearTimeout(timer); },[undo]);
  useEffect(()=>{
    if(!ready||!household||!isFirebaseConfigured())return;
    setSyncState('connecting'); let unsubscribe:(()=>void)|undefined;
    const localEntries=entries,localActive=active;
    connectHousehold(household,(cloud)=>{
      const cloudActive=cloud.find(item=>item.id===ACTIVE_CLOUD_ID);
      const cloudEntries=cloud.filter(item=>item.id!==ACTIVE_CLOUD_ID) as FeedEntry[];
      if(!cloudEntries.length&&localEntries.length) {
        Promise.all(localEntries.map(entry=>saveHouseholdEntry(household,entry as unknown as CloudEntry))).catch(()=>setSyncState('error'));
      }
      if(!cloudActive&&localActive) saveHouseholdEntry(household,{...localActive,id:ACTIVE_CLOUD_ID,type:'active'} as unknown as CloudEntry).catch(()=>setSyncState('error'));
      else setActive(cloudActive?cloudActive as unknown as ActiveSession:null);
      if(cloudEntries.length||!localEntries.length)setEntries(cloudEntries);
      setSyncState('synced');
    },()=>setSyncState('error')).then((stop)=>{unsubscribe=stop;}).catch(()=>setSyncState('error'));
    return()=>unsubscribe?.();
  },[household,ready]);

  const isRunning=active&&!active.isPaused;
  const liveLeft=active ? active.leftDuration+(isRunning&&active.currentSide==='left'?Math.floor((now-active.segmentStartedAt)/1000):0) : 0;
  const liveRight=active ? active.rightDuration+(isRunning&&active.currentSide==='right'?Math.floor((now-active.segmentStartedAt)/1000):0) : 0;
  const today=useMemo(()=>entries.filter(e=>isToday(e.startedAt)),[entries]);
  const totals=useMemo(()=>({
    left:today.filter((e):e is NursingEntry=>e.type==='nursing').reduce((n,e)=>n+e.leftDuration,0),
    right:today.filter((e):e is NursingEntry=>e.type==='nursing').reduce((n,e)=>n+e.rightDuration,0),
    formulaMl:today.filter((e):e is FormulaEntry=>e.type==='formula'&&(e.unit??'mL')==='mL').reduce((n,e)=>n+(e.amount??e.ml??0),0),
    formulaOz:today.filter((e):e is FormulaEntry=>e.type==='formula'&&e.unit==='oz').reduce((n,e)=>n+(e.amount??0),0),
  }),[today]);
  const lastFeed=entries[0];
  const lastNursing=entries.find((entry):entry is NursingEntry=>entry.type==='nursing');
  const lastSide=lastNursing?.endSide??(lastNursing?(lastNursing.rightDuration>lastNursing.leftDuration?'right':'left'):null);
  const nextSide=lastSide==='left'?'right':lastSide==='right'?'left':null;

  async function rawPersist(entry:FeedEntry) {
    setEntries(current=>[entry,...current.filter(item=>item.id!==entry.id)]);
    if(household&&isFirebaseConfigured()) try { await saveHouseholdEntry(household,entry as unknown as CloudEntry); } catch { setSyncState('error'); }
  }
  async function rawDelete(id:string) {
    setEntries(current=>current.filter(e=>e.id!==id));
    if(household&&isFirebaseConfigured()) try { await deleteHouseholdEntry(household,id); } catch { setSyncState('error'); }
  }
  function setSharedActive(next:Active) {
    setActive(next);
    if(!household||!isFirebaseConfigured())return;
    if(next) void saveHouseholdEntry(household,{...next,id:ACTIVE_CLOUD_ID,type:'active'} as unknown as CloudEntry).catch(()=>setSyncState('error'));
    else void deleteHouseholdEntry(household,ACTIVE_CLOUD_ID).catch(()=>setSyncState('error'));
  }
  function chooseSide(side:Side) {
    const timestamp=Date.now(); setNow(timestamp);
    if(!active) { setSharedActive({startedAt:timestamp,currentSide:side,startSide:side,segmentStartedAt:timestamp,leftDuration:0,rightDuration:0,isPaused:false,updatedAt:timestamp}); return; }
    if(active.currentSide===side)return;
    const segment=active.isPaused?0:Math.max(0,Math.floor((timestamp-active.segmentStartedAt)/1000));
    setSharedActive({...active,currentSide:side,segmentStartedAt:timestamp,leftDuration:active.leftDuration+(active.currentSide==='left'?segment:0),rightDuration:active.rightDuration+(active.currentSide==='right'?segment:0),updatedAt:timestamp});
  }
  function pauseOrResume() {
    if(!active)return; const timestamp=Date.now(); setNow(timestamp);
    if(active.isPaused) { setSharedActive({...active,isPaused:false,segmentStartedAt:timestamp,updatedAt:timestamp}); return; }
    const segment=Math.max(0,Math.floor((timestamp-active.segmentStartedAt)/1000));
    setSharedActive({...active,isPaused:true,segmentStartedAt:timestamp,leftDuration:active.leftDuration+(active.currentSide==='left'?segment:0),rightDuration:active.rightDuration+(active.currentSide==='right'?segment:0),updatedAt:timestamp});
  }
  function finish() {
    if(!active)return; const timestamp=Date.now(),segment=active.isPaused?0:Math.max(0,Math.floor((timestamp-active.segmentStartedAt)/1000));
    const entry:NursingEntry={id:crypto.randomUUID(),type:'nursing',startedAt:active.startedAt,endedAt:timestamp,leftDuration:active.leftDuration+(active.currentSide==='left'?segment:0),rightDuration:active.rightDuration+(active.currentSide==='right'?segment:0),startSide:active.startSide??active.currentSide,endSide:active.currentSide};
    setSharedActive(null); void rawPersist(entry); setUndo({message:'Feeding saved',action:()=>rawDelete(entry.id)});
  }
  function addFormula() {
    const amount=Math.round(Number(formulaAmount)*10)/10; if(!amount||amount<=0)return; const timestamp=Date.now();
    const entry:FormulaEntry={id:crypto.randomUUID(),type:'formula',startedAt:timestamp,endedAt:timestamp,amount,unit:bottleUnit,bottleKind};
    void rawPersist(entry); setFormulaAmount(''); setUndo({message:'Bottle saved',action:()=>rawDelete(entry.id)});
  }
  async function removeEntry(id:string) {
    const removed=entries.find(e=>e.id===id); if(!removed)return;
    await rawDelete(id); setUndo({message:'Entry deleted',action:()=>rawPersist(removed)});
  }
  async function refreshHistory() {
    if(!household||!isFirebaseConfigured())return;
    setSyncState('connecting');
    try { const cloud=await refreshHouseholdEntries(household); const cloudActive=cloud.find(item=>item.id===ACTIVE_CLOUD_ID); setActive(cloudActive?cloudActive as unknown as ActiveSession:null); setEntries(cloud.filter(item=>item.id!==ACTIVE_CLOUD_ID) as FeedEntry[]); setSyncState('synced'); }
    catch { setSyncState('error'); }
  }
  function joinHousehold(code:string) {
    const clean=code.toUpperCase().replace(/[^A-Z2-9]/g,'').slice(0,8); if(clean.length!==8)return;
    localStorage.setItem(HOUSEHOLD_KEY,clean); setHousehold(clean); setCodeInput('');
  }
  function openManual(entry?:FeedEntry) {
    if(entry?.type==='nursing')setEditDraft({id:entry.id,kind:'nursing',dateTime:inputDateTime(entry.startedAt),leftMinutes:String(Math.round(entry.leftDuration/60)),rightMinutes:String(Math.round(entry.rightDuration/60)),amount:'',unit:'mL',bottleKind:'formula'});
    else if(entry?.type==='formula')setEditDraft({id:entry.id,kind:'bottle',dateTime:inputDateTime(entry.startedAt),leftMinutes:'',rightMinutes:'',amount:String(entry.amount??entry.ml??0),unit:entry.unit??'mL',bottleKind:entry.bottleKind??'formula'});
    else setEditDraft({kind:'nursing',dateTime:inputDateTime(Date.now()),leftMinutes:'',rightMinutes:'',amount:'',unit:'mL',bottleKind:'formula'});
  }
  async function saveManual() {
    if(!editDraft)return; const old=editDraft.id?entries.find(e=>e.id===editDraft.id):undefined;
    const startedAt=new Date(editDraft.dateTime).getTime(); if(!startedAt)return;
    const entry:FeedEntry=editDraft.kind==='nursing'?{id:editDraft.id??crypto.randomUUID(),type:'nursing',startedAt,endedAt:startedAt+(Number(editDraft.leftMinutes)+Number(editDraft.rightMinutes))*60000,leftDuration:Math.round(Number(editDraft.leftMinutes)*60),rightDuration:Math.round(Number(editDraft.rightMinutes)*60)}:{id:editDraft.id??crypto.randomUUID(),type:'formula',startedAt,endedAt:startedAt,amount:Number(editDraft.amount),unit:editDraft.unit,bottleKind:editDraft.bottleKind};
    await rawPersist(entry); setEditDraft(null); setUndo({message:old?'Entry updated':'Past entry added',action:()=>old?rawPersist(old):rawDelete(entry.id)});
  }

  return <main className="app-shell">
    <header className="topbar"><div className="brand-mark" aria-hidden="true">L</div><div><h1>Latch</h1><p>Simple feeding timer</p></div><button className={`sync-pill ${syncState}`} onClick={()=>setShowSync(!showSync)}>{household ? (syncState==='synced'?'● Synced':'Household') : 'Connect household'}</button></header>

    {showSync&&<section className="sync-card">
      <div><div className="eyebrow">Shared family log</div><h2>{household?'Household connected':'Keep both phones in sync'}</h2></div>
      {!isFirebaseConfigured()?<p className="setup-note">Firebase setup is needed before syncing can be turned on. The timer still works locally.</p>:household?<div className="household-code"><span>Your household code</span><strong>{household}</strong><button onClick={()=>navigator.clipboard.writeText(household)}>Copy</button></div>:<><p>Create a private code, or enter the code shown on your partner’s phone.</p><div className="code-actions"><button onClick={()=>joinHousehold(newCode())}>Create household</button><input value={codeInput} onChange={e=>setCodeInput(e.target.value)} placeholder="8-character code" aria-label="Household code"/><button onClick={()=>joinHousehold(codeInput)}>Join</button></div></>}
    </section>}

    <section className="last-feed-card">
      <div><div className="eyebrow">Last feeding</div><h2>{lastFeed?sinceLabel(now-lastFeed.endedAt):'No feedings yet'}</h2><p>{lastFeed?`Finished at ${new Date(lastFeed.endedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`:'Your first completed feeding will appear here.'}</p></div>
      <div className="next-side">{nextSide?<><span>Try next</span><strong>{nextSide==='left'?'Left':'Right'} side</strong></>:<><span>Starting side</span><strong>Either side</strong></>}</div>
      <label className="reminder-select">Interval reminder<select value={reminderHours} onChange={e=>setReminderHours(Number(e.target.value))}><option value="0">Off</option><option value="2">2 hours</option><option value="3">3 hours</option><option value="4">4 hours</option></select>{lastFeed&&reminderHours>0&&<small>{now>=lastFeed.endedAt+reminderHours*3600000?'Reminder due now':`Due ${new Date(lastFeed.endedAt+reminderHours*3600000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`}</small>}</label>
    </section>

    <section className="hero" aria-labelledby="timer-heading"><div className="eyebrow">Current feed</div><h2 id="timer-heading">{active?(active.isPaused?'Feeding paused':`${active.currentSide==='left'?'Left':'Right'} side`):'Ready when you are'}</h2><div className={`timer ${isRunning?'running':''} ${active?.isPaused?'paused':''}`} aria-live="polite">{clock(liveLeft+liveRight)}</div><p className="started-time">{active?(active.isPaused?'Timer stopped · choose a side, then resume':`Started at ${new Date(active.startedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} · Nothing logs until you finish`):'Tap a side to begin. Switch sides anytime.'}</p>
      {active&&<div className="live-split"><span>Left <strong>{clock(liveLeft)}</strong></span><span>Right <strong>{clock(liveRight)}</strong></span></div>}
      <div className="side-buttons"><button className={`side-button left ${active?.currentSide==='left'?'active':''}`} onClick={()=>chooseSide('left')}><span className="side-letter">L</span><span>{active?.currentSide==='left'?(active.isPaused?'Left selected':'Timing left'):active?(active.isPaused?'Choose left':'Switch to left'):'Start left'}</span></button><button className={`side-button right ${active?.currentSide==='right'?'active':''}`} onClick={()=>chooseSide('right')}><span className="side-letter">R</span><span>{active?.currentSide==='right'?(active.isPaused?'Right selected':'Timing right'):active?(active.isPaused?'Choose right':'Switch to right'):'Start right'}</span></button></div>
      {active&&<div className="timer-actions"><button className={`pause-button ${active.isPaused?'resume':''}`} onClick={pauseOrResume}>{active.isPaused?'▶ Resume timer':'Ⅱ Pause timer'}</button><button className="finish-button" onClick={finish}>Finish & save</button></div>}
    </section>

    <section className="formula-card"><div><div className="eyebrow">Bottle feeding</div><h2>Add bottle</h2><div className="kind-toggle"><button className={bottleKind==='formula'?'selected':''} onClick={()=>setBottleKind('formula')}>Formula</button><button className={bottleKind==='breastmilk'?'selected':''} onClick={()=>setBottleKind('breastmilk')}>Pumped milk</button></div></div><div className="formula-input"><input type="number" min="0.1" step="0.1" inputMode="decimal" value={formulaAmount} onChange={e=>setFormulaAmount(e.target.value)} placeholder="0" aria-label={`Bottle amount in ${bottleUnit}`}/><div className="unit-toggle" aria-label="Bottle unit"><button className={bottleUnit==='mL'?'selected':''} onClick={()=>setBottleUnit('mL')}>mL</button><button className={bottleUnit==='oz'?'selected':''} onClick={()=>setBottleUnit('oz')}>oz</button></div><button onClick={addFormula} disabled={!Number(formulaAmount)}>Add bottle</button></div></section>

    <section className="today" aria-labelledby="today-heading"><div className="section-heading"><div><div className="eyebrow">At a glance</div><h2 id="today-heading">Today</h2></div><strong>{today.length} {today.length===1?'entry':'entries'}</strong></div><div className="summary-grid four"><article><span className="dot left-dot"/>Left<strong>{durationLabel(totals.left)}</strong></article><article><span className="dot right-dot"/>Right<strong>{durationLabel(totals.right)}</strong></article><article><span className="dot formula-dot"/>Formula<strong>{totals.formulaMl} mL · {totals.formulaOz} oz</strong></article><article><span className="dot total-dot"/>Total<strong>{today.length}</strong></article></div></section>

    <section className="history" aria-labelledby="history-heading"><div className="section-heading"><div><div className="eyebrow">Saved after finishing</div><h2 id="history-heading">Recent feeds</h2></div><div className="history-actions"><button className="manual-button" onClick={()=>openManual()}>+ Add past</button>{household&&<button className="refresh-button" onClick={()=>void refreshHistory()} disabled={syncState==='connecting'}>{syncState==='connecting'?'Refreshing…':'↻ Refresh'}</button>}</div></div>{syncState==='error'&&<div className="sync-error">Could not reach the shared history. Check your connection, then refresh.</div>}{!entries.length?<div className="empty-state"><span>◷</span><p>Your feeding history will appear here.</p></div>:<div className="feed-list">{entries.slice(0,30).map(entry=>{const bottleAmount=entry.type==='formula'?(entry.amount??entry.ml??0):0;const unit=entry.type==='formula'?(entry.unit??'mL'):'mL';const bottleLabel=entry.type==='formula'&&entry.bottleKind==='breastmilk'?'Pumped milk':'Formula';return <article className="feed-row" key={entry.id}><div className={`feed-icon ${entry.type}`}>{entry.type==='formula'?unit:'B'}</div><div className="feed-main"><strong>{entry.type==='formula'?`${bottleLabel} bottle · ${bottleAmount} ${unit}`:'Breastfeeding'}</strong><span>{new Date(entry.startedAt).toLocaleDateString([],{month:'short',day:'numeric'})} · {new Date(entry.startedAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}{entry.type==='nursing'?` · L ${durationLabel(entry.leftDuration)} · R ${durationLabel(entry.rightDuration)}`:''}</span></div><strong className="feed-duration">{entry.type==='formula'?`${bottleAmount} ${unit}`:durationLabel(entry.leftDuration+entry.rightDuration)}</strong><button className="edit-button" aria-label="Edit feeding entry" onClick={()=>openManual(entry)}>Edit</button><button className="delete-button" aria-label="Delete feeding entry" onClick={()=>void removeEntry(entry.id)}>×</button></article>})}</div>}</section>
    {editDraft&&<div className="modal-backdrop" role="presentation"><section className="edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title"><div className="section-heading"><div><div className="eyebrow">History</div><h2 id="edit-title">{editDraft.id?'Edit entry':'Add past entry'}</h2></div><button className="close-button" onClick={()=>setEditDraft(null)}>×</button></div><div className="entry-type-toggle"><button className={editDraft.kind==='nursing'?'selected':''} onClick={()=>setEditDraft({...editDraft,kind:'nursing'})}>Breastfeeding</button><button className={editDraft.kind==='bottle'?'selected':''} onClick={()=>setEditDraft({...editDraft,kind:'bottle'})}>Bottle</button></div><label>Date and time<input type="datetime-local" value={editDraft.dateTime} onChange={e=>setEditDraft({...editDraft,dateTime:e.target.value})}/></label>{editDraft.kind==='nursing'?<div className="manual-grid"><label>Left minutes<input type="number" min="0" value={editDraft.leftMinutes} onChange={e=>setEditDraft({...editDraft,leftMinutes:e.target.value})}/></label><label>Right minutes<input type="number" min="0" value={editDraft.rightMinutes} onChange={e=>setEditDraft({...editDraft,rightMinutes:e.target.value})}/></label></div>:<><div className="entry-type-toggle"><button className={editDraft.bottleKind==='formula'?'selected':''} onClick={()=>setEditDraft({...editDraft,bottleKind:'formula'})}>Formula</button><button className={editDraft.bottleKind==='breastmilk'?'selected':''} onClick={()=>setEditDraft({...editDraft,bottleKind:'breastmilk'})}>Pumped milk</button></div><div className="manual-grid"><label>Amount<input type="number" min="0.1" step="0.1" value={editDraft.amount} onChange={e=>setEditDraft({...editDraft,amount:e.target.value})}/></label><label>Unit<select value={editDraft.unit} onChange={e=>setEditDraft({...editDraft,unit:e.target.value as BottleUnit})}><option>mL</option><option>oz</option></select></label></div></>}<button className="save-edit" onClick={()=>void saveManual()}>Save entry</button></section></div>}
    {undo&&<div className="undo-toast" role="status"><span>{undo.message}</span><button onClick={()=>{void undo.action();setUndo(null);}}>Undo</button></div>}
    <footer>Free, simple, and made for sleepy moments.</footer>
  </main>;
}
