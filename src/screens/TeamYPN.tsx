// src/screens/TeamYPN.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import ChatUI from "../components/chat";
import { Message } from "../types/chat";

const AI_STREAM_URL = process.env.EXPO_PUBLIC_AI_URL + "/chat/stream";
const CACHE_KEY = "ypn:chat:team-ypn";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Simple LRU-style cache wrapper
const cache = {
  async get(key: string): Promise<any> {
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      const { data, timestamp } = JSON.parse(raw);
      if (Date.now() - timestamp > CACHE_TTL) return null;
      return data;
    } catch {
      return null;
    }
  },
  async set(key: string, data: any) {
    try {
      await AsyncStorage.setItem(
        key,
        JSON.stringify({ data, timestamp: Date.now() }),
      );
    } catch {}
  },
};

export default function TeamYPNScreen() {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [online, setOnline] = useState(true);

  // Load persisted chat history
  useEffect(() => {
    (async () => {
      const cached = await AsyncStorage.getItem(CACHE_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as Message[];
          setMessages(parsed);
        } catch {}
      }
    })();
  }, []);

  // Persist chat history on change
  useEffect(() => {
    if (messages.length > 0) {
      AsyncStorage.setItem(CACHE_KEY, JSON.stringify(messages)).catch(() => {});
    }
  }, [messages]);

  // Network status + health check
  useEffect(() => {
    const unsubNet = NetInfo.addEventListener((state) => {
      setOnline(!!state.isConnected);
    });
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${process.env.EXPO_PUBLIC_AI_URL}/health`, {
          method: "HEAD",
          timeout: 3000,
        });
        setOnline(res.ok);
      } catch {
        setOnline(false);
      }
    }, 10000);
    return () => {
      unsubNet();
      clearInterval(interval);
    };
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !online) return;

    setSending(true);
    setInput("");

    const userMsg: Message = {
      id: Date.now().toString(),
      text,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "sending",
    };

    setMessages((prev) => [...prev, userMsg]);
    setTyping(true);

    try {
      // Check cache first for common queries
      const cachedResp = await cache.get(
        `resp:${text.toLowerCase().slice(0, 50)}`,
      );
      if (cachedResp && online) {
        // Use cached response but still show streaming UI for consistency
        setTimeout(() => {
          setMessages((prev) => [
            ...prev,
            {
              id: (Date.now() + 1).toString(),
              text: cachedResp,
              sender: "ai",
              timestamp: new Date().toISOString(),
            },
          ]);
          setTyping(false);
          setSending(false);
          // Update user message status
          setMessages((prev) =>
            prev.map((m) =>
              m.id === userMsg.id ? { ...m, status: "delivered" } : m,
            ),
          );
        }, 300);
        return;
      }

      const res = await fetch(AI_STREAM_URL, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          session_id: "ypn-general", // ✅ Shared conversation for all users
          history: messages, // ✅ Send full history from AsyncStorage
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let aiId = (Date.now() + 1).toString();
      let aiText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (let line of lines) {
          if (!line.startsWith("data:")) continue;
          const json = JSON.parse(line.replace("data: ", ""));

          if (json.type === "status" && json.status === "received") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === userMsg.id ? { ...m, status: "sent" } : m,
              ),
            );
          }
          if (json.type === "chunk") {
            aiText = json.content;
            setMessages((prev) => {
              const exists = prev.find((m) => m.id === aiId);
              if (exists) {
                return prev.map((m) =>
                  m.id === aiId ? { ...m, text: aiText } : m,
                );
              }
              return [
                ...prev,
                {
                  id: aiId,
                  text: aiText,
                  sender: "ai",
                  timestamp: new Date().toISOString(),
                },
              ];
            });
          }
          if (json.type === "status" && json.status === "delivered") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === userMsg.id ? { ...m, status: "delivered" } : m,
              ),
            );
          }
          if (json.type === "done") {
            // Cache successful response
            if (aiText.trim()) {
              cache.set(`resp:${text.toLowerCase().slice(0, 50)}`, aiText);
            }
            setTyping(false);
          }
        }
      }
    } catch (err: any) {
      console.warn("[TeamYPN] Error:", err);
      setTyping(false);
      setOnline(false);
      setMessages((prev) =>
        prev.map((m) => (m.id === userMsg.id ? { ...m, status: "failed" } : m)),
      );
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          text: online
            ? "Something went wrong. Please try again."
            : "No internet connection. Check your network.",
          sender: "ai",
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [input, sending, online, messages]);

  return (
    <ChatUI
      messages={messages}
      input={input}
      setInput={setInput}
      send={send}
      sending={sending}
      typing={typing}
      online={online}
      onBack={() => router.back()}
    />
  );
}
