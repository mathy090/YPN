// src/utils/backgroundChatTask.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";

const BACKGROUND_CHAT_TASK = "BACKGROUND_CHAT_TASK";

// Define the task
TaskManager.defineTask(BACKGROUND_CHAT_TASK, async ({ data, error }) => {
  if (error) {
    console.error("[BackgroundTask] Error:", error);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }

  const { messageId, prompt } = data as { messageId: string; prompt: string };

  try {
    console.log("[BackgroundTask] Starting AI reply for:", messageId);

    // 1. Perform the fetch in the background
    const AI_API_URL = `${process.env.EXPO_PUBLIC_AI_URL}/chat`;
    const res = await fetch(AI_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: prompt }),
    });

    if (!res.ok) throw new Error("API Error");

    const responseData = await res.json();
    const replyText =
      responseData.reply || responseData.message || "Sorry, no response.";

    // 2. Save the result to AsyncStorage so the app can pick it up when opened
    await AsyncStorage.setItem(
      `bg_reply_${messageId}`,
      JSON.stringify({
        id: `ai_${Date.now()}`,
        text: replyText,
        timestamp: new Date().toISOString(),
        sender: "ai",
        status: "read",
      }),
    );

    console.log("[BackgroundTask] Reply saved for:", messageId);
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (err) {
    console.error("[BackgroundTask] Failed:", err);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export const registerBackgroundChatTask = async () => {
  try {
    await BackgroundFetch.registerTaskAsync(BACKGROUND_CHAT_TASK, {
      minimumInterval: 60, // Seconds (OS decides when to run)
      stopOnTerminate: false, // Android only
      startOnBoot: true, // Android only
    });
    console.log("[BackgroundTask] Registered");
  } catch (err) {
    console.error("[BackgroundTask] Registration failed:", err);
  }
};
