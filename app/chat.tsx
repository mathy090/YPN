// app/chat.tsx
import { useLocalSearchParams } from "expo-router";
import React from "react";
import { Text, View } from "react-native"; // ✅ Added missing imports
import TeamYPNScreen from "../src/screens/TeamYPN";

export default function ChatScreen() {
  const { roomId } = useLocalSearchParams<{ roomId?: string }>();

  if (roomId === "team-ypn") {
    return <TeamYPNScreen />;
  }

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
