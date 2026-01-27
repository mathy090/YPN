// src/screens/foryou.tsx
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

const ForYouScreen = () => (
  <View style={styles.container}>
    <Text style={styles.text}>For You Content</Text>
  </View>
);

export default ForYouScreen;

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  text: { color: '#FFFFFF', fontSize: 18 },
});