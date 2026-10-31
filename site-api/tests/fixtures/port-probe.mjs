/**
 * T3 Code (and other port-discovery tools on a developer machine) send `GET /` to every new
 * localhost listener, a few seconds after it starts. No upstream API the fakes stand in for uses the
 * root, so a fake answers it 404 and never records it as a call. Returns whether it answered.
 */
export function ignorePortProbe(req, res) {
  if (req.method !== 'GET' || req.url !== '/') return false;
  req.resume();
  res.writeHead(404);
  res.end();
  return true;
}
