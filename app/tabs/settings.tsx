// app/(tabs)/settings.tsx
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
  avatarFileId?: string;
};

export default function Settings() {
  const router = useRouter();
  const { logout: logoutStore } = useAuth();

  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<UserProfile | null>(null);
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
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setProfile(data);
      } else {
        // If 401/404, token might be invalid
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
        <ScrollView contentContainerStyle={s.scroll}>
          {/* Header */}
          <View style={s.header}>
            <Text style={s.title}>Settings</Text>
            <Text style={s.subtitle}>Manage your account preferences</Text>
          </View>

          {/* Profile Card */}
          <View style={s.card}>
            <View style={s.cardHeader}>
              <View style={s.avatarPlaceholder}>
                <Ionicons name="person" size={32} color="#1DB954" />
              </View>
              <View style={s.infoWrap}>
                <Text style={s.userName}>{profile?.username || "User"}</Text>
                <Text style={s.userEmail}>
                  {profile?.email || "email@example.com"}
                </Text>
              </View>
            </View>

            <View style={s.divider} />

            {/* Account Details List */}
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

            {/* Note: Change Password option removed as requested */}
          </View>

          {/* Danger Zone */}
          <TouchableOpacity
            style={s.logoutBtn}
            onPress={handleLogout}
            activeOpacity={0.8}
          >
            <Ionicons name="log-out-outline" size={22} color="#E91429" />
            <Text style={s.logoutText}>Sign Out</Text>
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
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 20,
    gap: 16,
  },
  avatarPlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "rgba(29,185,84,0.1)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.3)",
  },
  infoWrap: { flex: 1 },
  userName: { color: "#fff", fontSize: 18, fontWeight: "700" },
  userEmail: { color: "#888", fontSize: 13, marginTop: 4 },

  divider: {
    height: 1,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginHorizontal: 20,
  },

  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    gap: 14,
  },
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
