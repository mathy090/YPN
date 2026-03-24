// backend/src/utils/youtubeAPI.js
"use strict";
const axios = require("axios");
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  throw new Error("YOUTUBE_API_KEY is not set in your .env file");
}

const yt = axios.create({
  baseURL: "https://www.googleapis.com/youtube/v3",
  params: { key: API_KEY },
});

/**
 * Search YouTube channels by keyword.
 * Costs 100 quota units per call — only called when building the cached feed.
 */
async function searchChannelsByKeyword(keyword, maxResults = 3) {
  try {
    const { data } = await yt.get("/search", {
      params: { part: "snippet", type: "channel", q: keyword, maxResults },
    });
    return data.items.map((item) => ({
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.title,
    }));
  } catch (err) {
    console.error(`searchChannelsByKeyword(${keyword}):`, err.message);
    return [];
  }
}

/**
 * Fetch latest videos from a channel.
 * Costs 100 quota units per call.
 */
async function fetchVideosFromChannel(channelId, maxResults = 3) {
  try {
    const { data } = await yt.get("/search", {
      params: {
        part: "snippet",
        type: "video",
        channelId,
        order: "date",
        maxResults,
      },
    });
    return data.items
      .filter((item) => item.id?.videoId)
      .map((item) => ({
        videoId: item.id.videoId,
        title: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        thumbnail:
          item.snippet.thumbnails?.high?.url ||
          item.snippet.thumbnails?.default?.url,
        channelTitle: item.snippet.channelTitle,
        channelId: item.snippet.channelId,
        // Stats filled in by enrichWithStats()
        viewCount: null,
        likeCount: null,
        commentCount: null,
      }));
  } catch (err) {
    console.error(`fetchVideosFromChannel(${channelId}):`, err.message);
    return [];
  }
}

/**
 * Batch-fetch statistics for up to 50 videos in one API call.
 * Costs only 1 quota unit — very cheap.
 * Returns a map of { videoId -> { viewCount, likeCount, commentCount } }
 */
async function fetchVideoStats(videoIds) {
  if (!videoIds.length) return {};
  try {
    // API accepts comma-separated IDs, max 50 per call
    const chunks = [];
    for (let i = 0; i < videoIds.length; i += 50) {
      chunks.push(videoIds.slice(i, i + 50));
    }

    const statsMap = {};
    for (const chunk of chunks) {
      const { data } = await yt.get("/videos", {
        params: { part: "statistics", id: chunk.join(",") },
      });
      for (const item of data.items) {
        const s = item.statistics || {};
        statsMap[item.id] = {
          viewCount: parseInt(s.viewCount || "0", 10),
          likeCount: parseInt(s.likeCount || "0", 10),
          commentCount: parseInt(s.commentCount || "0", 10),
        };
      }
    }
    return statsMap;
  } catch (err) {
    console.error("fetchVideoStats:", err.message);
    return {};
  }
}

/**
 * Enrich a video array with real statistics.
 * Mutates in place and returns the array.
 */
async function enrichWithStats(videos) {
  const ids = videos.map((v) => v.videoId);
  const statsMap = await fetchVideoStats(ids);
  for (const v of videos) {
    const s = statsMap[v.videoId];
    if (s) {
      v.viewCount = s.viewCount;
      v.likeCount = s.likeCount;
      v.commentCount = s.commentCount;
    }
  }
  return videos;
}

module.exports = {
  searchChannelsByKeyword,
  fetchVideosFromChannel,
  fetchVideoStats,
  enrichWithStats,
};
