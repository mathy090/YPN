// app/tabs/settings.tsx
//
// Logout calls authStore.logout() which:
//   1. Firebase signOut
//   2. AsyncStorage.clear()
//   3. SecureStore key deletes
//   4. expo-sqlite dbWipe() — videos, news, kv
//   5. Store reset (initialized:false, hasAgreed:false)
// Then navigates to /welcome.
// On next cold start, index.tsx finds no session anywhere → welcome.

import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import {
  Alert,
  Linking,
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../../src/store/authStore";

const ADMIN_EMAIL = "tafadzwarunowanda@gmail.com";

function openAdminEmail() {
  const subject = encodeURIComponent("YPN App Query");
  const body = encodeURIComponent(
    "Hi,\n\nI have a query regarding the YPN app.\n\nDetails:\n\nThank you!",
  );
  Linking.openURL(
    `mailto:${ADMIN_EMAIL}?subject=${subject}&body=${body}`,
  ).catch(() => Alert.alert("Error", "Could not open email client."));
}

export default function SettingsScreen() {
  const { logout, user } = useAuth();
  const router = useRouter();

  const handleSignOut = () => {
    Alert.alert(
      "Sign Out",
      "Are you sure? All local session data will be cleared.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign Out",
          style: "destructive",
          onPress: async () => {
            try {
              // Single call — wipes Firebase, AsyncStorage,
              // SecureStore, and expo-sqlite (ypn.db)
              await logout();
              // Navigate immediately — index gate is now bypassed
              // because we're going directly to /welcome, not /
              router.replace("/welcome");
            } catch (e) {
              console.error("[settings] logout error:", e);
              Alert.alert(
                "Sign Out Failed",
                "Could not sign out. Please try again.",
              );
            }
          },
        },
      ],
    );
  };

  const displayName = user?.displayName ?? "YPN Member";
  const displayEmail = user?.email ?? "";
  const avatarChar = (
    user?.displayName?.[0] ??
    user?.email?.[0] ??
    "Y"
  ).toUpperCase();

  return (
    <View style={s.root}>
      <View
        style={{
          height:
            Platform.OS === "android"
              ? (RNStatusBar.currentHeight ?? 24) + 12
              : 60,
        }}
      />

      <View style={s.header}>
        <Text style={s.title}>Settings</Text>
      </View>

      {/* Profile card */}
      <View style={s.profileCard}>
        <View style={s.avatarCircle}>
          <Text style={s.avatarText}>{avatarChar}</Text>
        </View>
        <View style={s.profileInfo}>
          <Text style={s.profileName}>{displayName}</Text>
          <Text style={s.profileEmail}>{displayEmail}</Text>
        </View>
      </View>

      {/* Admin contact */}
      <TouchableOpacity
        style={s.banner}
        onPress={openAdminEmail}
        activeOpacity={0.8}
      >
        <View style={s.bannerIcon}>
          <Ionicons name="flag-outline" size={20} color="#FFA500" />
        </View>
        <View style={s.bannerText}>
          <Text style={s.bannerTitle}>Have any queries?</Text>
          <Text style={s.bannerSub}>Reach out to admin for support</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color="#FFA500" />
      </TouchableOpacity>

      <View style={s.divider} />

      {/* Sign out */}
      <TouchableOpacity
        style={s.logoutBtn}
        onPress={handleSignOut}
        activeOpacity={0.8}
      >
        <Ionicons name="log-out-outline" size={20} color="#FF453A" />
        <Text style={s.logoutText}>Sign Out</Text>
      </TouchableOpacity>

      <Text style={s.version}>YPN © 2026</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
    paddingHorizontal: 20,
  },
  header: { paddingBottom: 24 },
  title: { color: "#fff", fontSize: 32, fontWeight: "800" },

  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111",
    borderRadius: 16,
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: "#222",
  },
  avatarCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#1DB95433",
    borderWidth: 2,
    borderColor: "#1DB954",
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: { color: "#1DB954", fontSize: 22, fontWeight: "700" },
  profileInfo: { flex: 1 },
  profileName: { color: "#fff", fontSize: 17, fontWeight: "600" },
  profileEmail: { color: "#8E8E93", fontSize: 13, marginTop: 2 },

  banner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1a1200",
    borderRadius: 14,
    padding: 14,
    gap: 12,
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#FFA50033",
  },
  bannerIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#FFA50022",
    justifyContent: "center",
    alignItems: "center",
  },
  bannerText: { flex: 1 },
  bannerTitle: { color: "#FFA500", fontSize: 14, fontWeight: "600" },
  bannerSub: { color: "#B3B3B3", fontSize: 12, marginTop: 2 },

  divider: {
    height: 1,
    backgroundColor: "#222",
    marginVertical: 24,
  },

  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#FF453A18",
    borderWidth: 1,
    borderColor: "#FF453A33",
    borderRadius: 14,
    padding: 16,
  },
  logoutText: { color: "#FF453A", fontSize: 16, fontWeight: "600" },

  version: {
    color: "#333",
    fontSize: 12,
    textAlign: "center",
    marginTop: "auto",
    paddingBottom: 120,
  },
});
