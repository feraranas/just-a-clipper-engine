export const parseInstalledClient = (config) => {
  const installed = config?.installed;

  if (
    !installed?.client_id ||
    !installed?.client_secret ||
    !installed?.redirect_uris?.[0]
  ) {
    throw new Error("Expected an installed Google OAuth client configuration");
  }

  return {
    clientId: installed.client_id,
    clientSecret: installed.client_secret,
    redirectUri: installed.redirect_uris[0],
  };
};

export const mergeOAuthTokens = (existing = {}, incoming = {}) => ({
  ...existing,
  ...incoming,
  refresh_token: incoming.refresh_token ?? existing.refresh_token,
});

export const findPlaylistByTitle = async (listPage, title) => {
  let pageToken;

  do {
    const page = await listPage(pageToken);
    const match = page?.items?.find((item) => item.snippet?.title === title);

    if (match) {
      return {id: match.id, title: match.snippet.title};
    }

    pageToken = page?.nextPageToken;
  } while (pageToken);

  return null;
};
