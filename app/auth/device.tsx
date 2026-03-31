// app/auth/device.tsx — Profile name setup (runs once after first registration)
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { getAuth, updateProfile } from "firebase/auth";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { authHeaders } from "../../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL;

export default function Device() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isValid = name.trim().length >= 2;

  const saveProfile = async (trimmedName: string) => {
    const headers = await authHeaders();
    const res = await fetch(`${API_URL}/api/users/profile`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: trimmedName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message ?? "Could not save profile.");
    }
  };

  const finishSetup = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || loading) return;
    setError("");
    setLoading(true);
    try {
      const user = getAuth().currentUser;
      if (!user) throw new Error("No authenticated user found.");
      await updateProfile(user, { displayName: trimmedName });
      await saveProfile(trimmedName);
      // Home is always discord
      router.replace("/tabs/discord");
    } catch (e: any) {
      console.error("Finish setup error:", e);
      setError(e.message ?? "Could not save. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <LinearGradient
        colors={["#0a0a14", "#000000", "#0a0a14"]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[s.orb, s.orb1]} />
      <View style={[s.orb, s.orb2]} />

      <SafeAreaView style={s.safe}>
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={s.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Icon */}
            <View style={s.iconWrap}>
              <View style={s.iconCircle}>
                <Ionicons name="person-outline" size={36} color="#1DB954" />
              </View>
            </View>

            <Text style={s.title}>What's your name?</Text>
            <Text style={s.sub}>
              This is how you'll appear to others in the YPN community.
            </Text>

            <View style={s.card}>
              <View style={s.cardEdge} />
              <Text style={s.label}>DISPLAY NAME</Text>
              <View style={[s.row, isValid && s.rowActive]}>
                <Ionicons
                  name="person-outline"
                  size={18}
                  color={isValid ? "#1DB954" : "#555"}
                  style={s.icon}
                />
                <TextInput
                  value={name}
                  onChangeText={(t) => {
                    setName(t);
                    setError("");
                  }}
                  placeholder="Your name"
                  placeholderTextColor="#444"
                  style={s.input}
                  autoCapitalize="words"
                  autoCorrect={false}
                  maxLength={32}
                  onSubmitEditing={finishSetup}
                  returnKeyType="done"
                />
              </View>
              {error ? <Text style={s.err}>{error}</Text> : null}
            </View>

            <TouchableOpacity
              onPress={finishSetup}
              disabled={!isValid || loading}
              activeOpacity={0.8}
              style={[s.btn, (!isValid || loading) && s.btnOff]}
            >
              {loading ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={s.btnText}>Get Started →</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  safe: { flex: 1 },
  scroll: {
    paddingHorizontal: 24,
    paddingTop: 80,
    paddingBottom: 40,
    flexGrow: 1,
    justifyContent: "center",
  },

  orb: { position: "absolute", borderRadius: 999 },
  orb1: {
    width: 300,
    height: 300,
    top: -60,
    left: -80,
    backgroundColor: "rgba(29,185,84,0.07)",
  },
  orb2: {
    width: 220,
    height: 220,
    bottom: 100,
    right: -60,
    backgroundColor: "rgba(29,185,84,0.05)",
  },

  iconWrap: { alignItems: "center", marginBottom: 28 },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "rgba(29,185,84,0.12)",
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },

  title: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 10,
  },
  sub: {
    color: "#B3B3B3",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 32,
    paddingHorizontal: 8,
  },

  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 20,
    marginBottom: 24,
    overflow: "hidden",
  },
  cardEdge: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.12)",
  },

  label: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 8,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 12,
    height: 52,
  },
  rowActive: { borderColor: "#1DB954" },
  icon: { marginRight: 10 },
  input: { flex: 1, color: "#fff", fontSize: 16 },
  err: { color: "#E91429", fontSize: 12, marginTop: 10 },

  btn: {
    backgroundColor: "#1DB954",
    borderRadius: 30,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnOff: { backgroundColor: "#1a3d26", opacity: 0.6 },
  btnText: { color: "#000", fontWeight: "700", fontSize: 16 },
});
