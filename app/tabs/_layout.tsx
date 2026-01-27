// app/tabs/_layout.tsx
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import React from "react";
import { StyleSheet, View } from "react-native";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: {
          position: "absolute",
          left: 20,
          right: 20,
          bottom: 16,
          height: 70,
          borderRadius: 35,
          backgroundColor: "transparent",
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarBackground: () => (
          <BlurView
            tint="dark"
            intensity={95}
            style={[StyleSheet.absoluteFill, { borderRadius: 35 }]}
          />
        ),
      }}
    >
      <Tabs.Screen
        name="chats"
        options={{
          title: "Chats",
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabItem}>
              {focused && <View style={styles.activeBg} />}
              <Ionicons
                name="chatbubble"
                size={24}
                color={focused ? "#FFFFFF" : "#8E8E93"}
              />
            </View>
          ),
        }}
      />

      <Tabs.Screen
        name="community"
        options={{
          title: "Community",
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabItem}>
              {focused && <View style={styles.activeBg} />}
              <Ionicons
                name="people"
                size={24}
                color={focused ? "#FFFFFF" : "#8E8E93"}
              />
            </View>
          ),
        }}
      />

      <Tabs.Screen
        name="calls"
        options={{
          title: "Calls",
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabItem}>
              {focused && <View style={styles.activeBg} />}
              <Ionicons
                name="call"
                size={24}
                color={focused ? "#FFFFFF" : "#8E8E93"}
              />
            </View>
          ),
        }}
      />

      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ focused }) => (
            <View style={styles.tabItem}>
              {focused && <View style={styles.activeBg} />}
              <Ionicons
                name="settings"
                size={24}
                color={focused ? "#FFFFFF" : "#8E8E93"}
              />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabItem: {
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    width: "100%",
  },
  activeBg: {
    position: "absolute",
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "#3396FD",
    opacity: 0.9,
  },
});