export async function checkAIHealth(): Promise<boolean> {
  try {
    const res = await fetch(process.env.EXPO_PUBLIC_AI_URL + "/health");

    if (!res.ok) return false;

    const data = await res.json();
    return data?.status === "ok";
  } catch {
    return false;
  }
}
