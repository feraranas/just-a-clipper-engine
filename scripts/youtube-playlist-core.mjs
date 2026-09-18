export const collectPlaylistItems = async (listPage) => {
  const videos = [];
  let pageToken;

  do {
    const page = await listPage(pageToken);

    for (const item of page?.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;

      if (videoId) {
        videos.push({
          title: item.snippet?.title ?? videoId,
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        });
      }
    }

    pageToken = page?.nextPageToken;
  } while (pageToken);

  return videos;
};
