// backend/src/utils/youtubeAPI.js
"use strict";
const axios = require("axios");

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) throw new Error("YOUTUBE_API_KEY is not set in your .env file");

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
let feedCache = { videos: [], fetchedAt: 0 };

const categories = [
  "Motivation Hub Africa",
  "DIY projects Africa",
  "Youth Empowerment Zimbabwe",
  "Mental Health Africa youth",
  "BBC News Africa",
  "YPN Zimbabwe",
  "Education Africa youth",
  "Entrepreneurship Africa youth",
  "Career advice young people",
  "Self development Africa",
];

async function searchChannelsByKeyword(keyword, maxResults = 2) {
  try {
    const res = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          type: "channel",
          q: keyword,
          maxResults,
          key: API_KEY,
        },
        timeout: 8000,
      },
    );
    return (res.data.items || []).map((item) => ({
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.title,
    }));
  } catch (err) {
    console.warn(
      `[youtubeAPI] searchChannelsByKeyword("${keyword}"):`,
      err.response?.data?.error?.message || err.message,
    );
    return [];
  }
}

async function fetchVideosFromChannel(channelId, maxResults = 5) {
  try {
    const res = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          type: "video",
          channelId,
          order: "date",
          maxResults,
          videoEmbeddable: "true", // only fetch videos that can actually be embedded
          key: API_KEY,
        },
        timeout: 8000,
      },
    );
    return (res.data.items || [])
      .filter((item) => item.id?.videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        thumbnail:
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.medium?.url ||
          item.snippet.thumbnails?.default?.url ||
          "",
        channelTitle: item.snippet.channelTitle,
        channelURL: `https://www.youtube.com/channel/${item.snippet.channelId}`,
      }));
  } catch (err) {
    console.warn(
      `[youtubeAPI] fetchVideosFromChannel("${channelId}"):`,
      err.response?.data?.error?.message || err.message,
    );
    return [];
  }
}

async function getVideosForFeed() {
  const now = Date.now();

  if (feedCache.videos.length > 0 && now - feedCache.fetchedAt < CACHE_TTL_MS) {
    console.log(
      `[youtubeAPI] Serving ${feedCache.videos.length} videos from cache`,
    );
    return feedCache.videos;
  }

  console.log("[youtubeAPI] Cache miss — fetching fresh feed from YouTube...");

  let feed = [];
  const seen = new Set();

  for (const keyword of categories) {
    try {
      const channels = await searchChannelsByKeyword(keyword, 2);
      for (const ch of channels) {
        const videos = await fetchVideosFromChannel(ch.channelId, 5);
        for (const v of videos) {
          if (!seen.has(v.videoId)) {
            seen.add(v.videoId);
            feed.push(v);
          }
        }
      }
    } catch (err) {
      console.warn(`[youtubeAPI] Category "${keyword}" failed:`, err.message);
    }
  }

  feed = feed.sort(() => 0.5 - Math.random());

  if (feed.length === 0) {
    if (feedCache.videos.length > 0) {
      console.warn("[youtubeAPI] Fresh fetch returned 0 — serving stale cache");
      return feedCache.videos;
    }
    throw new Error(
      "No videos could be fetched. YouTube API quota may be exhausted.",
    );
  }

  feedCache = { videos: feed, fetchedAt: now };
  console.log(`[youtubeAPI] Cached ${feed.length} fresh videos`);
  return feed;
}

module.exports = {
  searchChannelsByKeyword,
  fetchVideosFromChannel,
  getVideosForFeed,
};
