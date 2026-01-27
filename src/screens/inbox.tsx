// src/screens/inbox.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  FlatList,
  Image,
  Modal,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const dummyConversations = [
  { id: "c1", name: "alice_dev", type: "single", last: "Thanks for the help!", time: "10:30 AM", unread: 2 },
  { id: "c2", name: "bob_codes", type: "single", last: "Check the PR", time: "Yesterday", unread: 0 },
  { id: "c3", name: "dev_team", type: "group", last: "Meeting at 3?", time: "Mon", unread: 5 },
  { id: "c4", name: "ui_guru", type: "single", last: "New design attached", time: "Jan 20", unread: 0 },
];

const dummyUsers = [
  "alice_dev", "bob_codes", "charlie_js", "dev_team", 
  "ui_guru", "tester_jane", "backend_paul", "mobile_ryan"
];

export default function InboxScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [modalVisible, setModalVisible] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = search
    ? dummyUsers.filter(u => u.toLowerCase().includes(search.toLowerCase()))
    : dummyUsers;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>Chats</Text>
        <TouchableOpacity onPress={() => setModalVisible(true)}>
          <Ionicons name="add" size={24} color="#1DB954" />
        </TouchableOpacity>
      </View>

      {/* Conversations */}
      <FlatList
        data={dummyConversations}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity 
            style={styles.item}
            onPress={() => router.push({
              pathname: "/chat",
              params: { id: item.id, username: item.name, type: item.type }
            })}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{item.name[0].toUpperCase()}</Text>
            </View>
            <View style={styles.text}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.last} numberOfLines={1}>{item.last}</Text>
            </View>
            <View style={styles.meta}>
              <Text style={styles.time}>{item.time}</Text>
              {item.unread > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{item.unread}</Text>
                </View>
              )}
            </View>
          </TouchableOpacity>
        )}
        contentContainerStyle={{ 
          paddingTop: 8, 
          paddingBottom: 100 + insets.bottom,
          paddingHorizontal: 16,
        }}
        showsVerticalScrollIndicator={false}
      />

      {/* New Chat Modal */}
      <Modal visible={modalVisible} animationType="slide" transparent={false}>
        <View style={[styles.modal, { paddingTop: insets.top }]}>
          <StatusBar barStyle="light-content" backgroundColor="#121212" />
          
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="arrow-back" size={24} color="#1DB954" />
            </TouchableOpacity>
            <Text style={styles.modalTitle}>New Chat</Text>
          </View>
          
          <View style={styles.searchBox}>
            <Ionicons name="search" size={20} color="#A7A7A7" />
            <TextInput
              style={styles.searchInput}
              placeholder="Search username..."
              placeholderTextColor="#A7A7A7"
              value={search}
              onChangeText={setSearch}
              autoFocus
            />
            {search !== "" && (
              <TouchableOpacity onPress={() => setSearch("")}>
                <Ionicons name="close" size={20} color="#A7A7A7" />
              </TouchableOpacity>
            )}
          </View>

          <FlatList
            data={filtered}
            keyExtractor={item => item}
            renderItem={({ item }) => (
              <TouchableOpacity 
                style={styles.userItem}
                onPress={() => {
                  setModalVisible(false);
                  setSearch("");
                  router.push({
                    pathname: "/chat",
                    params: { id: `new_${Date.now()}`, username: item, type: "single" }
                  });
                }}
              >
                <View style={styles.userAvatar}>
                  <Text style={styles.userAvatarText}>{item[0].toUpperCase()}</Text>
                </View>
                <Text style={styles.userName}>{item}</Text>
              </TouchableOpacity>
            )}
            contentContainerStyle={{ 
              padding: 16,
              paddingBottom: 40 + insets.bottom,
            }}
            ListEmptyComponent={
              <Text style={styles.empty}>No users found</Text>
            }
          />
        </View>
      </Modal>

      {/* Floating AI Button */}
      <TouchableOpacity
        style={styles.floatingAIButton}
        onPress={() => router.push("/ai")}
      >
        <Image 
          source={require("../../assets/images/YPN.png")} 
          style={styles.floatingAIImage} 
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: "#121212",
  },
  header: { 
    flexDirection: "row", 
    justifyContent: "space-between", 
    alignItems: "center", 
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#282828",
  },
  title: { 
    color: "#FFFFFF", 
    fontSize: 20, 
    fontWeight: "700",
    includeFontPadding: false,
  },
  item: { 
    flexDirection: "row", 
    paddingVertical: 14, 
    borderBottomWidth: 1, 
    borderBottomColor: "#282828",
    alignItems: "center",
  },
  avatar: { 
    width: 50, 
    height: 50, 
    borderRadius: 25, 
    backgroundColor: "#1DB954", 
    justifyContent: "center", 
    alignItems: "center", 
    marginRight: 16,
  },
  avatarText: { 
    color: "#000000", 
    fontSize: 18, 
    fontWeight: "600",
    includeFontPadding: false,
  },
  text: { 
    flex: 1,
  },
  name: { 
    color: "#FFFFFF", 
    fontSize: 16, 
    fontWeight: "600", 
    marginBottom: 4,
    includeFontPadding: false,
  },
  last: { 
    color: "#B3B3B3", 
    fontSize: 14,
    includeFontPadding: false,
  },
  meta: { 
    alignItems: "flex-end",
  },
  time: { 
    color: "#B3B3B3", 
    fontSize: 12, 
    marginBottom: 4,
    includeFontPadding: false,
  },
  badge: { 
    backgroundColor: "#1DB954", 
    minWidth: 22, 
    height: 22, 
    borderRadius: 11, 
    justifyContent: "center", 
    alignItems: "center",
  },
  badgeText: { 
    color: "#000000", 
    fontSize: 12, 
    fontWeight: "600",
    includeFontPadding: false,
  },
  modal: { 
    flex: 1, 
    backgroundColor: "#121212",
  },
  modalHeader: { 
    flexDirection: "row", 
    alignItems: "center", 
    paddingHorizontal: 16, 
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#282828",
  },
  modalTitle: { 
    color: "#FFFFFF", 
    fontSize: 18, 
    fontWeight: "700", 
    marginLeft: 16,
    includeFontPadding: false,
  },
  searchBox: { 
    flexDirection: "row", 
    alignItems: "center", 
    margin: 16, 
    backgroundColor: "#282828", 
    borderRadius: 12, 
    paddingHorizontal: 16, 
    paddingVertical: 10,
  },
  searchInput: { 
    flex: 1, 
    marginLeft: 12, 
    color: "#FFFFFF", 
    fontSize: 16,
    includeFontPadding: false,
  },
  userItem: { 
    flexDirection: "row", 
    alignItems: "center", 
    paddingVertical: 14, 
    borderBottomWidth: 1, 
    borderBottomColor: "#282828",
  },
  userAvatar: { 
    width: 48, 
    height: 48, 
    borderRadius: 24, 
    backgroundColor: "#1DB954", 
    justifyContent: "center", 
    alignItems: "center", 
    marginRight: 16,
  },
  userAvatarText: { 
    color: "#000000", 
    fontSize: 18, 
    fontWeight: "600",
    includeFontPadding: false,
  },
  userName: { 
    color: "#FFFFFF", 
    fontSize: 16,
    includeFontPadding: false,
  },
  empty: { 
    color: "#B3B3B3", 
    textAlign: "center", 
    padding: 40, 
    fontSize: 16,
    includeFontPadding: false,
  },
  floatingAIButton: {
    position: "absolute",
    bottom: 90,
    right: 20,
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#1DB954",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  floatingAIImage: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
});