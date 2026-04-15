// src/context/SessionExpiredContext.tsx
import React, { createContext, useContext } from "react";
import { Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";

interface Props {
  show: boolean;
  onHide: () => void;
  children: React.ReactNode;
}

const SessionExpiredContext = createContext<{ trigger: () => void }>({
  trigger: () => {},
});

export const SessionExpiredProvider = ({ show, onHide, children }: Props) => {
  return (
    <SessionExpiredContext.Provider value={{ trigger: onHide }}>
      {children}
      <Modal
        visible={show}
        transparent
        animationType="fade"
        statusBarTranslucent
      >
        <View style={styles.overlay}>
          <View style={styles.card}>
            <Text style={styles.title}>Session Expired</Text>
            <Text style={styles.desc}>
              For your security, please sign in again.
            </Text>
            <TouchableOpacity style={styles.btn} onPress={onHide}>
              <Text style={styles.btnText}>Go to Login</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SessionExpiredContext.Provider>
  );
};

export const useSessionExpired = () => useContext(SessionExpiredContext);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.8)",
    justifyContent: "center",
    alignItems: "center",
  },
  card: {
    backgroundColor: "#111B21",
    borderRadius: 16,
    padding: 24,
    width: "85%",
    alignItems: "center",
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 8 },
  desc: {
    color: "#8696A0",
    fontSize: 14,
    textAlign: "center",
    marginBottom: 20,
  },
  btn: {
    backgroundColor: "#1DB954",
    borderRadius: 12,
    paddingVertical: 14,
    width: "100%",
    alignItems: "center",
  },
  btnText: { color: "#000", fontWeight: "700", fontSize: 15 },
});
