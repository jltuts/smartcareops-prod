export async function readFinalization(url, ticket) {
  const endpoint = new URL('/api/intake-finalization', url.replace(/^ws/, 'http'));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(endpoint, { headers: { 'X-SmartCareOps-Finalization-Id': ticket } });
    if (response.status !== 202) {
      if (!response.ok) throw new Error('Finalization request failed');
      return response.json();
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Finalization timed out');
}
