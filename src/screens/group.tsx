// src/screens/group.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useRef, useState } from "react";
import {
  FlatList,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function GroupChatScreen({ chatId, username, type }: any) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const flatListRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState([
    { id: "1", text: "Hey!", sender: "other", time: "10:00 AM" },
    { id: "2", text: "How are you?", sender: "other", time: "10:01 AM" },
    { id: "3", text: "Doing great! Working on YPN.", sender: "me", time: "10:02 AM" },
    { id: "4", text: "Nice! Send me the build.", sender: "other", time: "10:03 AM" },
  ]);
  const [inputText, setInputText] = useState("");

  const handleSend = () => {
    if (!inputText.trim()) return;
    
    const newMsg = {
      id: Date.now().toString(),
      text: inputText,
      sender: "me",
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };
    
    setMessages(prev => [...prev, newMsg]);
    setInputText("");
    setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 50);
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="#121212" />
      
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={styles.title}>{username}</Text>
          {type === "group" && (
            <Text style={styles.subtitle}>2 online</Text>
          )}
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity>
            <Ionicons name="call" size={24} color="#1DB954" />
          </TouchableOpacity>
          <TouchableOpacity style={{ marginLeft: 16 }}>
            <Ionicons name="videocam" size={24} color="#1DB954" />
          </TouchableOpacity>
        </View>
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={[styles.messageRow, item.sender === "me" && styles.meRow]}>
            <View style={[styles.bubble, item.sender === "me" ? styles.myBubble : styles.otherBubble]}>
              <Text style={[styles.messageText, item.sender === "me" && styles.myText]}>
                {item.text}
              </Text>
            </View>
            <Text style={[styles.time, item.sender === "me" && styles.myTime]}>{item.time}</Text>
          </View>
        )}
        contentContainerStyle={{
          padding: 16,
          paddingBottom: 120 + insets.bottom,
        }}
        showsVerticalScrollIndicator={false}
        inverted
      />

      {/* Input Bar */}
      <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          value={inputText}
          onChangeText={setInputText}
          placeholder="Message"
          placeholderTextColor="#B3B3B3"
          style={styles.input}
          multiline
          maxLength={500}
          textAlignVertical="top"
        />
        <TouchableOpacity onPress={handleSend} disabled={!inputText.trim()}>
          <View style={[styles.sendButton, !inputText.trim() && styles.disabledButton]}>
            <Ionicons name="send" size={20} color="#000000" />
          </View>
        </TouchableOpacity>
      </View>
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
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#121212",
    borderBottomWidth: 1,
    borderBottomColor: "#282828",
  },
  headerContent: {
    flex: 1,
    alignItems: "center",
    marginLeft: 12,
  },
  title: {
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "600",
    includeFontPadding: false,
  },
  subtitle: {
    color: "#B3B3B3",
    fontSize: 12,
    marginTop: 2,
    includeFontPadding: false,
  },
  headerActions: {
    flexDirection: "row",
    position: "absolute",
    right: 16,
  },
  messageRow: {
    flexDirection: "row",
    marginVertical: 6,
  },
  meRow: {
    flexDirection: "row-reverse",
  },
  bubble: {
    maxWidth: "75%",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  otherBubble: {
    backgroundColor: "#282828",
    borderBottomLeftRadius: 4,
  },
  myBubble: {
    backgroundColor: "#1DB954",
    borderBottomRightRadius: 4,
  },
  messageText: {
    fontSize: 16,
    color: "#FFFFFF",
    includeFontPadding: false,
  },
  myText: {
    color: "#000000",
    fontWeight: "500",
    includeFontPadding: false,
  },
  time: {
    fontSize: 11,
    color: "#B3B3B3",
    alignSelf: "flex-end",
    marginTop: 4,
    marginLeft: 8,
    includeFontPadding: false,
  },
  myTime: {
    marginLeft: 0,
    marginRight: 8,
  },
  inputBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 8,
    backgroundColor: "#121212",
    borderTopWidth: 1,
    borderTopColor: "#282828",
  },
  input: {
    flex: 1,
    backgroundColor: "#282828",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 100,
    marginRight: 10,
    color: "#FFFFFF",
    includeFontPadding: false,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#1DB954",
    justifyContent: "center",
    alignItems: "center",
  },
  disabledButton: {
    backgroundColor: "#555555",
  },
});