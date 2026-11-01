// IndexedDB plumbing: schema + small promise helpers. No business logic here.

export const DB_NAME = 'saveshelf-library';
export const DB_VERSION = 1;

export const STORES = Object.freeze({
  ITEMS: 'items',
  FOLDERS: 'folders',
  META: 'meta',
  TOMBSTONES: 'tombstones',
});

/**
 * Open (and create/upgrade) the database.
 * @param {{indexedDB?: IDBFactory, name?: string}} [opts] inject `indexedDB` + a unique `name` in tests.
 */
export function openDb({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.ITEMS)) {
        const items = db.createObjectStore(STORES.ITEMS, { keyPath: 'id' });
        items.createIndex('seq', 'seq');
        items.createIndex('subreddit', 'subreddit');
        items.createIndex('folderId', 'folderId');
        items.createIndex('kind', 'kind');
        items.createIndex('createdAt', 'createdAt');
        items.createIndex('tags', 'tags', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains(STORES.FOLDERS)) {
        db.createObjectStore(STORES.FOLDERS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.TOMBSTONES)) {
        db.createObjectStore(STORES.TOMBSTONES, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

/** Wrap an IDBRequest in a promise. */
export function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Run `fn(stores)` inside one transaction. `fn` may be async but must only await IDB requests
 * (awaiting anything else lets the transaction auto-commit). Resolves with fn's result once the
 * transaction has committed; rejects (and aborts) if fn throws.
 */
export function withTx(db, storeNames, mode, fn) {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    const stores = Object.fromEntries(names.map((n) => [n, tx.objectStore(n)]));
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
    Promise.resolve()
      .then(() => fn(stores))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        reject(err);
      });
  });
}

export const getAll = (store, query) => reqToPromise(store.getAll(query));
export const getOne = (store, key) => reqToPromise(store.get(key));
export const putOne = (store, value) => reqToPromise(store.put(value));
export const countAll = (store) => reqToPromise(store.count());
