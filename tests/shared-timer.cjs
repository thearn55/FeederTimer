const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function load(relative,mocks={},globals={}) {
  const filename=path.join(__dirname,'..',relative);
  const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};
  vm.runInNewContext(source,{...globals,exports,require:name=>{
    if(name in mocks)return mocks[name];
    throw Error(`Unexpected import: ${name}`);
  }},{filename});
  return exports;
}
const helpers=load('app/feed-state.ts');
function fixture() {
  const records=new Map();let listener;
  const db={};
  const firestore={
    getFirestore:()=>db,doc:(_, ...parts)=>parts.join('/'),collection:(_, ...parts)=>parts.join('/'),
    onSnapshot:(_ref,_options,callback)=>{listener=callback;return()=>{};},
    runTransaction:async(_,callback)=>{
      const staged=[];
      const result=await callback({
        get:async ref=>({exists:()=>records.has(ref),data:()=>records.get(ref)}),
        set:(ref,value)=>staged.push(()=>records.set(ref,value)),
        delete:ref=>staged.push(()=>records.delete(ref)),
      });
      staged.forEach(write=>write());return result;
    },
  };
  const api=load('app/firebase.ts',{
    'firebase/app':{getApps:()=>[{}]},
    'firebase/auth':{getAuth:()=>({currentUser:{uid:'test'}})},
    'firebase/firestore':firestore,'./feed-state':helpers,
  });
  return {api,records,emit:snapshot=>listener(snapshot)};
}
const timer={id:'_active',type:'active',startedAt:1000,updatedAt:1000,segmentStartedAt:1000,currentSide:'left',isPaused:false,leftDuration:0,rightDuration:0};
const timerPath='households/TESTCODE/entries/_active';

test('other phone can reset a paused timer; an old update cannot restore it',async()=>{
  const {api,records}=fixture();
  assert.equal(await api.changeHouseholdTimer('TESTCODE',null,timer),true);
  const paused={...timer,updatedAt:2000,isPaused:true,leftDuration:1};
  assert.equal(await api.changeHouseholdTimer('TESTCODE',timer,paused),true);
  assert.equal(await api.changeHouseholdTimer('TESTCODE',paused,null),true);
  assert.equal(records.has(timerPath),false);
  assert.equal(await api.changeHouseholdTimer('TESTCODE',paused,{...paused,isPaused:false}),false);
  assert.equal(records.has(timerPath),false);
  assert.equal(await api.changeHouseholdTimer('TESTCODE',null,{...timer,startedAt:3000,updatedAt:3000}),true);
});
test('Finish saves once and clears the same timer; stale Finish cannot duplicate history',async()=>{
  const {api,records}=fixture();records.set(timerPath,timer);
  const entry={id:'feed1',type:'nursing',startedAt:1000,endedAt:2000};
  assert.equal(await api.changeHouseholdTimer('TESTCODE',timer,null,entry),true);
  assert.equal(records.has(timerPath),false);
  assert.equal(records.get('households/TESTCODE/entries/feed1'),entry);
  assert.equal(await api.changeHouseholdTimer('TESTCODE',timer,null,{...entry,id:'feed2'}),false);
  assert.equal(records.size,1);
});
test('a stale reset cannot delete a newer feeding',async()=>{
  const {api,records}=fixture(); const newer={...timer,startedAt:9000,updatedAt:9000};records.set(timerPath,newer);
  assert.equal(await api.changeHouseholdTimer('TESTCODE',timer,null),false);
  assert.equal(records.get(timerPath),newer);
});
test('cached and pending snapshots are ignored; confirmed deletion reaches both clients',async()=>{
  const {api,emit}=fixture();const received=[];
  await api.connectHousehold('TESTCODE',entries=>received.push(entries),()=>{});
  emit({metadata:{fromCache:true,hasPendingWrites:false},docs:[{data:()=>timer}]});
  emit({metadata:{fromCache:false,hasPendingWrites:true},docs:[]});
  assert.equal(received.length,0);
  emit({metadata:{fromCache:false,hasPendingWrites:false},docs:[]});
  assert.equal(received.length,1);assert.equal(received[0].length,0);
});
test('future 11:26 PM feed follows completed afternoon feeds and is flagged',()=>{
  const now=new Date('2026-09-15T14:38:00-05:00').getTime();
  const future={id:'future',startedAt:new Date('2026-09-15T23:26:00-05:00').getTime(),endedAt:new Date('2026-09-15T23:39:00-05:00').getTime()};
  const bottle={id:'bottle',startedAt:now-21*60000,endedAt:now-21*60000};
  const old={id:'old',startedAt:now-4*3600000,endedAt:now-3.9*3600000};
  const sorted=helpers.sortFeeds([future,old,bottle],now);
  assert.equal(sorted[0].id,'bottle');assert.equal(sorted[2].id,'future');
  assert.equal(helpers.needsDateCorrection(future,now),true);
  assert.equal(helpers.needsDateCorrection(bottle,now),false);
  assert.equal(helpers.needsDateCorrection({...old,endedAt:now+1},now),true);
});

test('reopening with a cached two-hour timer never uploads it after the cloud clears',async()=>{
  const storage=new Map([['latch-household-v1','TESTCODE'],['latch-active-v2',JSON.stringify({...timer,isPaused:true,rightDuration:7263})]]);
  const slots=[];let cursor=0,dirty=true;const effects=[];let cloudListener;let writes=0;
  const react={
    useState:initial=>{
      const index=cursor++;if(!(index in slots))slots[index]=initial;
      return [slots[index],next=>{const value=typeof next==='function'?next(slots[index]):next;if(!Object.is(value,slots[index])){slots[index]=value;dirty=true;}}];
    },
    useRef:initial=>{const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},
    useMemo:fn=>fn(),
    useEffect:(fn,deps)=>{
      const index=cursor++;const previous=slots[index];
      if(!previous||deps.some((value,i)=>!Object.is(value,previous[i]))){slots[index]=deps;effects.push(fn);}
    },
  };
  const api={isFirebaseConfigured:()=>true,connectHousehold:async(_code,onCloud)=>{cloudListener=onCloud;return()=>{};},saveHouseholdEntry:async()=>{writes++;}};
  const Home=load('app/page.tsx',{'react':react,'react/jsx-runtime':{jsx:()=>null,jsxs:()=>null},'./firebase':api,'./feed-state':helpers},{
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    window:{setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{}},
  }).default;
  function render(){for(let n=0;dirty&&n<20;n++){dirty=false;cursor=0;Home();while(effects.length)effects.shift()();}assert.equal(dirty,false);}
  render();await Promise.resolve();
  assert.equal(slots[1],null);
  cloudListener([{...timer,isPaused:true,rightDuration:7263}]);render();
  assert.equal(slots[1].rightDuration,7263);
  cloudListener([]);render();
  assert.equal(slots[1],null);
  cloudListener([]);render();
  assert.equal(writes,0);
  assert.equal(storage.has('latch-active-v2'),false);
});
