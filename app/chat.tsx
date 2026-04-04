// app/chat.tsx
// Routes chat rooms. Only Team YPN AI chat is currently active.
// Future: add real user-to-user DMs here.

import { useLocalSearchParams, View } from "expo-router";
import { Text } from "react-native";
import TeamYPNScreen from "../src/screens/TeamYPN";

export default function ChatScreen() {
  const { roomId } = useLocalSearchParams<{ roomId?: string }>();

  if (roomId === "team-ypn" || !roomId) {
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
      <Text style={{ color: "#555", fontSize: 16 }}>Chat room not found</Text>
    </View>
  );
}
