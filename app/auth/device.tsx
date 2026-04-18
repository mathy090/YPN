// app/auth/device.tsx
// Photo is stored locally on pick.
// Upload + profile save both happen only when user presses "Get Started".
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { getAuth } from "firebase/auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
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

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
const TOAST_DURATION = 4000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

// ── Username availability cache (session-only) ─────────────────────────────
const usernameCache = new Map<string, boolean>();

// ── Types ──────────────────────────────────────────────────────────────────
type UsernameStatus =
  | "idle"
  | "typing"
  | "checking"
  | "available"
  | "taken"
  | "invalid"
  | "error";

type PhotoState = "none" | "picked";
type StepStatus = "idle" | "loading" | "done" | "error";
type ToastType = "network" | "server" | null;
type Step = { key: string; label: string; status: StepStatus };

// ── Toast ──────────────────────────────────────────────────────────────────
function Toast({
  type,
  message,
  visible,
}: {
  type: ToastType;
  message: string;
  visible: boolean;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(24)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: visible ? 1 : 0,
        duration: 240,
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: visible ? 0 : 24,
        duration: 240,
        useNativeDriver: true,
      }),
    ]).start();
  }, [visible]);

  const isNetwork = type === "network";
  const bg = isNetwork ? "#1a1000" : "#1a0000";
  const border = isNetwork ? "#FFA500" : "#E91429";
  const color = isNetwork ? "#FFA500" : "#E91429";
  // ✅ FIXED: "wifi-off-outline" → "cloud-offline-outline" (valid Ionicons name)
  const icon = isNetwork ? "cloud-offline-outline" : "alert-circle-outline";

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        ts.wrap,
        {
          backgroundColor: bg,
          borderColor: border,
          opacity,
          transform: [{ translateY }],
        },
      ]}
    >
      <Ionicons name={icon as any} size={18} color={color} />
      <Text style={[ts.text, { color }]}>{message}</Text>
    </Animated.View>
  );
}

const ts = StyleSheet.create({
  wrap: {
    position: "absolute",
    bottom: 36,
    left: 20,
    right: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
    zIndex: 999,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 10,
  },
  text: { flex: 1, fontSize: 14, fontWeight: "500", lineHeight: 20 },
});

// ── Progress overlay ───────────────────────────────────────────────────────
function ProgressScreen({ steps }: { steps: Step[] }) {
  const allDone = steps.every((s) => s.status === "done");
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const successScale = useRef(new Animated.Value(0.4)).current;
  const successOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.08,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, []);

  useEffect(() => {
    if (allDone) {
      Animated.parallel([
        Animated.spring(successScale, {
          toValue: 1,
          friction: 5,
          useNativeDriver: true,
        }),
        Animated.timing(successOpacity, {
          toValue: 1,
          duration: 350,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [allDone]);

  return (
    <View style={ps.root}>
      <LinearGradient
        colors={["#001a0a", "#000000", "#001a0a"]}
        style={StyleSheet.absoluteFill}
      />
      <View style={ps.iconArea}>
        {allDone ? (
          <Animated.View
            style={[
              ps.successCircle,
              { transform: [{ scale: successScale }], opacity: successOpacity },
            ]}
          >
            <View style={ps.successRing} />
            <Ionicons name="checkmark" size={52} color="#1DB954" />
          </Animated.View>
        ) : (
          <Animated.View
            style={[ps.spinnerWrap, { transform: [{ scale: pulseAnim }] }]}
          >
            <ActivityIndicator size="large" color="#1DB954" />
          </Animated.View>
        )}
      </View>

      <Text style={ps.title}>
        {allDone ? "You're all set!" : "Setting up your account"}
      </Text>
      {allDone && (
        <Text style={ps.subtitle}>Redirecting to the community…</Text>
      )}

      <View style={ps.stepsWrap}>
        {steps.map((step) => (
          <View key={step.key} style={ps.stepRow}>
            <View style={ps.stepIconWrap}>
              {step.status === "loading" && (
                <ActivityIndicator size="small" color="#1DB954" />
              )}
              {step.status === "done" && (
                <Ionicons name="checkmark-circle" size={22} color="#1DB954" />
              )}
              {step.status === "error" && (
                <Ionicons name="close-circle" size={22} color="#E91429" />
              )}
              {step.status === "idle" && <View style={ps.idleDot} />}
            </View>
            <Text
              style={[
                ps.stepLabel,
                step.status === "done" && ps.stepDone,
                step.status === "error" && ps.stepError,
                step.status === "idle" && ps.stepIdle,
              ]}
            >
              {step.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const ps = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 200,
    backgroundColor: "#000",
    gap: 24,
    paddingHorizontal: 32,
  },
  iconArea: { height: 100, justifyContent: "center", alignItems: "center" },
  spinnerWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(29,185,84,0.1)",
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.25)",
    justifyContent: "center",
    alignItems: "center",
  },
  successCircle: {
    width: 100,
    height: 100,
    justifyContent: "center",
    alignItems: "center",
  },
  successRing: {
    position: "absolute",
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 2,
    borderColor: "#1DB954",
    backgroundColor: "rgba(29,185,84,0.12)",
  },
  title: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: "#555",
    fontSize: 14,
    textAlign: "center",
    marginTop: -16,
  },
  stepsWrap: {
    width: "100%",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 16,
    gap: 14,
  },
  stepRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  stepIconWrap: {
    width: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  idleDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  stepLabel: { color: "#fff", fontSize: 15, fontWeight: "500", flex: 1 },
  stepDone: { color: "#1DB954" },
  stepError: { color: "#E91429" },
  stepIdle: { color: "rgba(255,255,255,0.25)" },
});

// ── Main screen ────────────────────────────────────────────────────────────
export default function Device() {
  const router = useRouter();
  const params = useLocalSearchParams();

  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>("idle");
  const [usernameMsg, setUsernameMsg] = useState("");

  const [photoState, setPhotoState] = useState<PhotoState>("none");
  const [avatarLocalUri, setAvatarLocalUri] = useState<string | null>(null);
  const [avatarMime, setAvatarMime] = useState<string>("image/jpeg");

  const [showProgress, setShowProgress] = useState(false);
  const [steps, setSteps] = useState<Step[]>([
    { key: "photo", label: "Uploading photo...", status: "idle" },
    { key: "save", label: "Saving account...", status: "idle" },
  ]);

  const [toast, setToast] = useState<{ type: ToastType; message: string }>({
    type: null,
    message: "",
  });
  const [toastVisible, setToastVisible] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const usernameReady = usernameStatus === "available";
  const canSubmit = usernameReady && !showProgress;

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const showToast = useCallback((type: ToastType, message: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ type, message });
    setToastVisible(true);
    toastTimer.current = setTimeout(
      () => setToastVisible(false),
      TOAST_DURATION,
    );
  }, []);

  const setStep = useCallback(
    (key: string, status: StepStatus, label?: string) => {
      setSteps((prev) =>
        prev.map((s) =>
          s.key === key ? { ...s, status, ...(label ? { label } : {}) } : s,
        ),
      );
    },
    [],
  );

  const handlePickAvatar = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      showToast("server", "Please allow photo access.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];

    if (asset.fileSize && asset.fileSize > MAX_PHOTO_BYTES) {
      showToast("server", "Photo must be under 5 MB.");
      return;
    }

    setAvatarLocalUri(asset.uri);
    setAvatarMime(asset.mimeType ?? guessMime(asset.uri));
    setPhotoState("picked");
  }, [showToast]);

  const onUsernameChange = useCallback((raw: string) => {
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, "");
    setUsername(cleaned);

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

    if (usernameCache.has(cleaned)) {
      const available = usernameCache.get(cleaned)!;
      setUsernameStatus(available ? "available" : "taken");
      setUsernameMsg(
        available ? "Username is available" : "Username already taken.",
      );
      return;
    }

    setUsernameStatus("checking");
    setUsernameMsg("Checking availability…");

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `${API_URL}/api/auth/check-username?username=${encodeURIComponent(cleaned)}`,
        );
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          setUsernameStatus(
            data.code === "INVALID_FORMAT" ? "invalid" : "error",
          );
          setUsernameMsg(data.message ?? "Could not check username.");
          return;
        }

        usernameCache.set(cleaned, data.available);
        setUsernameStatus(data.available ? "available" : "taken");
        setUsernameMsg(
          data.available ? "Username is available" : "Username already taken.",
        );
      } catch {
        setUsernameStatus("error");
        setUsernameMsg("No connection. Try again.");
      }
    }, 600);
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    const authUser = getAuth().currentUser;
    const userEmail = authUser?.email || (params.userEmail as string);
    const userUid = authUser?.uid || (params.userUid as string);

    if (!userEmail || !userUid) {
      showToast("server", "Session expired. Please sign in again.");
      return;
    }

    setSteps([
      { key: "photo", label: "Uploading photo...", status: "idle" },
      { key: "save", label: "Saving account...", status: "idle" },
    ]);
    setShowProgress(true);

    let finalAvatarUrl: string | null = null;

    if (photoState === "none") {
      setStep("photo", "done", "Skipped");
    } else {
      setStep("photo", "loading", "Uploading photo...");
      try {
        finalAvatarUrl = await uploadAvatarToSupabase(
          avatarLocalUri!,
          avatarMime,
          userUid,
        );
        setStep("photo", "done", "Uploaded ✓");
      } catch (err: any) {
        setStep("photo", "error", "Upload failed");
        setShowProgress(false);
        if (err?.message === "network") {
          showToast("network", "No internet — photo upload failed.");
        } else if (err?.message === "size") {
          showToast("server", "Photo must be under 5 MB.");
        } else {
          showToast("server", "Photo upload failed. Try again.");
        }
        return;
      }
    }

    setStep("save", "loading");
    try {
      const payload: Record<string, string> = {
        uid: userUid,
        username: username.trim().toLowerCase(),
        name: username.trim(),
        email: userEmail,
      };
      // ✅ FIXED: field name matches server.js profile route which reads `avatarUrl`
      if (finalAvatarUrl) payload.avatarUrl = finalAvatarUrl;

      const res = await fetch(`${API_URL}/api/users/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStep("save", "error", "Failed");
        setShowProgress(false);

        if (body.code === "USERNAME_TAKEN") {
          setUsernameStatus("taken");
          setUsernameMsg("Just got taken. Please choose another.");
          showToast("server", "Username taken. Try another.");
        } else if (body.code === "USERNAME_LOCKED") {
          showToast("server", "Account already set up. Redirecting…");
          setTimeout(() => router.replace("/tabs/discord"), 1800);
        } else if (res.status >= 500) {
          showToast("server", "Server error. Please try again.");
        } else {
          showToast("server", body.message ?? "Something went wrong.");
        }
        return;
      }

      setStep("save", "done", "Saved ✓");
    } catch {
      setStep("save", "error", "Failed");
      setShowProgress(false);
      showToast("network", "No internet. Check connection and retry.");
      return;
    }

    setTimeout(() => router.replace("/tabs/discord"), 2000);
  }, [
    canSubmit,
    username,
    photoState,
    avatarLocalUri,
    avatarMime,
    showToast,
    setStep,
    router,
    params,
  ]);

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

  const disabledHint = !usernameReady
    ? usernameStatus === "checking"
      ? "Checking username…"
      : usernameStatus === "taken"
        ? "Choose another username."
        : "Enter a valid username first."
    : "";

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
            <TouchableOpacity
              style={s.avatarWrap}
              onPress={handlePickAvatar}
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
                <Ionicons
                  name={photoState === "picked" ? "checkmark" : "camera"}
                  size={14}
                  color="#000"
                />
              </View>
            </TouchableOpacity>

            <Text style={s.avatarHint}>
              {photoState === "picked"
                ? "Tap to change · uploads on submit"
                : "Add photo (optional)"}
            </Text>

            <Text style={s.title}>Choose your username</Text>
            <Text style={s.sub}>Enter a unique name to get started.</Text>

            <View style={s.card}>
              <View style={s.cardEdge} />
              <Text style={s.label}>USERNAME</Text>
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
                Letters, numbers, underscores · 3–20 chars
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.8}
              style={[s.btn, !canSubmit && s.btnOff]}
            >
              <Text style={s.btnText}>Get Started →</Text>
            </TouchableOpacity>

            {!canSubmit && disabledHint ? (
              <Text style={s.disabledHint}>{disabledHint}</Text>
            ) : null}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {showProgress && <ProgressScreen steps={steps} />}
      <Toast type={toast.type} message={toast.message} visible={toastVisible} />
    </View>
  );
}

// ── Avatar upload via backend → Supabase Storage ───────────────────────────
// Returns the full Supabase public URL (stored as avatarUrl in MongoDB)
async function uploadAvatarToSupabase(
  localUri: string,
  mimeType: string,
  uid: string,
): Promise<string> {
  console.log("[uploadAvatar] Starting upload:", {
    localUri: localUri.slice(0, 50) + "...",
    mimeType,
    uid,
  });

  const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";
  console.log("[uploadAvatar] API_URL:", API_URL);

  if (!API_URL) {
    console.error("[uploadAvatar] EXPO_PUBLIC_API_URL is not set");
    throw new Error("Configuration error: API_URL not set");
  }

  // ✅ FIXED: Use FormData for React Native compatibility
  const formData = new FormData();

  // @ts-ignore - React Native FormData accepts this format
  formData.append("file", {
    uri: localUri,
    type: mimeType,
    name: `avatar.${mimeType.split("/")[1] || "jpg"}`,
  });

  // ✅ Send uid via query string (no auth headers needed - public endpoint)
  const uploadUrl = `${API_URL}/api/avatar?uid=${encodeURIComponent(uid)}`;
  console.log("[uploadAvatar] Uploading to:", uploadUrl);

  let res: Response;
  try {
    res = await fetch(uploadUrl, {
      method: "POST",
      body: formData,
      // ✅ DO NOT set Content-Type header - let fetch set it with boundary
      headers: {
        Accept: "application/json",
      },
    });

    console.log("[uploadAvatar] Response status:", res.status);
  } catch (e: any) {
    console.error("[uploadAvatar] Fetch failed:", {
      message: e?.message,
      name: e?.name,
      type: e?.type,
    });
    throw new Error("network");
  }

  if (!res.ok) {
    const errorText = await res.text().catch(() => "unknown");
    console.error("[uploadAvatar] Server error:", res.status, errorText);
    throw new Error("server");
  }

  const body = await res.json().catch((e) => {
    console.error("[uploadAvatar] Failed to parse JSON:", e);
    return {};
  });

  if (!body.avatarUrl) {
    console.error("[uploadAvatar] No avatarUrl in response:", body);
    throw new Error("server");
  }

  console.log("[uploadAvatar] Success:", body.avatarUrl);
  return body.avatarUrl;
}

function guessMime(uri: string): string {
  const u = uri.toLowerCase();
  if (u.includes(".png")) return "image/png";
  if (u.includes(".webp")) return "image/webp";
  return "image/jpeg";
}

// ── Styles ─────────────────────────────────────────────────────────────────
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
  avatarHint: { fontSize: 12, color: "#555", marginBottom: 20 },
  title: {
    color: "#fff",
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
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
  icon: { marginRight: 10 },
  input: { flex: 1, color: "#fff", fontSize: 16 },
  usernameMsg: { fontSize: 12, marginTop: 6, marginLeft: 2 },
  usernameHint: { color: "#333", fontSize: 11, marginTop: 4, marginLeft: 2 },
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
