import { initializeApp, getApps } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { collection, deleteDoc, doc, getDocsFromServer, getFirestore, onSnapshot, runTransaction, setDoc } from 'firebase/firestore';
import { sameTimerRevision } from './feed-state';

export type CloudEntry = Record<string, string | number | boolean> & { id: string };

// Replace these six values with the Web App configuration from Firebase.
const firebaseConfig = {
  apiKey: 'AIzaSyA7KzchgmO31VhRKmAUjkFM5pPLiFE52RA',
  authDomain: 'feedertimer.firebaseapp.com',
  projectId: 'feedertimer',
  storageBucket: 'feedertimer.firebasestorage.app',
  messagingSenderId: '639657333390',
  appId: '1:639657333390:web:de57770684d34054d2afdf',
};

export function isFirebaseConfigured() {
  return !firebaseConfig.apiKey.startsWith('REPLACE_');
}

function services() {
  const app = getApps()[0] || initializeApp(firebaseConfig);
  return { auth: getAuth(app), db: getFirestore(app) };
}

async function signedInServices() {
  const current = services();
  if (!current.auth.currentUser) await signInAnonymously(current.auth);
  return current;
}

function sortedEntries(documents: { data: () => unknown }[]) {
  const entries = documents.map((item) => item.data() as CloudEntry);
  entries.sort((a, b) => Number(b.startedAt) - Number(a.startedAt));
  return entries;
}

export async function connectHousehold(code: string, onEntries: (entries: CloudEntry[]) => void, onError: () => void) {
  const { db } = await signedInServices();
  return onSnapshot(collection(db, 'households', code, 'entries'), { includeMetadataChanges:true }, (snapshot) => {
    if(snapshot.metadata.fromCache||snapshot.metadata.hasPendingWrites)return;
    onEntries(sortedEntries(snapshot.docs));
  }, onError);
}

export async function changeHouseholdTimer(code:string, expected:Record<string,unknown>|null, next:CloudEntry|null, finishedEntry?:CloudEntry) {
  const { db }=await signedInServices();
  const timerRef=doc(db,'households',code,'entries','_active');
  return runTransaction(db,async transaction=>{
    const snapshot=await transaction.get(timerRef);
    const current=snapshot.exists()?snapshot.data():null;
    if(!sameTimerRevision(current,expected))return false;
    if(next)transaction.set(timerRef,next);
    else transaction.delete(timerRef);
    if(finishedEntry)transaction.set(doc(db,'households',code,'entries',finishedEntry.id),finishedEntry);
    return true;
  });
}

export async function refreshHouseholdEntries(code: string) {
  const { db } = await signedInServices();
  const snapshot = await getDocsFromServer(collection(db, 'households', code, 'entries'));
  return sortedEntries(snapshot.docs);
}

export async function saveHouseholdEntry(code: string, entry: CloudEntry) {
  const { db } = await signedInServices();
  await setDoc(doc(db, 'households', code, 'entries', entry.id), entry);
}

export async function deleteHouseholdEntry(code: string, id: string) {
  const { db } = await signedInServices();
  await deleteDoc(doc(db, 'households', code, 'entries', id));
}
