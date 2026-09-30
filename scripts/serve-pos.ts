/** Serve the counter prototype locally: npm run pos, then open the URL. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 5173);

createServer(async (_req, res) => {
  try {
    const html = await readFile(new URL('../apps/pos/index.html', import.meta.url));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(PORT, () => {
  console.log(`Counter prototype: http://localhost:${PORT}`);
});
