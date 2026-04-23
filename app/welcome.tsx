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

  // Android back button → exit app
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      BackHandler.exitApp();
      return true;
    });
    return () => sub.remove();
  }, []);

  // ✅ SIMPLE NAVIGATION ONLY
  const handleCreateAccount = () => {
    router.push("/auth/phone");
  };

  const handleLogin = () => {
    router.push("/auth/otp");
  };

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
              <Text style={s.featureText}>AI-powered support for research</Text>
            </View>
          </View>
        </View>

        <View style={s.bottom}>
          <Text style={s.terms}>
            By continuing you accept our Privacy Policy and Terms of Service.
          </Text>

          {/* ✅ Create Account */}
          <TouchableOpacity
            onPress={handleCreateAccount}
            activeOpacity={0.85}
            style={s.primaryBtn}
          >
            <LinearGradient
              colors={["#1DB954", "#17a347"]}
              style={s.primaryGrad}
            >
              <Text style={s.primaryText}>Create Account</Text>
            </LinearGradient>
          </TouchableOpacity>

          {/* ✅ Login */}
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
