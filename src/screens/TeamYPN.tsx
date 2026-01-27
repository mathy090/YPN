import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Message } from '../types/chat';
import { getSecureCache, setSecureCache } from '../utils/cache';
import { useNetworkStatus } from '../utils/network';

// -------------------- BACKEND URL --------------------
const AI_API_URL = 'https://ypn-1.onrender.com/chat';

export default function TeamYPNScreen() {
  const router = useRouter();
  const listRef = useRef<FlatList>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inputHeight, setInputHeight] = useState(48);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const { isConnected } = useNetworkStatus();

  /* -------------------- LOAD CACHE -------------------- */
  useEffect(() => {
    (async () => {
      const cached = await getSecureCache('chat_team-ypn');
      if (Array.isArray(cached)) setMessages(cached);
      setLoading(false);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 50);
    })();
  }, []);

  /* -------------------- SAVE CACHE -------------------- */
  useEffect(() => {
    setSecureCache('chat_team-ypn', messages);
  }, [messages]);

  /* -------------------- KEYBOARD HANDLING -------------------- */
  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', e => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(e.endCoordinates.height);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    });

    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(0);
      setInputHeight(48);
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    });

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  /* -------------------- SEND TO AI -------------------- */
  const sendToAI = async (text: string) => {
    const res = await fetch(AI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`AI request failed: ${errText}`);
    }

    const data = await res.json();
    return data.reply; // matches your FastAPI {"reply": "..."}
  };

  /* -------------------- SEND MESSAGE -------------------- */
  const sendMessage = async (text: string, retryId?: string) => {
    if (!text.trim() || !isConnected) return;

    setSending(true);
    const messageId = retryId || Date.now().toString();

    const userMessage: Message = {
      id: messageId,
      text,
      sender: 'user',
      timestamp: new Date().toISOString(),
      status: 'sent',
    };

    setMessages(prev => (retryId ? prev.filter(m => m.id !== retryId).concat(userMessage) : [...prev, userMessage]));

    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);

    try {
      const reply = await sendToAI(text);

      setMessages(prev => [
        ...prev.map(m => (m.id === messageId ? { ...m, status: 'read' } : m)),
        {
          id: Date.now().toString(),
          text: reply,
          sender: 'ai',
          timestamp: new Date().toISOString(),
          status: 'read',
        },
      ]);

      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    } catch {
      setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, status: 'failed' } : m)));
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    setInputHeight(48);
    sendMessage(text);
  };

  /* -------------------- DATE HEADER -------------------- */
  const formatDateHeader = (dateString: string) => {
    const msgDate = new Date(dateString);
    const now = new Date();
    const yesterday = new Date();
    yesterday.setDate(now.getDate() - 1);

    if (
      msgDate.getFullYear() === now.getFullYear() &&
      msgDate.getMonth() === now.getMonth() &&
      msgDate.getDate() === now.getDate()
    ) return 'Today';

    if (
      msgDate.getFullYear() === yesterday.getFullYear() &&
      msgDate.getMonth() === yesterday.getMonth() &&
      msgDate.getDate() === yesterday.getDate()
    ) return 'Yesterday';

    return msgDate.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
  };

  const getGroupedMessages = (messages: Message[]) => {
    const grouped: { type: 'header' | 'message'; text: string; item?: Message }[] = [];
    let lastDate = '';
    messages.forEach(msg => {
      const dateHeader = formatDateHeader(msg.timestamp);
      if (dateHeader !== lastDate) {
        grouped.push({ type: 'header', text: dateHeader });
        lastDate = dateHeader;
      }
      grouped.push({ type: 'message', text: msg.text, item: msg });
    });
    return grouped;
  };

  /* -------------------- RENDER ITEM -------------------- */
  const renderItem = ({ item }: { item: { type: string; text: string; item?: Message } }) => {
    if (item.type === 'header') {
      return (
        <View style={styles.dateHeader}>
          <Text style={styles.dateHeaderText}>{item.text}</Text>
        </View>
      );
    }

    const msg = item.item!;
    const isUser = msg.sender === 'user';
    const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    return (
      <View style={[styles.row, isUser && styles.userRow]}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={styles.text}>{msg.text}</Text>
          <View style={styles.meta}>
            <Text style={styles.time}>{time}</Text>
            {isUser && msg.status === 'read' && <Ionicons name="checkmark-done" size={16} color="#34B7F1" />}
            {isUser && msg.status === 'failed' && (
              <Pressable onPress={() => sendMessage(msg.text, msg.id)}>
                <Ionicons name="alert-circle" size={16} color="#FF453A" />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#25D366" />
      </View>
    );
  }

  /* -------------------- MAIN RENDER -------------------- */
  return (
    <View style={styles.container}>
      {/* HEADER */}
      <View style={styles.header}>
        <Pressable onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </Pressable>
        <Image source={require('../../assets/images/YPN.png')} style={styles.avatar} />
        <View>
          <Text style={styles.title}>Team YPN</Text>
          <Text style={styles.subtitle}>Online</Text>
        </View>
      </View>

      {/* CHAT */}
      <FlatList
        ref={listRef}
        data={getGroupedMessages(messages)}
        renderItem={renderItem}
        keyExtractor={(item, index) => (item.type === 'header' ? `header-${index}` : item.item!.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 12, paddingBottom: inputHeight + keyboardHeight + 12 }}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      {/* INPUT */}
      <View style={[styles.inputContainer, { bottom: keyboardHeight }]}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Message"
          placeholderTextColor="#aaa"
          multiline
          style={[styles.input, { height: inputHeight }]}
          onContentSizeChange={e => {
            const h = Math.min(120, Math.max(48, e.nativeEvent.contentSize.height));
            setInputHeight(h);
          }}
        />
        <Pressable onPress={handleSend} disabled={!input.trim() || sending} style={styles.send}>
          {sending ? <ActivityIndicator color="#fff" /> : <Ionicons name="send" size={20} color="#fff" />}
        </Pressable>
      </View>
    </View>
  );
}

/* -------------------- STYLES -------------------- */
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  loading: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },

  avatar: { width: 40, height: 40, borderRadius: 20, marginHorizontal: 12 },
  title: { color: '#fff', fontSize: 17, fontWeight: '600' },
  subtitle: { color: '#25D366', fontSize: 12 },

  row: { marginVertical: 6 },
  userRow: { alignItems: 'flex-end' },

  bubble: { maxWidth: '80%', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 18 },
  userBubble: { backgroundColor: '#25D366' },
  aiBubble: { backgroundColor: '#1f1f1f' },

  text: { color: '#fff', fontSize: 16 },

  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 4, gap: 4 },
  time: { fontSize: 10, color: '#ddd' },

  dateHeader: { alignSelf: 'center', backgroundColor: '#333', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, marginVertical: 8 },
  dateHeaderText: { color: '#ccc', fontSize: 12, fontWeight: '600' },

  inputContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: '#222',
    backgroundColor: '#111',
  },
  input: {
    flex: 1,
    backgroundColor: '#222',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: '#fff',
    fontSize: 16,
  },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#25D366', justifyContent: 'center', alignItems: 'center', marginLeft: 8 },
});
