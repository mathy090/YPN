import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { sendPasswordResetEmail } from "firebase/auth";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { auth } from "../../src/firebase/auth";

export default function ForgotPassword() {
  const router = useRouter();

  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);

  const isValid = email.includes("@");
  const COOLDOWN_TIME = 15 * 60; // 15 minutes

  // 🔁 Restore cooldown if exists
  useEffect(() => {
    const loadCooldown = async () => {
      const saved = await AsyncStorage.getItem("reset_cooldown");
      if (saved) {
        const remaining = Math.floor((parseInt(saved) - Date.now()) / 1000);
        if (remaining > 0) {
          setCooldown(remaining);
        }
      }
    };
    loadCooldown();
  }, []);

  // ⏳ Countdown timer
  useEffect(() => {
    if (cooldown <= 0) return;

    const interval = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          clearInterval(interval);
          AsyncStorage.removeItem("reset_cooldown");
          return 0;
        }
        return c - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [cooldown]);

  const submit = async () => {
    if (!isValid || loading || cooldown > 0) return;

    Keyboard.dismiss();
    setError("");
    setLoading(true);

    const cleanEmail = email.trim().toLowerCase();

    // 🔴 Check network
    const state = await NetInfo.fetch();
    if (!state.isConnected) {
      setError("No internet connection. Try again later.");
      setLoading(false);
      return;
    }

    try {
      // 🔥 Send reset email (silent fail for security)
      await sendPasswordResetEmail(auth, cleanEmail).catch(() => {});

      // ⏳ Start cooldown
      const expiry = Date.now() + COOLDOWN_TIME * 1000;
      await AsyncStorage.setItem("reset_cooldown", expiry.toString());
      setCooldown(COOLDOWN_TIME);

      // ✅ Navigate
      router.replace({
        pathname: "/auth/reset-sent",
        params: { email: cleanEmail },
      });
    } catch {
      setError("Something went wrong. Try again later.");
    } finally {
      setLoading(false);
    }
  };

  // ⏱ Format time
  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec < 10 ? "0" : ""}${sec}`;
  };

  return (
    <View style={s.root}>
      <LinearGradient
        colors={["#0a0a14", "#000000", "#0a0a14"]}
        style={StyleSheet.absoluteFill}
      />

      <SafeAreaView style={s.safe}>
        <TouchableOpacity style={s.back} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView contentContainerStyle={s.scroll}>
            <Text style={s.title}>Reset Password</Text>
            <Text style={s.sub}>Enter your email to receive a reset link</Text>

            <View style={s.card}>
              <View style={s.cardEdge} />

              <Text style={s.label}>EMAIL</Text>
              <View style={[s.row, email.includes("@") && s.rowActive]}>
                <Ionicons
                  name="mail-outline"
                  size={18}
                  color={email.includes("@") ? "#1DB954" : "#555"}
                  style={s.icon}
                />
                <TextInput
                  value={email}
                  editable={cooldown === 0}
                  onChangeText={(t) => {
                    setEmail(t.trim());
                    setError("");
                  }}
                  placeholder="you@email.com"
                  placeholderTextColor="#444"
                  style={s.input}
                  keyboardType="email-address"
                  autoCapitalize="none"
                />
              </View>

              {error ? <Text style={s.err}>{error}</Text> : null}

              {cooldown > 0 && (
                <Text style={s.cooldownText}>
                  Try again in {formatTime(cooldown)}
                </Text>
              )}
            </View>

            <TouchableOpacity
              onPress={submit}
              disabled={!isValid || loading || cooldown > 0}
              style={[s.btn, (!isValid || loading || cooldown > 0) && s.btnOff]}
            >
              {loading ? (
                <ActivityIndicator color="#000" />
              ) : cooldown > 0 ? (
                <Text style={s.btnText}>Wait {formatTime(cooldown)}</Text>
              ) : (
                <Text style={s.btnText}>Send Reset Link</Text>
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
    paddingTop: 100,
    paddingBottom: 40,
  },

  back: {
    position: "absolute",
    top: 52,
    left: 20,
    zIndex: 10,
    padding: 8,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  title: {
    color: "#fff",
    fontSize: 26,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 6,
  },

  sub: {
    color: "#B3B3B3",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 28,
  },

  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 20,
    marginBottom: 20,
  },

  cardEdge: {
    position: "absolute",
    top: 0,
    height: 1,
    left: 0,
    right: 0,
    backgroundColor: "rgba(255,255,255,0.12)",
  },

  label: {
    color: "rgba(255,255,255,0.35)",
    fontSize: 11,
    marginBottom: 6,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 12,
    height: 50,
  },

  rowActive: { borderColor: "#1DB954" },

  icon: { marginRight: 10 },

  input: { flex: 1, color: "#fff" },

  err: {
    color: "#E91429",
    fontSize: 12,
    marginTop: 10,
  },

  cooldownText: {
    color: "#B3B3B3",
    fontSize: 12,
    marginTop: 10,
    textAlign: "right",
  },

  btn: {
    backgroundColor: "#1DB954",
    borderRadius: 30,
    paddingVertical: 16,
    alignItems: "center",
  },

  btnOff: {
    backgroundColor: "#1a3d26",
    opacity: 0.6,
  },

  btnText: {
    color: "#000",
    fontWeight: "700",
    fontSize: 16,
  },
});
