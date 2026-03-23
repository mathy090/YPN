// app/auth/otp.tsx — Login
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  BackHandler,
  Image,
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
import { useAuth } from "../../src/store/authStore";

export default function OTP() {
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const isValid = email.includes("@") && password.length >= 8;

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      router.replace("/welcome");
      return true;
    });
    return () => sub.remove();
  }, []);

  const submit = async () => {
    if (!isValid || loading) return;
    Keyboard.dismiss();
    setError("");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
      const user = auth.currentUser;
      if (user) {
        const profile = await AsyncStorage.getItem(`YPN_PROFILE_${user.uid}`);
        login();
        router.replace(profile ? "/tabs/chats" : "/auth/device");
      }
    } catch (e: any) {
      setError(
        e.code === "auth/network-request-failed"
          ? "No internet connection."
          : "Invalid email or password.",
      );
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
        <TouchableOpacity
          style={s.back}
          onPress={() => router.replace("/welcome")}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={s.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={s.logoWrap}>
              <Image
                source={require("../../assets/images/YPN.png")}
                style={s.logo}
              />
            </View>

            <Text style={s.title}>Welcome back</Text>
            <Text style={s.sub}>Sign in to your YPN account</Text>

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
                  onChangeText={(t) => {
                    setEmail(t);
                    setError("");
                  }}
                  placeholder="you@email.com"
                  placeholderTextColor="#444"
                  style={s.input}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>

              <Text style={[s.label, { marginTop: 16 }]}>PASSWORD</Text>
              <View style={[s.row, password.length >= 8 && s.rowActive]}>
                <Ionicons
                  name="lock-closed-outline"
                  size={18}
                  color={password.length >= 8 ? "#1DB954" : "#555"}
                  style={s.icon}
                />
                <TextInput
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    setError("");
                  }}
                  placeholder="Your password"
                  placeholderTextColor="#444"
                  style={s.input}
                  secureTextEntry={!showPass}
                  onSubmitEditing={submit}
                  returnKeyType="done"
                />
                <TouchableOpacity onPress={() => setShowPass((p) => !p)}>
                  <Ionicons
                    name={showPass ? "eye-off-outline" : "eye-outline"}
                    size={18}
                    color="#555"
                  />
                </TouchableOpacity>
              </View>

              {error ? <Text style={s.err}>{error}</Text> : null}
            </View>

            <TouchableOpacity
              onPress={submit}
              disabled={!isValid || loading}
              activeOpacity={0.8}
              style={[s.btn, (!isValid || loading) && s.btnOff]}
            >
              {loading ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={s.btnText}>Sign In</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={s.link}
              onPress={() => router.replace("/auth/phone")}
            >
              <Text style={s.linkText}>
                No account?{" "}
                <Text style={{ color: "#1DB954", fontWeight: "600" }}>
                  Create one
                </Text>
              </Text>
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
  scroll: { paddingHorizontal: 24, paddingTop: 72, paddingBottom: 40 },
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
  back: {
    position: "absolute",
    top: 52,
    left: 20,
    zIndex: 10,
    padding: 8,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  logoWrap: { alignItems: "center", marginBottom: 24 },
  logo: { width: 72, height: 72, borderRadius: 36 },
  title: {
    color: "#fff",
    fontSize: 28,
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
    marginBottom: 6,
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
    height: 50,
  },
  rowActive: { borderColor: "#1DB954" },
  icon: { marginRight: 10 },
  input: { flex: 1, color: "#fff", fontSize: 15 },
  err: { color: "#E91429", fontSize: 12, marginTop: 10 },
  btn: {
    backgroundColor: "#1DB954",
    borderRadius: 30,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnOff: { backgroundColor: "#1a3d26", opacity: 0.6 },
  btnText: { color: "#000", fontWeight: "700", fontSize: 16 },
  link: { alignItems: "center", marginTop: 20 },
  linkText: { color: "#B3B3B3", fontSize: 14 },
});
