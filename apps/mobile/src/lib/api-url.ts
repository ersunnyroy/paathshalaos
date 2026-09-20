/**
 * Where the API is, without anybody typing an IP address.
 *
 * `localhost` on a phone is the phone, so a development build has to point at
 * the machine running the API by its address on the network — and asking a
 * person to find their own LAN IP, paste it into a config file and redo it
 * every time their router hands out a different one is a setup step that goes
 * wrong far more often than it goes right.
 *
 * Expo already knows the answer. The phone reached the dev server over that
 * exact network, and `hostUri` is the host it used. Taking the API's port from
 * it gives the right address on any network, including a phone hotspot.
 *
 * An explicit `apiUrl` always wins, because a real deployment is not on the
 * developer's laptop.
 */
const DEFAULT_PORT = 3001;

export function resolveApiUrl(
  explicit: string | undefined,
  hostUri: string | undefined,
  port: number = DEFAULT_PORT,
): string {
  if (explicit) return explicit.replace(/\/+$/, '');

  // hostUri looks like "192.168.1.14:8081" — sometimes with a scheme, and on a
  // tunnel it is a hostname with no port at all.
  if (hostUri) {
    const withoutScheme = hostUri.replace(/^[a-z]+:\/\//i, '');
    const host = withoutScheme.split('/')[0]!.split(':')[0];
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return `http://${host}:${port}`;
    }
  }

  // Simulator on the same machine, or no hint at all. Correct there, and the
  // sign-in screen says what to do when it is not.
  return `http://localhost:${port}`;
}
