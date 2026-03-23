// app/auth/otp.tsx
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
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
import { auth, signInWithEmailAndPassword } from "../../src/firebase/auth";
import { useAuth } from "../../src/store/authStore";
import { colors } from "../../src/theme/colors";
import { saveToken, verifyWithBackend } from "../../src/utils/tokenManager";

export default function OTP() {
  const router = useRouter();
  const { login } = useAuth();
  const inputRef = useRef<TextInput>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showDone, setShowDone] = useState(false);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const spinAnim = useRef(new Animated.Value(0)).current;

  const isValid = email.includes("@") && password.length >= 8;

  // Android back → /welcome  (same as phone.tsx)
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      router.replace("/welcome");
      return true;
    });
    return () => sub.remove();
  }, []);

  const handleLogin = async () => {
    if (!isValid) return;

    Keyboard.dismiss();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    setLoading(true);
    setError("");
    fadeAnim.setValue(0);
    spinAnim.setValue(0);

    // Animated overlay — identical to phone.tsx
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 250,
      useNativeDriver: true,
    }).start();

    Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    ).start();

    try {
      // Step 1 — Firebase client auth
      const cred = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        password,
      );

      // Step 2 — Get Firebase ID token
      const idToken = await cred.user.getIdToken();

      // Step 3 — Backend verifies with Admin SDK + enforces email_verified
      const { uid, hasProfile } = await verifyWithBackend(idToken);

      // Step 4 — Persist token for future API calls
      await saveToken(idToken);

      // Step 5 — Cache session metadata (uid/email only, no passwords)
      await AsyncStorage.setItem(
        "YPN_SESSION",
        JSON.stringify({
          uid,
          email: cred.user.email,
          ts: Date.now(),
        }),
      );

      setLoading(false);
      setShowDone(true);
      login();

      // Short pause so the success modal is visible, then navigate
      setTimeout(() => {
        router.replace(hasProfile ? "/tabs/chats" : "/auth/device");
      }, 800);
    } catch (err: any) {
      setLoading(false);
      spinAnim.stopAnimation();

      if (err.code === "auth/network-request-failed") {
        setError("No internet connection.");
      } else if (
        err.code === "auth/user-not-found" ||
        err.code === "auth/wrong-password" ||
        err.code === "auth/invalid-credential"
      ) {
        setError("Invalid email or password.");
      } else if (err.code === "auth/too-many-requests") {
        setError("Too many attempts. Try again later.");
      } else if (err.code === "EMAIL_NOT_VERIFIED" || err.status === 403) {
        setError("Please verify your email before signing in.");
      } else {
        setError("Something went wrong. Please try again.");
        console.error("Login error:", err);
      }
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      {/* Back button — same position as phone.tsx */}
      <TouchableOpacity
        style={styles.back}
        onPress={() => router.replace("/welcome")}
      >
        <Text style={styles.backText}>Back</Text>
      </TouchableOpacity>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.info}>Sign in to your account</Text>

          <TextInput
            placeholder="Email"
            placeholderTextColor={colors.muted}
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setError("");
            }}
            style={styles.input}
            keyboardType="email-address"
            autoCapitalize="none"
            returnKeyType="next"
            onSubmitEditing={() => inputRef.current?.focus()}
          />

          <TextInput
            ref={inputRef}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError("");
            }}
            style={styles.input}
            returnKeyType="done"
            onSubmitEditing={handleLogin}
          />

          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.bottom}>
          <TouchableOpacity
            disabled={!isValid}
            onPress={handleLogin}
            style={[
              styles.next,
              { backgroundColor: !isValid ? "#555" : colors.primary },
            ]}
          >
            <Text style={styles.nextText}>Login</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Loading overlay — same pattern as phone.tsx */}
      {loading && (
        <Animated.View style={[styles.overlay, { opacity: fadeAnim }]}>
          <Animated.View
            style={{
              transform: [
                {
                  rotate: spinAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ["0deg", "360deg"],
                  }),
                },
              ],
            }}
          >
            <ActivityIndicator size="large" color={colors.primary} />
          </Animated.View>
          <Text style={styles.loadingText}>Signing in…</Text>
        </Animated.View>
      )}

      {/* Success blur modal — same pattern as phone.tsx */}
      {showDone && (
        <BlurView intensity={40} tint="dark" style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={styles.modalText}>Welcome back!</Text>
            <Text style={styles.emailDisplay}>{email}</Text>
          </View>
        </BlurView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  back: { position: "absolute", top: 12, left: 16, zIndex: 10 },
  backText: { color: colors.primary, fontSize: 16, fontWeight: "600" },
  content: { paddingTop: 80, paddingHorizontal: 20, paddingBottom: 140 },
  info: { color: colors.text, fontSize: 18, marginBottom: 30 },
  input: {
    borderBottomWidth: 1,
    borderBottomColor: colors.muted,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 12,
    marginBottom: 24,
  },
  errorText: {
    color: "#FF6B6B",
    fontSize: 14,
    marginBottom: 12,
    marginLeft: 2,
  },
  bottom: { position: "absolute", bottom: 20, left: 20, right: 20 },
  next: { padding: 14, borderRadius: 30, alignItems: "center" },
  nextText: { color: "#000", fontSize: 16, fontWeight: "bold" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: { color: colors.text, fontSize: 18, marginTop: 16 },
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  modal: {
    backgroundColor: "rgba(20,20,20,0.95)",
    padding: 24,
    borderRadius: 14,
    width: "80%",
    alignItems: "center",
  },
  modalText: { color: colors.text, fontSize: 16, marginBottom: 8 },
  emailDisplay: { color: colors.primary, fontSize: 15, fontWeight: "bold" },
});
