// app/auth/device.tsx
import { useRouter } from "expo-router";
import { getAuth, updateProfile } from "firebase/auth";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { colors } from "../../src/theme/colors";
import Screen from "../../src/ui/Screen";
import { authHeaders } from "../../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

export default function Device() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  const saveProfile = async (trimmedName: string) => {
    const headers = await authHeaders();
    const res = await fetch(`${API_URL}/api/users/profile`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmedName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? "Could not save profile. Try again.");
    }
  };

  const finishSetup = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || loading) return;
    setLoading(true);
    try {
      const user = getAuth().currentUser;
      if (!user) throw new Error("No authenticated user found.");
      await updateProfile(user, { displayName: trimmedName });
      await saveProfile(trimmedName);
      router.replace("/tabs/discord");
    } catch (error: any) {
      console.error("Finish setup error:", error);
      Alert.alert("Error", error.message || "Could not sync. Try again later.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          paddingTop: 60,
          paddingHorizontal: 20,
        }}
      >
        <Text style={{ color: colors.text, fontSize: 22, textAlign: "center" }}>
          Enter your name
        </Text>

        <TextInput
          placeholder="Type your name"
          placeholderTextColor={colors.muted}
          value={name}
          onChangeText={setName}
          style={{
            color: colors.text,
            borderBottomWidth: 1,
            borderBottomColor: colors.muted,
            fontSize: 16,
            paddingVertical: 10,
            marginBottom: 40,
            textAlign: "center",
          }}
        />

        <TouchableOpacity
          onPress={finishSetup}
          disabled={!name.trim() || loading}
          style={{
            backgroundColor: colors.primary,
            padding: 16,
            borderRadius: 30,
            alignItems: "center",
            opacity: !name.trim() || loading ? 0.5 : 1,
          }}
        >
          {loading ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <Text style={{ color: "#000", fontWeight: "bold" }}>Next</Text>
          )}
        </TouchableOpacity>
      </View>
    </Screen>
  );
}
