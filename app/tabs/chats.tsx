// app/tabs/chats.tsx
import { Ionicons } from '@expo/vector-icons';
import { Link, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  StatusBar as RNStatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { getSecureCache } from '../../src/utils/cache';
import { useNetworkStatus } from '../../src/utils/network';

export default function ChatsScreen() {
  const router = useRouter();
  const [chatRooms, setChatRooms] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { isConnected, isChecking } = useNetworkStatus();

  useEffect(() => {
    const loadChats = async () => {
      try {
        const ypnMessages = await getSecureCache('chat_team-ypn');
        const chats = [];
        
        if (Array.isArray(ypnMessages) && ypnMessages.length > 0) {
          const lastMsg = ypnMessages[ypnMessages.length - 1];
          chats.push({
            roomId: 'team-ypn',
            type: 'ai',
            name: 'Team YPN',
            avatar: require('../../assets/images/YPN.png'),
            lastMessage: lastMsg.text.substring(0, 30) + (lastMsg.text.length > 30 ? '...' : ''),
            lastMessageTime: new Date(lastMsg.timestamp).getTime(),
            unreadCount: 0,
          });
        }

        chats.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
        setChatRooms(chats);
      } catch (error) {
        console.error('Failed to load chats:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadChats();
  }, []);

  const handleAddChat = () => {
    const dummyUsers = [
      { id: 'user_alice', username: 'alice_dev' },
      { id: 'user_bob', username: 'bob_codes' },
      { id: 'user_grace', username: 'grace_ui' },
    ];

    Alert.alert(
      'New Chat',
      'Select a user:',
      dummyUsers.map(user => ({
        text: user.username,
        onPress: () => Alert.alert('Coming Soon', `Chat with ${user.username}`),
      })),
      { cancelable: true }
    );
  };

  const openTeamYPN = () => {
    router.push('/chat?roomId=team-ypn');
  };

  const renderChatItem = ({ item }: { item: any }) => (
    <Link href={`/chat?roomId=${item.roomId}`} asChild>
      <TouchableOpacity style={styles.chatItem} activeOpacity={0.8}>
        <View style={styles.avatarContainer}>
          <Image source={item.avatar} style={styles.avatar} />
        </View>
        <View style={styles.textContainer}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.lastMessage} numberOfLines={1}>
            {item.lastMessage}
          </Text>
        </View>
        <View style={styles.metaContainer}>
          <Text style={styles.time}>
            {new Date(item.lastMessageTime).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>
      </TouchableOpacity>
    </Link>
  );

  return (
    <View style={[styles.container, Platform.OS === 'android' && { paddingTop: RNStatusBar.currentHeight || 24 }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Chats</Text>
        <View style={styles.headerActions}>
          {isChecking ? (
            <ActivityIndicator size="small" color="#8E8E93" />
          ) : isConnected ? (
            <View style={styles.onlineDot} />
          ) : (
            <Ionicons name="cloud-offline" size={20} color="#FF3B30" />
          )}
          <TouchableOpacity onPress={handleAddChat} style={styles.addButton}>
            <Ionicons name="add" size={24} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#3396FD" />
        </View>
      ) : chatRooms.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>No chats yet</Text>
          <Text style={styles.emptySubtext}>Tap the YPN bubble below to start chatting with AI</Text>
        </View>
      ) : (
        <FlatList
          data={chatRooms}
          renderItem={renderChatItem}
          keyExtractor={(item) => item.roomId}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* Floating AI Bubble - Pure Black */}
      <TouchableOpacity 
        onPress={openTeamYPN}
        style={styles.aiBubble}
        activeOpacity={0.8}
      >
        <Image 
          source={require('../../assets/images/YPN.png')} 
          style={styles.aiBubbleImage} 
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    backgroundColor: '#000000',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#000000',
    borderBottomWidth: 1,
    borderBottomColor: '#282828',
  },
  headerTitle: { fontSize: 32, fontWeight: 'bold', color: '#FFFFFF' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  onlineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#34C759',
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#1A1A1A',
    justifyContent: 'center',
    alignItems: 'center',
  },
  listContent: { paddingTop: 8, paddingBottom: 100 },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#282828',
  },
  avatarContainer: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
    overflow: 'hidden',
  },
  avatar: { width: 44, height: 44, borderRadius: 22 },
  textContainer: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', color: '#FFFFFF', marginBottom: 2 },
  lastMessage: { fontSize: 14, color: '#8E8E93' },
  metaContainer: { alignItems: 'flex-end', minWidth: 50 },
  time: { fontSize: 12, color: '#8E8E93', marginBottom: 4 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyContainer: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginTop: -50,
    paddingHorizontal: 40,
  },
  emptyText: { color: '#FFFFFF', fontSize: 20, fontWeight: '600', textAlign: 'center' },
  emptySubtext: { color: '#8E8E93', fontSize: 16, marginTop: 8, textAlign: 'center' },

  // Floating AI Bubble - Pure Black
  aiBubble: {
    position: 'absolute',
    bottom: 95,
    right: 20,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    borderWidth: 2,
    borderColor: '#FFFFFF10',
  },
  aiBubbleImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
});