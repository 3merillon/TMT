/** One durable campaign checkpoint. IndexedDB preserves typed terrain buffers without
 * JSON expansion or localStorage quotas. The setup key prevents loading a different kit/mission. */
export interface CampaignSave { version: 1; setupKey: string; checkpoint: unknown }
export type CampaignSaveSlot = 'active' | 'owned-coop';
const DB = 'iron-orrery-campaign', STORE = 'checkpoints';
async function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Campaign storage upgrade is blocked by another tab'));
  });
}
async function transact<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await database(); if (!db) return null;
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode), request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error);
      tx.onabort = () => reject(tx.error ?? new Error('Campaign save aborted'));
    });
  } finally { db.close(); }
}
export async function readCampaignSave(setupKey: string, slot: CampaignSaveSlot = 'active'): Promise<unknown | null> {
  const saved = await transact('readonly', store => store.get(slot)) as CampaignSave | undefined;
  return saved?.version === 1 && saved.setupKey === setupKey ? saved.checkpoint : null;
}
export async function writeCampaignSave(setupKey: string, checkpoint: unknown, slot: CampaignSaveSlot = 'active', isCurrent: () => boolean = () => true): Promise<boolean> {
  const db = await database(); if (!db) return false;
  try {
    if (!isCurrent()) return false;
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ version: 1, setupKey, checkpoint } satisfies CampaignSave, slot);
      tx.oncomplete = () => resolve(true); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
/** Winning only removes this setup's slot, never a checkpoint written by another tab/mission. */
export async function clearCampaignSave(setupKey: string, slot: CampaignSaveSlot = 'active'): Promise<void> {
  const db = await database(); if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE), get = store.get(slot);
      get.onsuccess = () => { if ((get.result as CampaignSave | undefined)?.setupKey === setupKey) store.delete(slot); };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
