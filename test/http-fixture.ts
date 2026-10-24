/** Extract only an invented test server's bootstrap response. */
export function sessionAuthorization(response: Response): string {
  const location = response.headers.get('location') ?? '';
  const token = new URLSearchParams(new URL(location, 'http://127.0.0.1').hash.slice(1)).get('session');
  if (!token || !/^[a-f\d]{64}$/.test(token)) throw new Error('Missing test session.');
  return `Bearer ${token}`;
}
