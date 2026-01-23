import { enableIndexedDbPersistence, getFirestore } from 'firebase/firestore';
import { app } from './firebase';

export const db = getFirestore(app);

// Enable offline cache (WhatsApp behavior)
enableIndexedDbPersistence(db).catch(() => {
  // Safe to ignore if already enabled
});
