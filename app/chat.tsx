// app/chat.tsx
import { useLocalSearchParams } from "expo-router";
import React from "react";
import TeamYPNScreen from "../src/screens/TeamYPN";

export default function ChatScreen() {
  const { roomId } = useLocalSearchParams<{ roomId?: string }>();

  // Only handle Team YPN for now (roomId = 'team-ypn')
  if (roomId === "team-ypn") {
    return <TeamYPNScreen />;
  }

  // Future: Handle user chats and groups here
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#000",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Text style={{ color: "#FFF", fontSize: 18 }}>Chat room not found</Text>
    </View>
  );
}
