const BASE_URL = "https://ypn.onrender.com";

export async function fetchForYouVideos() {
  try {
    const res = await fetch(`${BASE_URL}/api/videos/foryou`);

    if (!res.ok) {
      throw new Error("Failed to fetch videos");
    }

    const data = await res.json();
    return data;
  } catch (error) {
    throw error;
  }
}
