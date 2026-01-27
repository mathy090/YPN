// src/screens/news.tsx
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

const NewsScreen = () => (
  <View style={styles.container}>
    <Text style={styles.text}>News Content</Text>
  </View>
);

export default NewsScreen;

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  text: { color: '#FFFFFF', fontSize: 18 },
});