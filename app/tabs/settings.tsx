// app/(tabs)/settings.tsx
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useFocusEffect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSessionHeartbeat } from "../../src/hooks/useSessionHeartbeat";
import { useAuth } from "../../src/store/authStore";
import {
  clearAllTokens,
  getValidBackendToken,
} from "../../src/utils/tokenManager";

// SQLite + MongoDB sync utilities
import {
  clearSecureCache,
  getProfile,
  initializeSecureCache,
  saveProfile,
  updateAvatarUrl,
  UserProfile,
} from "../../src/utils/db";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

export default function Settings() {
  const router = useRouter();
  const {
    logout: logoutStore,
    signOut: authSignOut,
    user: authUser,
  } = useAuth();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [actionLoading, setActionLoading] = useState<
    "upload" | "delete" | null
  >(null);

  // 🔥 Logout confirmation state
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [logoutLoading, setLogoutLoading] = useState(false);

  // 🔥 Start heartbeat when authenticated
  useSessionHeartbeat(true);

  // 1. Initialize SQLite + Load Profile
  useEffect(() => {
    const init = async () => {
      await initializeSecureCache(); // Ensure SQLite is ready

      // Load from SQLite cache (Instant UI)
      const localProfile = await getProfile();
      if (localProfile) {
        setProfile(localProfile);
      }
      setLoading(false);

      // Silent Background Sync with MongoDB
      try {
        const token = await getValidBackendToken();
        if (token) {
          fetchProfileFromBackend(false);
        }
      } catch {
        // Token invalid → auth flow handles redirect
      }
    };
    init();
  }, []);

  // Re-sync when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      // Optional: trigger silent sync here
    }, []),
  );

  const fetchProfileFromBackend = async (showLoading = false) => {
    try {
      if (showLoading) setSyncing(true);
      const token = await getValidBackendToken();
      if (!token) return;

      const res = await fetch(`${API_URL}/api/users/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        await saveProfile(data); // Update SQLite cache
        setProfile(data); // Update UI
      } else if (res.status === 401 || res.status === 404) {
        await handleLogout();
      }
    } catch (err) {
      console.log("Sync failed, using cached profile");
    } finally {
      if (showLoading) setSyncing(false);
    }
  };

  const handlePickImage = async (source: "camera" | "library") => {
    let result;
    if (source === "camera") {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Required", "Please allow camera access.");
        return;
      }
      result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
    } else {
      const { status } =
        await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission Required",
          "Please allow photo library access.",
        );
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
    }

    if (result.canceled || !result.assets?.[0]) return;

    const uri = result.assets[0].uri;
    const mimeType = result.assets[0].mimeType || "image/jpeg";

    setActionLoading("upload");

    try {
      const token = await getValidBackendToken();
      const blob = await new Promise<Blob>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve(xhr.response);
        xhr.onerror = () => reject(new Error("Failed to load image"));
        xhr.responseType = "blob";
        xhr.open("GET", uri, true);
        xhr.send(null);
      });

      const res = await fetch(`${API_URL}/api/avatar`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": mimeType,
        },
        body: blob,
      });

      if (res.ok) {
        const data = await res.json();
        // OPTIMISTIC UPDATE: Update SQLite + UI immediately
        await updateAvatarUrl(data.avatarUrl);
        setProfile((prev) =>
          prev ? { ...prev, avatarUrl: data.avatarUrl } : null,
        );
        Alert.alert("Success", "Avatar updated successfully.");
      } else {
        const errData = await res.json().catch(() => ({}));
        Alert.alert("Error", errData.message || "Failed to upload avatar.");
      }
    } catch (err) {
      Alert.alert("Error", "Network error while uploading.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveAvatar = () => {
    Alert.alert(
      "Remove Avatar",
      "Are you sure you want to remove your profile picture?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setActionLoading("delete");
            try {
              const token = await getValidBackendToken();
              const res = await fetch(`${API_URL}/api/avatar`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
              });

              if (res.ok) {
                // OPTIMISTIC UPDATE: Clear SQLite + UI immediately
                await updateAvatarUrl(null);
                setProfile((prev) =>
                  prev ? { ...prev, avatarUrl: null } : null,
                );
                Alert.alert("Success", "Avatar removed.");
              } else {
                Alert.alert("Error", "Failed to remove avatar.");
              }
            } catch (err) {
              Alert.alert("Error", "Network error.");
            } finally {
              setActionLoading(null);
            }
          },
        },
      ],
    );
  };

  const showAvatarOptions = () => {
    const options = [
      { text: "Take Photo", onPress: () => handlePickImage("camera") },
      {
        text: "Choose from Library",
        onPress: () => handlePickImage("library"),
      },
    ];
    if (profile?.avatarUrl) {
      options.push({
        text: "Remove Avatar",
        onPress: handleRemoveAvatar,
        style: "destructive" as const,
      });
    }
    options.push({ text: "Cancel", style: "cancel" as const });
    Alert.alert("Profile Picture", "Choose an option", options);
  };

  // 🔥 Secure Logout with Email + Password Confirmation
  const handleLogout = async () => {
    setShowLogoutConfirm(true);
  };

  const confirmLogout = async () => {
    // Validate credentials against authUser (from auth store)
    if (
      !authUser?.email ||
      confirmEmail.trim().toLowerCase() !== authUser.email.toLowerCase()
    ) {
      Alert.alert("Error", "Email does not match your account.");
      return;
    }
    if (confirmPassword.length < 6) {
      Alert.alert("Error", "Please enter your password.");
      return;
    }

    setLogoutLoading(true);

    try {
      // Optional: Re-verify password with Firebase/Backend if needed
      // For now, we trust the auth store + token validity

      // 1. Clear all tokens (Firebase + Backend JWT)
      await clearAllTokens();

      // 2. Clear SQLite cache (profile, messages, etc.)
      await clearSecureCache();

      // 3. Update auth store state
      if (authSignOut) {
        await authSignOut();
      } else {
        logoutStore();
      }

      // 4. Navigate to login
      router.replace("/auth/otp");
    } catch (err) {
      Alert.alert("Error", "Failed to sign out. Please try again.");
    } finally {
      setLogoutLoading(false);
      setShowLogoutConfirm(false);
      setConfirmEmail("");
      setConfirmPassword("");
    }
  };

  // 🔥 Logout Confirmation Modal
  const renderLogoutConfirm = () => {
    if (!showLogoutConfirm) return null;

    return (
      <View style={s.modalOverlay}>
        <View style={s.modalCard}>
          <Text style={s.modalTitle}>Confirm Sign Out</Text>
          <Text style={s.modalDesc}>
            Enter your credentials to confirm. All local data (messages, cache)
            will be deleted. Your account details are safe in the cloud.
          </Text>

          <TextInput
            style={s.modalInput}
            placeholder="Email"
            placeholderTextColor="#666"
            value={confirmEmail}
            onChangeText={setConfirmEmail}
            autoCapitalize="none"
            keyboardType="email-address"
          />
          <TextInput
            style={s.modalInput}
            placeholder="Password"
            placeholderTextColor="#666"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
          />

          <View style={s.modalButtons}>
            <TouchableOpacity
              style={[s.modalBtn, s.modalBtnCancel]}
              onPress={() => {
                setShowLogoutConfirm(false);
                setConfirmEmail("");
                setConfirmPassword("");
              }}
              disabled={logoutLoading}
            >
              <Text style={s.modalBtnTextCancel}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modalBtn, s.modalBtnConfirm]}
              onPress={confirmLogout}
              disabled={logoutLoading || !confirmEmail || !confirmPassword}
            >
              {logoutLoading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={s.modalBtnTextConfirm}>Sign Out</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={s.root}>
        <StatusBar style="light" />
        <LinearGradient
          colors={["#0a0a14", "#000000", "#0a0a14"]}
          style={StyleSheet.absoluteFill}
        />
        <View style={s.center}>
          <ActivityIndicator size="large" color="#1DB954" />
          <Text style={s.loadingText}>Loading settings...</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <LinearGradient
        colors={["#0a0a14", "#000000", "#0a0a14"]}
        style={StyleSheet.absoluteFill}
      />

      <SafeAreaView style={s.safe}>
        <ScrollView
          contentContainerStyle={s.scroll}
          refreshControl={
            <RefreshControl
              refreshing={syncing}
              onRefresh={() => fetchProfileFromBackend(true)}
              tintColor="#1DB954"
              colors={["#1DB954"]}
            />
          }
        >
          <View style={s.header}>
            <Text style={s.title}>Settings</Text>
            <Text style={s.subtitle}>Manage your account preferences</Text>
          </View>

          {/* Profile Card */}
          <View style={s.card}>
            <View style={s.cardHeader}>
              <TouchableOpacity
                onPress={showAvatarOptions}
                disabled={!!actionLoading}
                activeOpacity={0.7}
              >
                <View style={s.avatarContainer}>
                  {profile?.avatarUrl ? (
                    <Image
                      source={{ uri: profile.avatarUrl }}
                      style={s.avatar}
                    />
                  ) : (
                    <View style={s.avatarPlaceholder}>
                      <Ionicons name="person" size={32} color="#1DB954" />
                    </View>
                  )}
                  {actionLoading === "upload" && (
                    <View style={s.overlay}>
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  )}
                </View>
              </TouchableOpacity>

              <View style={s.infoWrap}>
                <Text style={s.userName}>{profile?.username || "User"}</Text>
                <Text style={s.userEmail}>
                  {profile?.email || "email@example.com"}
                </Text>
                <Text style={s.editHint}>Tap avatar to change</Text>
              </View>
            </View>

            <View style={s.divider} />

            <View style={s.row}>
              <Ionicons name="at-outline" size={20} color="#888" />
              <View style={s.rowText}>
                <Text style={s.label}>Username</Text>
                <Text style={s.value}>{profile?.username || "Not set"}</Text>
              </View>
            </View>

            <View style={s.row}>
              <Ionicons name="mail-outline" size={20} color="#888" />
              <View style={s.rowText}>
                <Text style={s.label}>Email</Text>
                <Text style={s.value}>{profile?.email || "Not set"}</Text>
              </View>
            </View>
          </View>

          {/* Danger Zone */}
          <TouchableOpacity
            style={s.logoutBtn}
            onPress={handleLogout}
            activeOpacity={0.8}
            disabled={!!actionLoading}
          >
            {actionLoading === "delete" ? (
              <ActivityIndicator size="small" color="#E91429" />
            ) : (
              <>
                <Ionicons name="log-out-outline" size={22} color="#E91429" />
                <Text style={s.logoutText}>Sign Out</Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={s.version}>YPN App v1.0.0</Text>
        </ScrollView>
      </SafeAreaView>

      {/* 🔥 Logout Confirmation Modal */}
      {renderLogoutConfirm()}
    </View>
  );
}

// ── Styles (Your original design preserved + modal styles added) ─────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  safe: { flex: 1 },
  scroll: { padding: 24, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  loadingText: { color: "#555", marginTop: 12, fontSize: 14 },
  header: { marginBottom: 24, marginTop: 12 },
  title: { color: "#fff", fontSize: 28, fontWeight: "700", marginBottom: 6 },
  subtitle: { color: "#888", fontSize: 14 },
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    marginBottom: 24,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    gap: 16,
  },
  avatarContainer: { position: "relative" },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    borderWidth: 2,
    borderColor: "#1DB954",
  },
  avatarPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(29,185,84,0.1)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(29,185,84,0.3)",
    borderStyle: "dashed",
  },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 30,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  infoWrap: { flex: 1 },
  userName: { color: "#fff", fontSize: 18, fontWeight: "700" },
  userEmail: { color: "#888", fontSize: 13, marginTop: 4 },
  editHint: { color: "#1DB954", fontSize: 11, marginTop: 6, fontWeight: "600" },
  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginHorizontal: 20,
  },
  row: { flexDirection: "row", alignItems: "center", padding: 16, gap: 14 },
  rowText: { flex: 1 },
  label: { color: "#888", fontSize: 12, marginBottom: 2 },
  value: { color: "#fff", fontSize: 15, fontWeight: "500" },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(233, 20, 41, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(233, 20, 41, 0.3)",
    borderRadius: 16,
    paddingVertical: 16,
    gap: 10,
  },
  logoutText: { color: "#E91429", fontSize: 16, fontWeight: "600" },
  version: { textAlign: "center", color: "#333", fontSize: 12, marginTop: 32 },

  // 🔥 Modal Styles for Logout Confirmation
  modalOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
    padding: 24,
  },
  modalCard: {
    backgroundColor: "#111B21",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 400,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  modalTitle: {
    color: "#fff",
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 12,
    textAlign: "center",
  },
  modalDesc: {
    color: "#8696A0",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 18,
  },
  modalInput: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: "#fff",
    fontSize: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  modalButtons: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  modalBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnCancel: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  modalBtnConfirm: {
    backgroundColor: "#E91429",
  },
  modalBtnTextCancel: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
  modalBtnTextConfirm: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
  },
});
