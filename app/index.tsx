// app/index.tsx
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react'; // Import hooks
import { useAuth } from '../src/store/authStore';
import { initializeSecureCache, isSecureCacheInitialized } from '../src/utils/cache'; // Import cache functions

export default function Index() {
  const { hasAgreed, isLoggedIn } = useAuth();
  const [cacheReady, setCacheReady] = useState(isSecureCacheInitialized()); // Check initial state

  useEffect(() => {
    const initCache = async () => {
      if (!isSecureCacheInitialized()) { // Only initialize if not already done
        try {
          console.log("Initializing secure cache...");
          await initializeSecureCache();
          console.log("Secure cache initialized successfully.");
          setCacheReady(true); // Update state to indicate readiness
        } catch (error) {
          console.error("Failed to initialize secure cache:", error);
          // Decide how to handle initialization failure
          // For now, let's assume it's okay to proceed without caching if it fails critically
          // You might want to show an error screen depending on your requirements
          setCacheReady(true); // Allow app to proceed even if cache init fails critically
        }
      } else {
        console.log("Secure cache already initialized.");
        setCacheReady(true); // Already ready
      }
    };

    initCache();
  }, []); // Run once on mount


  // Wait for cache initialization before making routing decisions
  if (!cacheReady) {
    // You can return a simple loading indicator here if desired
    // Otherwise, the app might flash briefly before redirecting
    // Example: return <Text>Initializing...</Text>;
    // Returning null or a minimal loader is common practice
    return null; // Or return a minimal loader component
  }

  // Proceed with original routing logic after cache is ready
  if (!hasAgreed) return <Redirect href="/welcome" />;
  if (!isLoggedIn) return <Redirect href="/auth/phone" />;

  return <Redirect href="/tabs/chats" />;
}