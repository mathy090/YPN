import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import ChatUI from "../src/components/chat";
import { Message } from "../src/types/chat";
import { getSecureCache, setSecureCache } from "../src/utils/cache";
import { handleAIError } from "../src/utils/errorHandler";
import { checkAIHealth } from "../src/utils/health";

const AI_STREAM_URL = process.env.EXPO_PUBLIC_AI_URL + "/chat/stream";

export default function TeamYPNScreen() {
  const router = useRouter();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [online, setOnline] = useState(true);

  // Load cache
  useEffect(() => {
    (async () => {
      const cached = await getSecureCache("chat_team-ypn");
      if (Array.isArray(cached)) setMessages(cached);
    })();
  }, []);

  // Save cache
  useEffect(() => {
    setSecureCache("chat_team-ypn", messages).catch(() => {});
  }, [messages]);

  // Health check loop
  useEffect(() => {
    const interval = setInterval(async () => {
      const status = await checkAIHealth();
      setOnline(status);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;

    setSending(true);
    setInput("");

    const id = Date.now().toString();

    setMessages((prev) => [
      ...prev,
      {
        id,
        text,
        sender: "user",
        timestamp: new Date().toISOString(),
        status: "sending",
      },
    ]);

    setTyping(true);

    try {
      const res = await fetch(AI_STREAM_URL, {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: text,
          session_id: "ypn-general",
        }),
      });

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
              prev.map((m) => (m.id === id ? { ...m, status: "sent" } : m)),
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
                m.id === id ? { ...m, status: "delivered" } : m,
              ),
            );
          }

          if (json.type === "done") {
            setTyping(false);
          }
        }
      }
    } catch (err) {
      const error = handleAIError(err);

      setTyping(false);
      setOnline(false);

      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, status: "failed" } : m)),
      );

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now().toString(),
          text: error.message,
          sender: "ai",
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setSending(false);
    }
  };

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
