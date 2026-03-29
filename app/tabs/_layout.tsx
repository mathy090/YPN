// app/tabs/_layout.tsx
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { StyleSheet, View } from "react-native";

const TAB_ICONS: Record<string, { active: string; inactive: string }> = {
  discord: { active: "chatbubbles", inactive: "chatbubbles-outline" },
  foryou: { active: "play-circle", inactive: "play-circle-outline" },
  news: { active: "newspaper", inactive: "newspaper-outline" },
  settings: { active: "settings", inactive: "settings-outline" },
};

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          position: "absolute",
          left: 20,
          right: 20,
          bottom: 16,
          height: 68,
          borderRadius: 34,
          backgroundColor: "transparent",
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarBackground: () => (
          <BlurView
            tint="dark"
            intensity={90}
            style={[StyleSheet.absoluteFill, { borderRadius: 34 }]}
          />
        ),
        tabBarIcon: ({ focused }) => {
          const icons = TAB_ICONS[route.name];
          if (!icons) return null;
          return (
            <View style={styles.tabItem}>
              {focused && <View style={styles.activeBg} />}
              <Ionicons
                name={(focused ? icons.active : icons.inactive) as any}
                size={24}
                color={focused ? "#FFFFFF" : "#8E8E93"}
              />
            </View>
          );
        },
      })}
    >
      <Tabs.Screen name="discord" />
      <Tabs.Screen name="foryou" />
      <Tabs.Screen name="news" />
      <Tabs.Screen name="settings" />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabItem: {
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
  },
  activeBg: {
    position: "absolute",
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#1DB954",
    opacity: 0.9,
  },
});
