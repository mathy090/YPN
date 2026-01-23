import { Redirect } from 'expo-router';
import { useAuth } from '../src/store/authStore';

export default function Index() {
  const { hasAgreed, isLoggedIn } = useAuth();

  if (!hasAgreed) return <Redirect href="/welcome" />;
  if (!isLoggedIn) return <Redirect href="/auth/phone" />;

  return <Redirect href="/tabs/chats" />;
}
