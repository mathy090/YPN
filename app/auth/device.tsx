// app/auth/device.tsx
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { getAuth, updateProfile } from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
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
import {
  checkUsernameAvailability,
  pickAndUploadAvatar,
} from "../../src/utils/profileUpload";
import { authHeaders } from "../../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

type UsernameStatus =
  | "idle"
  | "typing"
  | "checking"
  | "available"
  | "taken"
  | "invalid"
  | "error";

export default function Device() {
  const router = useRouter();

  // ── Form state ──────────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>("idle");
  const [usernameMsg, setUsernameMsg] = useState("");

  const [avatarLocalUri, setAvatarLocalUri] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState("");
  const [avatarLoading, setAvatarLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nameValid = name.trim().length >= 2;
  const usernameReady = usernameStatus === "available";
  const canSubmit = nameValid && usernameReady && !submitting;

  // ── Username input ──────────────────────────────────────────────────────────
  const onUsernameChange = useCallback((raw: string) => {
    // Force lowercase, strip disallowed chars
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
    setUsername(cleaned);
    setSubmitError("");

    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (cleaned.length === 0) {
      setUsernameStatus("idle");
      setUsernameMsg("");
      return;
    }

    if (cleaned.length < 3) {
      setUsernameStatus("typing");
      setUsernameMsg("At least 3 characters required.");
      return;
    }

    if (cleaned.length > 20) {
      setUsernameStatus("invalid");
      setUsernameMsg("Maximum 20 characters.");
      return;
    }

    setUsernameStatus("checking");
    setUsernameMsg("Checking availability…");

    debounceRef.current = setTimeout(async () => {
      const result = await checkUsernameAvailability(cleaned);

      if (!result.ok) {
        if (result.code === "NETWORK_ERROR") {
          setUsernameStatus("error");
          setUsernameMsg("No connection. Check your internet.");
        } else if (result.code === "INVALID_FORMAT") {
          setUsernameStatus("invalid");
          setUsernameMsg(result.message);
        } else {
          setUsernameStatus("error");
          setUsernameMsg("Sorry, this is on our side. Try again.");
        }
        return;
      }

      if (result.available) {
        setUsernameStatus("available");
        setUsernameMsg("Username is available");
      } else {
        setUsernameStatus("taken");
        setUsernameMsg("Username already taken.");
      }
    }, 600);
  }, []);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // ── Avatar pick ─────────────────────────────────────────────────────────────
  const handlePickAvatar = async () => {
    setAvatarError("");
    setAvatarLoading(true);

    const result = await pickAndUploadAvatar();
    setAvatarLoading(false);

    if (!result.ok) {
      // Don't block submit for photo — it's optional
      setAvatarError(result.error.message);
      return;
    }

    setAvatarLocalUri(result.localUri);
    setAvatarUrl(result.avatarUrl);
  };

  // ── Submit ──────────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitError("");
    setSubmitting(true);

    try {
      const user = getAuth().currentUser;
      if (!user) {
        setSubmitError("Session expired. Please sign in again.");
        return;
      }

      // Update Firebase display name
      await updateProfile(user, { displayName: name.trim() });

      // Save profile to backend
      let res: Response;
      try {
        const headers = await authHeaders();
        res = await fetch(`${API_URL}/api/users/profile`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            username: username.trim().toLowerCase(),
            ...(avatarUrl ? { avatarUrl } : {}),
          }),
        });
      } catch {
        setSubmitError("No connection. Check your internet and try again.");
        return;
      }

      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status >= 500) {
          setSubmitError("Sorry, this is on our side. Please try again later.");
        } else if (body.code === "USERNAME_TAKEN") {
          setUsernameStatus("taken");
          setUsernameMsg("Username just got taken. Choose another.");
          setSubmitError("Please choose a different username.");
        } else {
          setSubmitError(
            body.message ?? "Something went wrong. Please try again.",
          );
        }
        return;
      }

      router.replace("/tabs/discord");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Username row style helpers ──────────────────────────────────────────────
  const uColor: Record<UsernameStatus, string> = {
    idle: "#555",
    typing: "#555",
    checking: "#B3B3B3",
    available: "#1DB954",
    taken: "#E91429",
    invalid: "#E91429",
    error: "#FFA500",
  };

  const uIcon: Record<UsernameStatus, string> = {
    idle: "at-outline",
    typing: "at-outline",
    checking: "time-outline",
    available: "checkmark-circle-outline",
    taken: "close-circle-outline",
    invalid: "alert-circle-outline",
    error: "wifi-outline",
  };

  const uBorder: Record<UsernameStatus, string> = {
    idle: "rgba(255,255,255,0.08)",
    typing: "rgba(255,255,255,0.08)",
    checking: "rgba(255,255,255,0.15)",
    available: "#1DB954",
    taken: "#E91429",
    invalid: "#E91429",
    error: "#FFA500",
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
            {/* ── Avatar picker ─────────────────────────────────── */}
            <TouchableOpacity
              style={s.avatarWrap}
              onPress={handlePickAvatar}
              disabled={avatarLoading}
              activeOpacity={0.8}
            >
              {avatarLocalUri ? (
                <Image source={{ uri: avatarLocalUri }} style={s.avatar} />
              ) : (
                <View style={s.avatarPlaceholder}>
                  <Ionicons name="person-outline" size={36} color="#1DB954" />
                </View>
              )}
              <View style={s.avatarBadge}>
                {avatarLoading ? (
                  <ActivityIndicator size="small" color="#000" />
                ) : (
                  <Ionicons name="camera" size={14} color="#000" />
                )}
              </View>
            </TouchableOpacity>

            <Text style={s.avatarHint}>
              {avatarLocalUri
                ? "Tap to change photo"
                : "Add profile photo (optional)"}
            </Text>

            {avatarError ? (
              <View style={s.inlineError}>
                <Ionicons
                  name="alert-circle-outline"
                  size={14}
                  color="#E91429"
                />
                <Text style={s.inlineErrorText}>{avatarError}</Text>
              </View>
            ) : null}

            <Text style={s.title}>Set up your profile</Text>
            <Text style={s.sub}>
              Your name and username are visible to others in YPN.
            </Text>

            <View style={s.card}>
              <View style={s.cardEdge} />

              {/* ── Display name ──────────────────────────────────── */}
              <Text style={s.label}>DISPLAY NAME</Text>
              <View style={[s.row, name.trim().length >= 2 && s.rowActive]}>
                <Ionicons
                  name="person-outline"
                  size={18}
                  color={name.trim().length >= 2 ? "#1DB954" : "#555"}
                  style={s.icon}
                />
                <TextInput
                  value={name}
                  onChangeText={(t) => {
                    setName(t);
                    setSubmitError("");
                  }}
                  placeholder="Your name"
                  placeholderTextColor="#444"
                  style={s.input}
                  autoCapitalize="words"
                  autoCorrect={false}
                  maxLength={32}
                />
              </View>

              {/* ── Username ──────────────────────────────────────── */}
              <Text style={[s.label, { marginTop: 16 }]}>USERNAME</Text>
              <View style={[s.row, { borderColor: uBorder[usernameStatus] }]}>
                <Ionicons
                  name={uIcon[usernameStatus] as any}
                  size={18}
                  color={uColor[usernameStatus]}
                  style={s.icon}
                />
                <TextInput
                  value={username}
                  onChangeText={onUsernameChange}
                  placeholder="yourname"
                  placeholderTextColor="#444"
                  style={s.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={20}
                />
                {usernameStatus === "checking" && (
                  <ActivityIndicator size="small" color="#B3B3B3" />
                )}
              </View>

              {usernameMsg ? (
                <Text
                  style={[s.usernameMsg, { color: uColor[usernameStatus] }]}
                >
                  {usernameMsg}
                </Text>
              ) : null}

              <Text style={s.usernameHint}>
                Letters, numbers and underscores only · 3–20 characters
              </Text>
            </View>

            {/* ── Submit error ───────────────────────────────────── */}
            {submitError ? (
              <View style={s.errorBanner}>
                <Ionicons
                  name="alert-circle-outline"
                  size={16}
                  color="#E91429"
                />
                <Text style={s.errorBannerText}>{submitError}</Text>
              </View>
            ) : null}

            {/* ── Submit button ──────────────────────────────────── */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.8}
              style={[s.btn, !canSubmit && s.btnOff]}
            >
              {submitting ? (
                <ActivityIndicator color="#000" />
              ) : (
                <Text style={s.btnText}>Get Started →</Text>
              )}
            </TouchableOpacity>

            {/* Explain why button is disabled */}
            {!canSubmit && !submitting && (
              <Text style={s.disabledHint}>
                {!nameValid
                  ? "Enter your display name to continue."
                  : !usernameReady
                    ? usernameStatus === "checking"
                      ? "Checking username…"
                      : "Choose another available username to continue."
                    : ""}
              </Text>
            )}
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
    paddingTop: 40,
    paddingBottom: 60,
    flexGrow: 1,
    alignItems: "center",
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

  // Avatar
  avatarWrap: {
    width: 100,
    height: 100,
    borderRadius: 50,
    marginBottom: 8,
    alignSelf: "center",
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: "#1DB954",
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(29,185,84,0.12)",
    borderWidth: 2,
    borderColor: "rgba(29,185,84,0.3)",
    borderStyle: "dashed",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#1DB954",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "#000",
  },
  avatarHint: {
    color: "#555",
    fontSize: 12,
    marginBottom: 6,
  },
  inlineError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 8,
  },
  inlineErrorText: {
    color: "#E91429",
    fontSize: 12,
    flex: 1,
  },

  title: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
    marginTop: 8,
    alignSelf: "center",
  },
  sub: {
    color: "#B3B3B3",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 24,
    alignSelf: "center",
  },

  card: {
    width: "100%",
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

  usernameMsg: {
    fontSize: 12,
    marginTop: 6,
    marginLeft: 2,
  },
  usernameHint: {
    color: "#333",
    fontSize: 11,
    marginTop: 4,
    marginLeft: 2,
  },

  errorBanner: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(233,20,41,0.1)",
    borderWidth: 1,
    borderColor: "rgba(233,20,41,0.3)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: "#E91429",
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },

  btn: {
    width: "100%",
    backgroundColor: "#1DB954",
    borderRadius: 30,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 4,
  },
  btnOff: { backgroundColor: "#1a3d26", opacity: 0.6 },
  btnText: { color: "#000", fontWeight: "700", fontSize: 16 },

  disabledHint: {
    color: "#444",
    fontSize: 12,
    textAlign: "center",
    marginTop: 10,
  },
});
