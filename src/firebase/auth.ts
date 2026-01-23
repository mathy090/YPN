import ReactNativeAsyncStorage from '@react-native-async-storage/async-storage';
import {
  createUserWithEmailAndPassword,
  getReactNativePersistence,
  initializeAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  User,
} from 'firebase/auth';

import { app } from './firebase';

let auth: any;

try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(ReactNativeAsyncStorage),
  });
} catch (e: any) {
  if (e.code !== 'auth/already-initialized') throw e;
}

const subscribeToAuth = (cb: (user: User | null) => void) => {
  return onAuthStateChanged(auth, cb);
};

const logout = async () => {
  await signOut(auth);
};

export {
  auth,
  createUserWithEmailAndPassword, logout, sendEmailVerification, signInWithEmailAndPassword, subscribeToAuth
};

