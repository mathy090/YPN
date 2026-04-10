// app/index.tsx
import { Redirect } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAuth } from "../src/store/authStore";

SplashScreen.preventAutoHideAsync();

export default function Index() {
  const { hasAgreed, isLoggedIn, initialized, hydrate } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    hydrate().finally(() => {
      setReady(true);
      SplashScreen.hideAsync();
    });
  }, []);

  if (!ready || !initialized) {
    return (
      <View style={styles.loader}>
        <ActivityIndicator size="large" color="#1DB954" />
      </View>
    );
  }

  // ROUTING LOGIC BASED ON INSTANT CACHE CHECK
  if (!hasAgreed) return <Redirect href="/welcome" />;
  if (!isLoggedIn) return <Redirect href="/auth/otp" />;
  return <Redirect href="/tabs/discord" />;
}

const styles = StyleSheet.create({
  loader: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
    alignItems: "center",
  },
});
