// app/tabs/community.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Community tab shell.
// Discord is NO LONGER rendered inline — it is pushed as a full-screen Stack
// route so the bottom tab bar never overlaps the keyboard or input area.
// ForYou and News still render inline (they don't have chat input bars).
// ─────────────────────────────────────────────────────────────────────────────

import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useState } from "react";
import {
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import ForYouScreen from "../../src/screens/foryou";
import NewsScreen from "../../src/screens/news";

const STATUS_BAR_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

type Tab = "For You" | "Community" | "News";

export default function CommunityScreen() {
  const router = useRouter();
  const tabs: Tab[] = ["For You", "Community", "News"];
  const [activeTab, setActiveTab] = useState<Tab>("For You");

  const handleTabPress = (tab: Tab) => {
    if (tab === "Community") {
      // Push Discord as a full-screen Stack route — tab bar hidden
      router.push("/discord");
      return;
    }
    setActiveTab(tab);
  };

  const isFullScreen = activeTab === "For You";

  const renderContent = () => {
    switch (activeTab) {
      case "For You":
        return <ForYouScreen />;
      case "News":
        return <NewsScreen />;
      default:
        return null;
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" backgroundColor="transparent" translucent />

      {/* Content fills entire screen behind the floating tab bar */}
      <View style={styles.contentFill}>{renderContent()}</View>

      {/* Floating overlay tab bar */}
      <View
        style={[
          styles.tabsWrapper,
          { top: STATUS_BAR_H },
          !isFullScreen && styles.tabsWrapperSolid,
        ]}
        pointerEvents="box-none"
      >
        {isFullScreen && (
          <BlurView
            tint="dark"
            intensity={30}
            style={StyleSheet.absoluteFill}
          />
        )}

        <View style={styles.tabsRow} pointerEvents="auto">
          {tabs.map((tab) => {
            const isActive = activeTab === tab;
            return (
              <TouchableOpacity
                key={tab}
                onPress={() => handleTabPress(tab)}
                style={styles.tab}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.tabText,
                    isActive && styles.activeTabText,
                    // Community tab always shows as inactive (it navigates away)
                    tab === "Community" && styles.communityTab,
                  ]}
                >
                  {tab}
                </Text>
                {isActive && tab !== "Community" && (
                  <View style={styles.activeIndicator} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },
  contentFill: {
    ...StyleSheet.absoluteFillObject,
  },
  tabsWrapper: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
    zIndex: 20,
  },
  tabsWrapperSolid: {
    backgroundColor: "#000000CC",
  },
  tabsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  tab: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 20,
    alignItems: "center",
  },
  tabText: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  activeTabText: {
    color: "#FFFFFF",
    fontWeight: "700",
  },
  communityTab: {
    // Community always looks like a link, not a selected tab
    color: "rgba(255,255,255,0.55)",
  },
  activeIndicator: {
    height: 2,
    width: "60%",
    backgroundColor: "#FFFFFF",
    marginTop: 3,
    borderRadius: 1,
    alignSelf: "center",
  },
});
