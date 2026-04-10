// src/firebase/auth.ts
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut,
  User,
} from "firebase/auth";
import { app } from "./firebase"; // Your firebase config file

// 1. Initialize Auth WITHOUT explicit persistence argument.
// This is INSTANT and does NOT block on AsyncStorage.
const auth = getAuth(app);

// 2. Standard Helpers
const subscribeToAuth = (cb: (user: User | null) => void) => {
  return onAuthStateChanged(auth, cb);
};

const logout = async () => {
  try {
    await signOut(auth);
  } catch (e) {
    console.warn("[Firebase] Sign out error:", e);
  }
};

export {
  auth,
  createUserWithEmailAndPassword,
  logout,
  sendEmailVerification,
  signInWithEmailAndPassword,
  subscribeToAuth
};

