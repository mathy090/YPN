// src/utils/network.ts
import NetInfo from '@react-native-community/netinfo';
import { useEffect, useState } from 'react';

export const useNetworkStatus = () => {
  const [isConnected, setIsConnected] = useState(true);
  const [isChecking, setIsChecking] = useState(true);

  const checkNetwork = async () => {
    setIsChecking(true);
    try {
      const state = await NetInfo.fetch();
      setIsConnected(state.isConnected ?? false);
    } catch (error) {
      console.error('Network check error:', error);
      setIsConnected(false);
    } finally {
      setIsChecking(false);
    }
  };

  useEffect(() => {
    checkNetwork();
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected ?? false);
      setIsChecking(false);
    });
    const interval = setInterval(checkNetwork, 10000);
    return () => {
      unsubscribe();
      clearInterval(interval);
    };
  }, []);

  return { isConnected, isChecking };
};