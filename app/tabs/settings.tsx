// app/(tabs)/settings.tsx
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../../src/store/authStore";
import { clearToken, getToken } from "../../src/utils/tokenManager";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "";

type UserProfile = {
  username?: string;
  email?: string;
  name?: string;
  avatarUrl?: string | null;
};

export default function Settings() {
  const router = useRouter();
  const { logout: logoutStore } = useAuth();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [actionLoading, setActionLoading] = useState<"upload" | "delete" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      const token = await getToken();
      if (!token) {
        setError("No session found");
        setLoading(false);
        return;
      }

      const res = await fetch(`${API_URL}/api/users/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setProfile(data);
      } else {
        if (res.status === 401 || res.status === 404) {
          await handleLogout();
          return;
        }
        setError("Failed to load profile");
      }
    } catch (err) {
      setError("Network error");
    } finally {
      setLoading(false);
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
        mediaTypes: ImagePicker.MediaType.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert("Permission Required", "Please allow photo library access.");
        return;
      }
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaType.Images,
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
      const token = await getToken();
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
        // Update local state immediately
        setProfile((prev) => prev ? { ...prev, avatarUrl: data.avatarUrl } : null);
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
              const token = await getToken();
              const res = await fetch(`${API_URL}/api/avatar`, {
                method: "DELETE",
                headers: { Authorization: `Bearer ${token}` },
              });

              if (res.ok) {
                setProfile((prev) => prev ? { ...prev, avatarUrl: null } : null);
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
      ]
    );
  };

  const showAvatarOptions = () => {
    const options = [
      { text: "Take Photo", onPress: () => handlePickImage("camera") },
      { text: "Choose from Library", onPress: () => handlePickImage("library") },
    ];
    if (profile?.avatarUrl) {
      options.push({ text: "Remove Avatar", onPress: handleRemoveAvatar, style: "destructive" as const });
    }
    options.push({ text: "Cancel", style: "cancel" as const });

    Alert.alert("Profile Picture", "Choose an option", options);
  };

  const handleLogout = () => {
    Alert.alert("Sign Out", "Are you sure you want to sign out?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign Out",
        style: "destructive",
        onPress: async () => {
          await clearToken();
          logoutStore();
          router.replace("/welcome");
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={s.root}>
        <StatusBar style="light" />
        <LinearGradient colors={["#0a0a14", "#000000", "#0a0a14"]} style={StyleSheet.absoluteFill} />
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
      <LinearGradient colors={["#0a0a14", "#000000", "#0a0a14"]} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={s.safe}>
        <ScrollView contentContainerStyle={s.scroll}>
          <View style={s.header}>
            <Text style={s.title}>Settings</Text>
            <Text style={s.subtitle}>Manage your account preferences</Text>
          </View>

          {/* Profile Card */}
          <View style={s.card}>
            <View style={s.cardHeader}>
              <TouchableOpacity onPress={showAvatarOptions} disabled={!!actionLoading} activeOpacity={0.7}>
                <View style={s.avatarContainer}>
                  {profile?.avatarUrl ? (
                    <Image source={{ uri: profile.avatarUrl }} style={s.avatar} />
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
                <Text style={s.userEmail}>{profile?.email || "email@example.com"}</Text>
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
          <TouchableOpacity style={s.logoutBtn} onPress={handleLogout} activeOpacity={0.8} disabled={!!actionLoading}>
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
    </View>
  );
}

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
  cardHeader: { flexDirection: "row", alignItems: "center", padding: 20, gap: 16 },
  avatarContainer: { position: "relative" },
  avatar: { width: 60, height: 60, borderRadius: 30, borderWidth: 2, borderColor: "#1DB954" },
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
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 30,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  infoWrap: { flex: 1 },
  userName: { color: "#fff", fontSize: 18, fontWeight: "700" },
  userEmail: { color: "#888", fontSize: 13, marginTop: 4 },
  editHint: { color: "#1DB954", fontSize: 11, marginTop: 6, fontWeight: "600" },
  divider: { height: 1, backgroundColor: "rgba(255,255,255,0.08)", marginHorizontal: 20 },
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
});