// src/screens/TeamYPN.tsx
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Message } from '../src/types/chat';
import { getSecureCache, setSecureCache } from '../src/utils/cache';
import { useNetworkStatus } from '../src/utils/network';

export default function TeamYPNScreen() {
  const router = useRouter();
  const flatListRef = useRef<FlatList>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const { isConnected, isChecking } = useNetworkStatus();

  // Load cached messages on mount
  useEffect(() => {
    const loadCachedMessages = async () => {
      try {
        const cached = await getSecureCache('chat_team-ypn');
        if (cached && Array.isArray(cached)) {
          setMessages(cached);
        }
      } catch (error) {
        console.error('Failed to load cached messages:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadCachedMessages();
  }, []);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  // Save messages to cache whenever they change
  useEffect(() => {
    if (messages.length > 0) {
      const save = async () => {
        try {
          await setSecureCache('chat_team-ypn', messages);
        } catch (error) {
          console.error('Failed to save messages:', error);
        }
      };
      save();
    }
  }, [messages]);

  const handleSend = async () => {
    if (!inputText.trim() || !isConnected) return;

    setIsSending(true);
    
    // Add user message (status: sent)
    const userMsg: Message = {
      id: Date.now().toString(),
      text: inputText,
      sender: 'user',
      timestamp: new Date().toISOString(),
      status: 'sent',
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInputText('');
    
    // Simulate delivery confirmation after 300ms
    setTimeout(() => {
      setMessages(prev => 
        prev.map(msg => 
          msg.id === userMsg.id ? { ...msg, status: 'delivered' } : msg
        )
      );
    }, 300);

    // Simulate AI reply after 1 second
    setTimeout(() => {
      const aiMsg: Message = {
        id: (Date.now() + 1).toString(),
        text: "👋 Hey there! I'm Team YPN AI.\n\n✅ I can help with coding\n✅ Answer questions\n✅ Send emojis 😄🎉🔥\n\nWhat would you like to do today?",
        sender: 'ai',
        timestamp: new Date().toISOString(),
        status: 'read',
        isPhoto: false,
      };
      
      setMessages(prev => {
        // Update user message to 'read' status
        const updated = prev.map(msg => 
          msg.id === userMsg.id ? { ...msg, status: 'read' } : msg
        );
        return [...updated, aiMsg];
      });
      setIsSending(false);
    }, 1000);
  };

  const renderMessage = ({ item }: { item: Message }) => {
    const isUser = item.sender === 'user';
    const time = new Date(item.timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });

    // Get status dots (green)
    const getStatusDots = () => {
      if (isUser) {
        switch (item.status) {
          case 'sent': return '•'; // light green
          case 'delivered': return '••'; // medium green
          case 'read': return '•••'; // dark green
        }
      }
      return null;
    };

    return (
      <View style={[styles.messageRow, isUser && styles.userRow]}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={isUser ? styles.userText : styles.aiText}>
            {item.text}
          </Text>
        </View>
        <View style={styles.metaContainer}>
          <Text style={[styles.time, isUser && styles.userTime]}>{time}</Text>
          {getStatusDots() && (
            <Text style={[styles.dots, isUser && styles.userDots]}>
              {getStatusDots()}
            </Text>
          )}
        </View>
      </View>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#3396FD" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={24} color="#FFFFFF" />
        </TouchableOpacity>
        
        <View style={styles.headerContent}>
          <Image 
            source={require('../assets/images/YPN.png')} 
            style={styles.avatarHeader} 
          />
          <View style={styles.headerTextContainer}>
            <Text style={styles.headerTitle}>Team YPN</Text>
            <Text style={styles.headerSubtitle}>
              {isChecking ? 'Checking...' : isConnected ? 'Online' : 'Offline'}
            </Text>
          </View>
        </View>

        {/* Network status indicator */}
        {isConnected ? (
          <View style={styles.onlineDot} />
        ) : (
          <ActivityIndicator size="small" color="#FF3B30" />
        )}
      </View>

      {/* Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />

      {/* Input Bar */}
      <View style={styles.inputBar}>
        <TouchableOpacity style={styles.attachButton}>
          <Ionicons name="attach" size={24} color="#8E8E93" />
        </TouchableOpacity>
        
        <TextInput
          value={inputText}
          onChangeText={setInputText}
          placeholder="Message"
          placeholderTextColor="#8E8E93"
          style={styles.input}
          multiline
          maxLength={500}
          onSubmitEditing={handleSend}
          editable={isConnected && !isSending}
        />
        
        <TouchableOpacity 
          onPress={handleSend} 
          disabled={!inputText.trim() || !isConnected || isSending}
          style={[
            styles.sendButton,
            (!inputText.trim() || !isConnected || isSending) && styles.sendButtonDisabled
          ]}
        >
          {isSending ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Ionicons name="send" size={20} color="white" />
          )}
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000000' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#000000',
    borderBottomWidth: 1,
    borderBottomColor: '#282828',
  },
  backButton: { padding: 4 },
  headerContent: { flexDirection: 'row', alignItems: 'center', flex: 1, marginLeft: 8 },
  avatarHeader: { width: 40, height: 40, borderRadius: 20, marginRight: 10 },
  headerTextContainer: { flex: 1 },
  headerTitle: { fontSize: 18, fontWeight: '600', color: '#FFFFFF' },
  headerSubtitle: { fontSize: 12, color: '#3396FD', marginTop: 2 },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34C759',
    position: 'absolute',
    right: -5,
    top: 5,
  },
  listContent: { padding: 12, paddingBottom: 90 },
  messageRow: { 
    flexDirection: 'row', 
    marginVertical: 6,
    maxWidth: '85%',
  },
  userRow: { 
    alignSelf: 'flex-end',
    flexDirection: 'row-reverse',
  },
  bubble: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 18,
    maxWidth: '100%',
  },
  userBubble: { 
    backgroundColor: '#00A884',
    borderBottomRightRadius: 4,
  },
  aiBubble: { 
    backgroundColor: '#333333',
    borderBottomLeftRadius: 4,
  },
  userText: { color: '#FFFFFF', fontSize: 16, lineHeight: 22 },
  aiText: { color: '#FFFFFF', fontSize: 16, lineHeight: 22 },
  metaContainer: { 
    justifyContent: 'flex-end', 
    marginLeft: 6,
    marginRight: 6,
  },
  time: { 
    fontSize: 10, 
    color: '#8E8E93',
    marginTop: 2,
  },
  userTime: { 
    textAlign: 'right',
    marginLeft: 0,
  },
  dots: {
    fontSize: 16,
    color: '#00A884',
    marginTop: 2,
  },
  userDots: {
    textAlign: 'right',
  },
  inputBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#121212',
    borderTopWidth: 1,
    borderTopColor: '#282828',
  },
  attachButton: { 
    padding: 8,
    marginRight: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#282828',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 100,
    marginRight: 10,
    color: '#FFFFFF',
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#00A884',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#333333',
  },
});