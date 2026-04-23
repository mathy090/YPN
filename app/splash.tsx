// app/splash.tsx
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { Animated, Image, StyleSheet, Text, View } from "react-native";

export default function SplashScreen() {
  const router = useRouter();
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 600,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1,
        friction: 6,
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => {
        router.replace("/(tabs)/discord"); // Bug 3 fixed
      });
    }, 2200);

    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={s.root}>
      <Animated.View style={[s.content, { opacity, transform: [{ scale }] }]}>
        <Image source={require("../assets/images/YPN.png")} style={s.logo} />
        <Text style={s.title}>YPN</Text>
        <Text style={s.sub}>Youth People's Network</Text>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
  content: { alignItems: "center", gap: 16 },
  logo: { width: 96, height: 96, borderRadius: 48 },
  title: { color: "#fff", fontSize: 36, fontWeight: "800", letterSpacing: 2 },
  sub: {
    color: "#1DB954",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 1.5,
  },
});
