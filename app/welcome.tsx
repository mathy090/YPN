// app/welcome.tsx
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
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

export default function Welcome() {
  const router = useRouter();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  const handleCreateAccount = () => {
    router.push("/auth/phone");
  };

  const handleLogin = () => {
    router.push("/auth/otp");
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      <LinearGradient
        colors={["#0a0a14", "#000000", "#050508"]}
        style={StyleSheet.absoluteFill}
      />

      <View style={[styles.orb, styles.orb1]} />
      <View style={[styles.orb, styles.orb2]} />
      <View style={[styles.orb, styles.orb3]} />

      <SafeAreaView style={styles.safe}>
        <View style={styles.center}>
          <View style={styles.logoRing}>
            <View style={styles.logoRingInner} />
            <Image
              source={require("../assets/images/YPN.png")}
              style={styles.logo}
            />
          </View>

          <View style={styles.badge}>
            <Text style={styles.badgeText}>YPN MESSENGER</Text>
          </View>

          <Text style={styles.title}>Connect.{"\n"}Grow. Together.</Text>

          <Text style={styles.sub}>
            A private space for the YPN community — chat, share and support each
            other.
          </Text>

          <View style={styles.card}>
            <View style={styles.cardEdge} />

            <View style={styles.featureRow}>
              <Ionicons
                name="shield-checkmark-outline"
                size={18}
                color="#1DB954"
              />
              <Text style={styles.featureText}>Ubuntu Promoted</Text>
            </View>

            <View style={styles.featureRow}>
              <Ionicons name="people-outline" size={18} color="#1DB954" />
              <Text style={styles.featureText}>YPN community only</Text>
            </View>

            <View style={styles.featureRow}>
              <Ionicons name="flash-outline" size={18} color="#1DB954" />
              <Text style={styles.featureText}>
                AI-powered support for research
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.bottom}>
          <Text style={styles.terms}>
            By continuing you accept our Privacy Policy and Terms of Service.
          </Text>

          <TouchableOpacity
            onPress={handleCreateAccount}
            activeOpacity={0.85}
            style={styles.primaryBtn}
          >
            <LinearGradient
              colors={["#1DB954", "#17a347"]}
              style={styles.primaryGrad}
            >
              <Text style={styles.primaryText}>Create Account</Text>
            </LinearGradient>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={handleLogin}
            activeOpacity={0.8}
            style={styles.secondaryBtn}
          >
            <Text style={styles.secondaryText}>Already have an account</Text>
          </TouchableOpacity>

          <Text style={styles.copy}>© 2026 YPN Messenger</Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
  },

  safe: {
    flex: 1,
    justifyContent: "space-between",
  },

  center: {
    alignItems: "center",
    paddingTop: 60,
    paddingHorizontal: 20,
  },

  logoRing: {
    width: 120,
    height: 120,
    borderRadius: 60,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },

  logoRingInner: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: "#1DB954",
  },

  logo: {
    width: 70,
    height: 70,
    resizeMode: "contain",
  },

  badge: {
    backgroundColor: "#1DB95420",
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    marginBottom: 10,
  },

  badgeText: {
    color: "#1DB954",
    fontSize: 12,
    fontWeight: "600",
  },

  title: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "700",
    textAlign: "center",
    marginVertical: 10,
  },

  sub: {
    color: "#aaa",
    textAlign: "center",
    fontSize: 14,
    marginBottom: 20,
  },

  card: {
    backgroundColor: "#111",
    borderRadius: 16,
    padding: 16,
    width: "100%",
  },

  cardEdge: {
    height: 2,
    backgroundColor: "#1DB954",
    marginBottom: 10,
  },

  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginVertical: 4,
  },

  featureText: {
    color: "#fff",
    fontSize: 14,
  },

  bottom: {
    padding: 20,
  },

  terms: {
    color: "#777",
    fontSize: 12,
    textAlign: "center",
    marginBottom: 10,
  },

  primaryBtn: {
    borderRadius: 30,
    overflow: "hidden",
    marginBottom: 10,
  },

  primaryGrad: {
    paddingVertical: 14,
    alignItems: "center",
  },

  primaryText: {
    color: "#fff",
    fontWeight: "600",
  },

  secondaryBtn: {
    alignItems: "center",
    paddingVertical: 10,
  },

  secondaryText: {
    color: "#1DB954",
  },

  copy: {
    textAlign: "center",
    color: "#555",
    fontSize: 12,
    marginTop: 10,
  },

  orb: {
    position: "absolute",
    borderRadius: 999,
    opacity: 0.15,
    backgroundColor: "#1DB954",
  },

  orb1: {
    width: 200,
    height: 200,
    top: -50,
    left: -50,
  },

  orb2: {
    width: 150,
    height: 150,
    bottom: 100,
    right: -40,
  },

  orb3: {
    width: 100,
    height: 100,
    top: 200,
    right: 50,
  },
});
