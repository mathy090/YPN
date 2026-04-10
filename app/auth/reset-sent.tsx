import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function ResetSent() {
  const router = useRouter();

  return (
    <View style={s.root}>
      <LinearGradient
        colors={["#0a0a14", "#000000", "#0a0a14"]}
        style={StyleSheet.absoluteFill}
      />

      <SafeAreaView style={s.safe}>
        <View style={s.container}>
          {/* Icon */}
          <View style={s.iconWrap}>
            <Ionicons name="mail-open-outline" size={42} color="#1DB954" />
          </View>

          {/* Title */}
          <Text style={s.title}>Check your email</Text>

          {/* Message */}
          <Text style={s.sub}>
            We’ve sent a password reset link.
            {"\n"}
            Open your Gmail and confirm your new password.
          </Text>

          {/* Button */}
          <TouchableOpacity
            style={s.btn}
            activeOpacity={0.8}
            onPress={() => router.replace("/auth/otp")}
          >
            <Text style={s.btnText}>OK, Continue to Login</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  safe: { flex: 1, justifyContent: "center", alignItems: "center" },

  container: {
    width: "85%",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },

  iconWrap: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: "rgba(29,185,84,0.12)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },

  title: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 10,
    textAlign: "center",
  },

  sub: {
    color: "#B3B3B3",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },

  btn: {
    backgroundColor: "#1DB954",
    paddingVertical: 14,
    paddingHorizontal: 30,
    borderRadius: 30,
  },

  btnText: {
    color: "#000",
    fontWeight: "700",
    fontSize: 15,
  },
});
