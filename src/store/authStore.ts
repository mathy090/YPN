// src/store/authStore.ts
import { User } from 'firebase/auth';
import { create } from 'zustand';
import { logout, subscribeToAuth } from '../firebase/auth';

type AuthState = {
  user: User | null;
  initialized: boolean;
  setUser: (user: User | null) => void;
  startListener: () => void;
  logout: () => Promise<void>;
  login: () => void; // Add this line
};

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  initialized: false,

  setUser: (user) => set({ user }),

  startListener: () => {
    // Prevent multiple listeners
    if (get().initialized) return;

    subscribeToAuth((user) => {
      set({ user, initialized: true });
    });
  },

  login: () => set({ user: get().user }), // Add this line

  logout: async () => {
    await logout();
    set({ user: null });
  },
}));