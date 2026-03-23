// src/firebase/firebase.ts
import { getApp, getApps, initializeApp } from "firebase/app";

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID!,
};

if (__DEV__) {
  const missing = Object.entries(firebaseConfig)
    .filter(([, v]) => !v)
    .map(([k]) => `EXPO_PUBLIC_${k.replace(/([A-Z])/g, "_$1").toUpperCase()}`);
  if (missing.length) {
    console.error(
      `[firebase.ts] Missing env vars: ${missing.join(", ")}\n` +
        "Copy .env.example → .env.local and fill in your Firebase config.",
    );
  }
}

// Prevent re-initialization on Expo hot reload
export const app =
  getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
