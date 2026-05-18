export async function onRequestGet({ env, request }) {
  try {
    const assetUrl = new URL('/api_guide.html', request.url);
    const response = await env.ASSETS.fetch(assetUrl.toString());

    if (!response.ok) {
      return new Response('API guide not found.', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    const headers = new Headers(response.headers);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Cache-Control', 'public, max-age=120, s-maxage=900');

    return new Response(response.body, {
      status: 200,
      headers
    });
  } catch (error) {
    return new Response('Could not load API guide.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
