// src/firebase/auth.ts
import ReactNativeAsyncStorage from "@react-native-async-storage/async-storage";
import {
  getAuth,
  getReactNativePersistence,
  initializeAuth,
  onAuthStateChanged,
  signOut,
  User,
} from "firebase/auth";
import { app } from "./firebase";

// initializeAuth once — if already initialized grab the existing instance
let auth: ReturnType<typeof getAuth>;

try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(ReactNativeAsyncStorage),
  });
} catch (e: any) {
  // Already initialized — grab existing instance with persistence intact
  auth = getAuth(app);
}

const subscribeToAuth = (cb: (user: User | null) => void) =>
  onAuthStateChanged(auth, cb);

const logout = async () => {
  await signOut(auth);
};

export { auth, logout, subscribeToAuth };

  export {
    createUserWithEmailAndPassword,
    sendEmailVerification,
    signInWithEmailAndPassword
  } from "firebase/auth";

