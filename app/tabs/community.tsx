// app/tabs/community.tsx
import { BlurView } from "expo-blur";
import { StatusBar } from "expo-status-bar";
import React from "react";
import {
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import DiscordScreen from "../../src/screens/discord";
import ForYouScreen from "../../src/screens/foryou";
import NewsScreen from "../../src/screens/news";

const STATUS_BAR_H =
  Platform.OS === "android" ? (RNStatusBar.currentHeight ?? 24) : 0;

const CommunityScreen = () => {
  const tabs = ["For You", "Discord", "News"];
  const [activeTab, setActiveTab] = React.useState("For You");

  const renderActiveScreen = () => {
    switch (activeTab) {
      case "For You":
        return <ForYouScreen />;
      case "Discord":
        return <DiscordScreen />;
      case "News":
        return <NewsScreen />;
      default:
        return null;
    }
  };

  // Only "For You" gets the true full-screen treatment
  const isFullScreen = activeTab === "For You";

  return (
    <View style={styles.root}>
      <StatusBar style="light" backgroundColor="transparent" translucent />

      {/* Full-screen content layer — sits behind the floating tab bar */}
      <View style={styles.contentFill}>{renderActiveScreen()}</View>

      {/* Floating overlay tab bar */}
      <View
        style={[
          styles.tabsWrapper,
          { top: STATUS_BAR_H },
          // On non-fullscreen tabs show a solid background so text is legible
          !isFullScreen && styles.tabsWrapperSolid,
        ]}
        pointerEvents="box-none"
      >
        {isFullScreen ? (
          <BlurView
            tint="dark"
            intensity={30}
            style={StyleSheet.absoluteFill}
          />
        ) : null}

        <View style={styles.tabsRow} pointerEvents="auto">
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab}
              onPress={() => setActiveTab(tab)}
              style={styles.tab}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.tabText,
                  activeTab === tab && styles.activeTabText,
                ]}
              >
                {tab}
              </Text>
              {activeTab === tab && <View style={styles.activeIndicator} />}
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </View>
  );
};

export default CommunityScreen;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#000000",
  },

  // Content stretches to fill ALL available space — behind the floating tabs
  contentFill: {
    ...StyleSheet.absoluteFillObject,
  },

  // The floating tab bar — absolutely positioned so video shows through
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
  activeIndicator: {
    height: 2,
    width: "60%",
    backgroundColor: "#FFFFFF",
    marginTop: 3,
    borderRadius: 1,
    alignSelf: "center",
  },
});
