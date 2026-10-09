/**
 * 极简 IndexedDB 封装。
 *
 * 为什么不用 localStorage：工程快照里包含图片素材（PNG dataURL），
 * 动辄几 MB，localStorage 通常只有 5MB 配额，很容易写失败。
 * IndexedDB 没有这个限制，且天生异步（适合存大对象）。
 *
 * 只有一个 object store（'projects'），key = 工程 id，value = 整个工程快照对象。
 */

const DB_NAME = 'pixibones';
const DB_VERSION = 1;
const STORE = 'projects';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 写入（覆盖）一条记录。 */
export async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 读取一条记录（不存在返回 null）。 */
export async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result ?? null) as T | null);
    req.onerror = () => reject(req.error);
  });
}

/** 删除一条记录。 */
export async function idbDel(key: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 是否已存在某条记录。 */
export async function idbHas(key: string): Promise<boolean> {
  const v = await idbGet<unknown>(key);
  return v != null;
}
