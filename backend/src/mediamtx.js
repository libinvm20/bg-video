const mediaBaseUrl = process.env.MEDIAMTX_API_URL ?? 'http://mediamtx:9997';
const apiUsername = process.env.MEDIAMTX_API_USER ?? 'mediamtx-api';
const apiPassword = process.env.MEDIAMTX_API_PASSWORD ?? '';

export async function mediaRequest(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(`${mediaBaseUrl}${path}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${apiUsername}:${apiPassword}`).toString('base64')}`,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`MediaMTX API returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function getFrontPath() {
  const result = await mediaRequest('/v3/paths/list');
  return result.items?.find((item) => item.name === 'front') ?? null;
}