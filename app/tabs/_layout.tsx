// app/tabs/_layout.tsx
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

type TabName = "discord" | "foryou" | "news" | "settings";

const TAB_CONFIG: Record<
  TabName,
  { active: string; inactive: string; label: string }
> = {
  discord: {
    active: "chatbubbles",
    inactive: "chatbubbles-outline",
    label: "Community",
  },
  foryou: {
    active: "play-circle",
    inactive: "play-circle-outline",
    label: "For You",
  },
  news: { active: "newspaper", inactive: "newspaper-outline", label: "News" },
  settings: {
    active: "settings",
    inactive: "settings-outline",
    label: "Settings",
  },
};

function TabBarBackground() {
  return (
    <BlurView tint="dark" intensity={95} style={StyleSheet.absoluteFill} />
  );
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets();

  // Height: icon + label + padding + safe area
  const TAB_BAR_HEIGHT = 56 + insets.bottom;

  return (
    <Tabs
      screenOptions={({ route }) => {
        const name = route.name as TabName;
        const config = TAB_CONFIG[name];

        return {
          headerShown: false,
          tabBarShowLabel: false,
          tabBarStyle: {
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: TAB_BAR_HEIGHT,
            backgroundColor: "transparent",
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: "rgba(255,255,255,0.12)",
            elevation: 0,
            shadowOpacity: 0,
          },
          tabBarBackground: TabBarBackground,
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabItem}>
              {focused && <View style={styles.activePill} />}
              <Ionicons
                name={(focused ? config.active : config.inactive) as any}
                size={22}
                color={focused ? "#1DB954" : "#8E8E93"}
              />
              <Text
                style={[
                  styles.tabLabel,
                  { color: focused ? "#1DB954" : "#8E8E93" },
                ]}
                numberOfLines={1}
              >
                {config.label}
              </Text>
            </View>
          ),
        };
      }}
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
    paddingTop: 6,
    paddingBottom: 2,
    gap: 3,
    width: 72,
  },
  activePill: {
    position: "absolute",
    top: -1,
    width: 36,
    height: 3,
    borderRadius: 2,
    backgroundColor: "#1DB954",
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: "600",
    letterSpacing: 0.2,
    textAlign: "center",
  },
});
