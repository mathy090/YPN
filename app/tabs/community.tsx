// app/tabs/community.tsx
import { StatusBar } from "expo-status-bar";
import React from "react";
import {
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import DiscordScreen from "../../src/screens/discord";
import ForYouScreen from "../../src/screens/foryou";
import NewsScreen from "../../src/screens/news";

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

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" backgroundColor="#000000" />

      {/* TikTok-Style Tabs */}
      <View style={styles.tabsContainer}>
        {tabs.map((tab) => (
          <TouchableOpacity
            key={tab}
            onPress={() => setActiveTab(tab)}
            style={styles.tab}
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

      {/* Content Area */}
      <View style={styles.contentContainer}>
        {renderActiveScreen()}
      </View>
    </SafeAreaView>
  );
};

export default CommunityScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000", // True black like TikTok
  },
  tabsContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: "#000000",
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 24,
  },
  tabText: {
    color: "#B3B3B3",
    fontSize: 18,
    fontWeight: "600",
  },
  activeTabText: {
    color: "#FFFFFF",
  },
  activeIndicator: {
    height: 2,
    backgroundColor: "#FFFFFF", // White underline like TikTok
    marginTop: 4,
    borderRadius: 1,
  },
  contentContainer: {
    flex: 1,
  },
});