// src/types/chat.ts
export interface Message {
  id: string;
  text: string;
  sender: 'user' | 'ai' | string;
  timestamp: string;
  status: 'sent' | 'delivered' | 'read';
  image?: string;
  isPhoto?: boolean;
}