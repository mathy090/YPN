import { getApp, getApps, initializeApp } from 'firebase/app';

export const firebaseConfig = {
  apiKey: "AIzaSyDJtU9grhwUsPruPUDEBfDvrM9GUvqdaZM",
  authDomain: "ypnn-4ab56.firebaseapp.com",
  projectId: "ypnn-4ab56",
  storageBucket: "ypnn-4ab56.firebasestorage.app",
  messagingSenderId: "361158718918",
  appId: "1:361158718918:android:b1f232a5ca9af061c6aec7",
};

// Prevent re-initialization (VERY IMPORTANT for Expo)
export const app = getApps().length === 0
  ? initializeApp(firebaseConfig)
  : getApp();
