import { openDB, type IDBPDatabase } from "idb";

/**
 * Autosave storage.
 *
 * IndexedDB rather than localStorage: a real thesis blows past the ~5 MB
 * localStorage ceiling, and writing a large string to localStorage blocks the
 * main thread on every save.
 */

const DB_NAME = "texpane";
const DB_VERSION = 1;
const STORE = "documents";
const CURRENT = "current";

export interface SavedDocument {
  source: string;
  updatedAt: number;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains(STORE)) {
          database.createObjectStore(STORE);
        }
      },
    });
  }
  return dbPromise;
}

export async function loadDocument(): Promise<SavedDocument | null> {
  try {
    const value = await (await db()).get(STORE, CURRENT);
    return (value as SavedDocument | undefined) ?? null;
  } catch {
    // Private-mode Safari and blocked storage both land here. Autosave is a
    // convenience, so degrade to a session that simply does not persist.
    return null;
  }
}

export async function saveDocument(source: string): Promise<void> {
  try {
    await (await db()).put(STORE, { source, updatedAt: Date.now() }, CURRENT);
  } catch {
    /* see loadDocument */
  }
}

export async function clearDocument(): Promise<void> {
  try {
    await (await db()).delete(STORE, CURRENT);
  } catch {
    /* see loadDocument */
  }
}
