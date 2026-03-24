// src/utils/youtubeAPI.js
"use strict";
const axios = require("axios");
const API_KEY = process.env.YOUTUBE_API_KEY;

if (!API_KEY) {
  throw new Error("YOUTUBE_API_KEY is not set in your .env file");
}

/**
 * Search YouTube channels by keyword
 * @param {string} keyword - category keyword e.g. "DIY"
 * @param {number} maxResults - number of channels to fetch
 */
async function searchChannelsByKeyword(keyword, maxResults = 5) {
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
      },
    );

    return res.data.items.map((item) => ({
      channelId: item.snippet.channelId,
      channelTitle: item.snippet.title,
    }));
  } catch (err) {
    console.error(`searchChannelsByKeyword error (${keyword}):`, err.message);
    return [];
  }
}

/**
 * Fetch latest videos from a specific channel
 * @param {string} channelId - YouTube channel ID
 * @param {number} maxResults - number of videos to fetch
 */
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
          key: API_KEY,
        },
      },
    );

    return res.data.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
      thumbnail: item.snippet.thumbnails.high.url,
      channelTitle: item.snippet.channelTitle,
      channelURL: `https://www.youtube.com/channel/${item.snippet.channelId}`,
    }));
  } catch (err) {
    console.error(`fetchVideosFromChannel error (${channelId}):`, err.message);
    return [];
  }
}

/**
 * Get curated categories and videos
 * @returns array of video objects for frontend
 */
async function getVideosForFeed() {
  const categories = [
    "Motivation Hub",
    "DIY",
    "Youth Empowerment",
    "Mental Health",
    "BBC News Africa",
    "YPN Zimbabwe",
    "Education",
  ];

  let feed = [];

  for (const keyword of categories) {
    const channels = await searchChannelsByKeyword(keyword, 3); // fetch 3 channels per category
    for (const ch of channels) {
      const videos = await fetchVideosFromChannel(ch.channelId, 2); // 2 videos per channel
      feed.push(...videos);
    }
  }

  // Shuffle feed for randomness
  feed = feed.sort(() => 0.5 - Math.random());
  return feed;
}

module.exports = {
  searchChannelsByKeyword,
  fetchVideosFromChannel,
  getVideosForFeed,
};
