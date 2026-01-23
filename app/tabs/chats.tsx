import { FlatList, Image, Text, TouchableOpacity, View } from 'react-native';
import { DarkTheme } from '../../src/theme/theme';

const chats = [
  {
    id: '1',
    name: 'Alex',
    lastMessage: 'Yo, are you coming?',
    time: '09:12',
    avatar: 'https://i.pravatar.cc/100?img=1',
  },
  {
    id: '2',
    name: 'Team YPN',
    lastMessage: 'New update pushed',
    time: 'Yesterday',
    avatar: 'https://i.pravatar.cc/100?img=2',
  },
];

export default function ChatsScreen() {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: DarkTheme.background,
      }}
    >
      {/* Header */}
      <View
        style={{
          padding: 16,
          borderBottomWidth: 1,
          borderBottomColor: DarkTheme.border,
        }}
      >
        <Text
          style={{
            color: DarkTheme.text,
            fontSize: 22,
            fontWeight: '700',
          }}
        >
          Chats
        </Text>
      </View>

      {/* Chat list */}
      <FlatList
        data={chats}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={{
              flexDirection: 'row',
              padding: 14,
              borderBottomWidth: 0.5,
              borderBottomColor: DarkTheme.border,
            }}
          >
            <Image
              source={{ uri: item.avatar }}
              style={{
                width: 48,
                height: 48,
                borderRadius: 24,
                marginRight: 12,
              }}
            />

            <View style={{ flex: 1 }}>
              <Text
                style={{
                  color: DarkTheme.text,
                  fontSize: 16,
                  fontWeight: '600',
                }}
              >
                {item.name}
              </Text>

              <Text
                style={{
                  color: DarkTheme.muted,
                  marginTop: 4,
                }}
                numberOfLines={1}
              >
                {item.lastMessage}
              </Text>
            </View>

            <Text
              style={{
                color: DarkTheme.muted,
                fontSize: 12,
              }}
            >
              {item.time}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
