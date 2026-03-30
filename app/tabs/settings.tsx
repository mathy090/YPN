import { Ionicons } from "@expo/vector-icons";
import { useNavigation } from "@react-navigation/native";
import {
  Alert,
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAuth } from "../../src/store/authStore";

type RootStackParamList = {
  Login: undefined;
  OTP: { email?: string }; // adjust params as needed
  // ... other routes
};

export default function SettingsScreen() {
  const { logout, user } = useAuth();
  const navigation =
    useNavigation<
      typeof import("@react-navigation/native").NavigationProp<RootStackParamList>
    >();

  const handleSignOut = async () => {
    try {
      await logout();

      // Reset navigation stack to prevent back-navigation to protected screens
      navigation.reset({
        index: 0,
        routes: [{ name: "Login" }],
      });

      // Optional: Navigate to OTP after login if your flow requires it
      // Uncomment and adjust based on your auth flow:
      // navigation.navigate("OTP", { email: user?.email });
    } catch (error) {
      console.error("Sign out failed:", error);

      // Fallback: Always navigate to login even if logout fails locally
      // This prevents UI being stuck in authenticated state
      navigation.reset({
        index: 0,
        routes: [{ name: "Login" }],
      });

      // Inform user of issue (non-blocking)
      Alert.alert(
        "Sign Out Issue",
        "You may still be signed in on this device. Please try again or contact support.",
        [{ text: "OK", style: "cancel" }],
      );
    }
  };

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
          <Text style={s.avatarText}>
            {(user?.displayName?.[0] ?? user?.email?.[0] ?? "Y").toUpperCase()}
          </Text>
        </View>
        <View style={s.profileInfo}>
          <Text style={s.profileName}>{user?.displayName ?? "YPN Member"}</Text>
          <Text style={s.profileEmail}>{user?.email ?? ""}</Text>
        </View>
      </View>

      <View style={s.divider} />

      {/* Logout */}
      <TouchableOpacity
        style={s.logoutBtn}
        onPress={handleSignOut}
        activeOpacity={0.8}
        disabled={false} // explicitly allow press; error handled internally
      >
        <Ionicons name="log-out-outline" size={20} color="#FF453A" />
        <Text style={s.logoutText}>Sign Out</Text>
      </TouchableOpacity>

      <Text style={s.version}>YPN © 2026</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000", paddingHorizontal: 20 },
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
  divider: { height: 1, backgroundColor: "#222", marginVertical: 24 },
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
