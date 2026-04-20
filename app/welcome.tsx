// app/welcome.tsx
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useLocalSearchParams, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import {
  BackHandler,
  Image,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "../src/store/authStore";

export default function Welcome() {
  const router = useRouter();
  const { agreeToTerms, hasAgreed } = useAuth();
  const { kicked } = useLocalSearchParams<{ kicked?: string }>();
  const wasKicked = kicked === "true";

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  const handleAgree = async () => {
    await agreeToTerms();
    router.replace("/auth/phone");
  };

  const handleLogin = () => {
    router.replace("/auth/otp");
  };

  // WhatsApp style — already agreed before, show sign-in view
  if (hasAgreed) {
    return (
      <View style={s.root}>
        <StatusBar style="light" />
        <LinearGradient
          colors={["#0a0a14", "#000000", "#050508"]}
          style={StyleSheet.absoluteFill}
        />
        <View style={[s.orb, s.orb1]} />
        <View style={[s.orb, s.orb2]} />

        <SafeAreaView style={s.safe}>
          <View style={s.center}>
            <View style={s.logoRing}>
              <View style={s.logoRingInner} />
              <Image
                source={require("../assets/images/YPN.png")}
                style={s.logo}
              />
            </View>

            <View style={s.badge}>
              <Text style={s.badgeText}>YPN MESSENGER</Text>
            </View>

            {/* Kicked banner */}
            {wasKicked && (
              <View style={s.kickedBanner}>
                <Ionicons name="shield-outline" size={16} color="#FFA500" />
                <Text style={s.kickedText}>
                  Your session expired. Please verify yourself to continue.
                </Text>
              </View>
            )}

            <Text style={s.title}>
              {wasKicked ? "Session Expired" : "Welcome back"}
            </Text>
            <Text style={s.sub}>
              {wasKicked
                ? "Sign in again to confirm it's you."
                : "Sign in to reconnect with the YPN community."}
            </Text>
          </View>

          <View style={s.bottom}>
            <TouchableOpacity
              onPress={handleLogin}
              activeOpacity={0.85}
              style={s.primaryBtn}
            >
              <LinearGradient
                colors={["#1DB954", "#17a347"]}
                style={s.primaryGrad}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
              >
                <Text style={s.primaryText}>
                  {wasKicked ? "Verify Yourself" : "Sign In"}
                </Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={handleAgree}
              activeOpacity={0.8}
              style={s.secondaryBtn}
            >
              <Text style={s.secondaryText}>Create new account</Text>
            </TouchableOpacity>

            <Text style={s.copy}>© 2026 YPN Messenger</Text>
          </View>
        </SafeAreaView>
      </View>
    );
  }

  // First ever open — full onboarding
  return (
    <View style={s.root}>
      <StatusBar style="light" />
      <LinearGradient
        colors={["#0a0a14", "#000000", "#050508"]}
        style={StyleSheet.absoluteFill}
      />
      <View style={[s.orb, s.orb1]} />
      <View style={[s.orb, s.orb2]} />
      <View style={[s.orb, s.orb3]} />

      <SafeAreaView style={s.safe}>
        <View style={s.center}>
          <View style={s.logoRing}>
            <View style={s.logoRingInner} />
            <Image
              source={require("../assets/images/YPN.png")}
              style={s.logo}
            />
          </View>
          <View style={s.badge}>
            <Text style={s.badgeText}>YPN MESSENGER</Text>
          </View>
          <Text style={s.title}>Connect.{"\n"}Grow. Together.</Text>
          <Text style={s.sub}>
            A private space for the YPN community — chat, share and support each
            other.
          </Text>
          <View style={s.card}>
            <View style={s.cardEdge} />
            <View style={s.featureRow}>
              <Ionicons
                name="shield-checkmark-outline"
                size={18}
                color="#1DB954"
              />
              <Text style={s.featureText}>Ubuntu Promoted</Text>
            </View>
            <View style={s.featureRow}>
              <Ionicons name="people-outline" size={18} color="#1DB954" />
              <Text style={s.featureText}>YPN community only</Text>
            </View>
            <View style={s.featureRow}>
              <Ionicons name="flash-outline" size={18} color="#1DB954" />
              <Text style={s.featureText}>
                AI-powered support for research{" "}
              </Text>
            </View>
          </View>
        </View>

        <View style={s.bottom}>
          <Text style={s.terms}>
            By continuing you accept our Privacy Policy and Terms of Service.
          </Text>
          <TouchableOpacity
            onPress={handleAgree}
            activeOpacity={0.85}
            style={s.primaryBtn}
          >
            <LinearGradient
              colors={["#1DB954", "#17a347"]}
              style={s.primaryGrad}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
            >
              <Text style={s.primaryText}>Agree &amp; Create Account</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleLogin}
            activeOpacity={0.8}
            style={s.secondaryBtn}
          >
            <Text style={s.secondaryText}>Already have an account</Text>
          </TouchableOpacity>

          <Text style={s.copy}>© 2026 YPN Messenger</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  safe: { flex: 1, justifyContent: "space-between" },
  orb: { position: "absolute", borderRadius: 999 },
  orb1: {
    width: 340,
    height: 340,
    top: -80,
    left: -120,
    backgroundColor: "rgba(29,185,84,0.08)",
  },
  orb2: {
    width: 260,
    height: 260,
    bottom: 120,
    right: -80,
    backgroundColor: "rgba(29,185,84,0.06)",
  },
  orb3: {
    width: 180,
    height: 180,
    top: "40%",
    left: "30%",
    backgroundColor: "rgba(51,150,253,0.05)",
  },
  center: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingTop: 20,
  },
  logoRing: {
    alignSelf: "center",
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.3)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },
  logoRingInner: {
    position: "absolute",
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.15)",
  },
  logo: { width: 76, height: 76, borderRadius: 38 },
  badge: {
    alignSelf: "center",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.3)",
    paddingHorizontal: 14,
    paddingVertical: 5,
    marginBottom: 20,
    backgroundColor: "rgba(29,185,84,0.08)",
  },
  badgeText: {
    color: "#1DB954",
    fontSize: 11,
    letterSpacing: 1.5,
    fontWeight: "700",
  },
  kickedBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: "rgba(255,165,0,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,165,0,0.3)",
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  kickedText: { flex: 1, color: "#FFA500", fontSize: 13, lineHeight: 18 },
  title: {
    color: "#FFFFFF",
    fontSize: 34,
    fontWeight: "800",
    textAlign: "center",
    lineHeight: 42,
    marginBottom: 14,
  },
  sub: {
    color: "#B3B3B3",
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
    marginBottom: 28,
    paddingHorizontal: 8,
  },
  card: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    padding: 18,
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
  featureRow: { flexDirection: "row", alignItems: "center", marginVertical: 6 },
  featureText: { color: "rgba(255,255,255,0.7)", fontSize: 14, marginLeft: 10 },
  bottom: { paddingHorizontal: 24, paddingBottom: 16 },
  terms: {
    color: "rgba(255,255,255,0.3)",
    fontSize: 12,
    textAlign: "center",
    marginBottom: 16,
    lineHeight: 18,
  },
  primaryBtn: { borderRadius: 30, overflow: "hidden", marginBottom: 12 },
  primaryGrad: { paddingVertical: 16, alignItems: "center", borderRadius: 30 },
  primaryText: { color: "#000", fontWeight: "700", fontSize: 16 },
  secondaryBtn: {
    borderRadius: 30,
    borderWidth: 1,
    borderColor: "rgba(29,185,84,0.4)",
    paddingVertical: 15,
    alignItems: "center",
    marginBottom: 16,
    backgroundColor: "rgba(29,185,84,0.06)",
  },
  secondaryText: { color: "#1DB954", fontWeight: "600", fontSize: 15 },
  copy: { color: "rgba(255,255,255,0.2)", fontSize: 11, textAlign: "center" },
});
