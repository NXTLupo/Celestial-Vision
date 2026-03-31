/**
 * Vite server middleware for Instagram publishing.
 * Runs server-side (Node.js) to use the instagram-publisher npm package,
 * which requires fs and Node HTTP clients.
 */
import type { Plugin } from 'vite';
import path from 'path';
import fs from 'fs';
import os from 'os';

export function instagramPublishPlugin(): Plugin {
  return {
    name: 'instagram-publish-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url !== '/api/instagram/publish' || req.method !== 'POST') {
          return next();
        }

        try {
          // Read request body
          const body = await new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            req.on('end', () => resolve(data));
            req.on('error', reject);
          });

          const { email, password, caption, images } = JSON.parse(body);

          if (!email || !password || !caption || !images || images.length === 0) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Missing required fields: email, password, caption, images' }));
            return;
          }

          // Dynamic import to keep this out of client bundle
          const InstagramPublisher = (await import('instagram-publisher')).default;
          const ig = new InstagramPublisher({ email, password, verbose: false });

          // Save base64 images to temp files
          const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'celestial-ig-'));
          const imagePaths: string[] = [];

          for (let i = 0; i < images.length; i++) {
            const base64Data = images[i].replace(/^data:image\/\w+;base64,/, '');
            const imgPath = path.join(tmpDir, `image_${i}.jpg`);
            fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
            imagePaths.push(imgPath);
          }

          let result;
          if (imagePaths.length === 1) {
            result = await ig.createSingleImage({
              image_path: imagePaths[0],
              caption,
            });
          } else {
            // Slideshow requires 1:1 aspect ratio - attempt carousel
            try {
              result = await ig.createImageSlideshow({
                images: imagePaths as any,
                caption,
              });
            } catch {
              // If slideshow fails (aspect ratio), fall back to single image
              result = await ig.createSingleImage({
                image_path: imagePaths[0],
                caption,
              });
            }
          }

          // Clean up temp files
          for (const p of imagePaths) {
            try { fs.unlinkSync(p); } catch {}
          }
          try { fs.rmdirSync(tmpDir); } catch {}

          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            succeeded: result.succeeded,
            code: result.code,
            message: result.succeeded
              ? 'Post published successfully!'
              : `Publishing failed: ${result.code}`,
          }));
        } catch (err: any) {
          console.error('[Instagram API Error]', err);
          const errMsg = err.message || '';
          let userMessage = errMsg;

          // Detect Instagram private API blocking (404/403 on login endpoints)
          if (errMsg.includes('404') || errMsg.includes('Page Not Found') || errMsg.includes('not-logged-in')) {
            userMessage = 'Instagram has blocked automated publishing via their private API. This is a known limitation. Use "Copy Caption" to post manually via the Instagram app.';
          } else if (errMsg.includes('checkpoint') || errMsg.includes('challenge')) {
            userMessage = 'Instagram requires a security checkpoint (e.g. 2FA or suspicious login verification). Log in via the Instagram app first, then retry.';
          } else if (errMsg.includes('incorrect') || errMsg.includes('password')) {
            userMessage = 'Invalid Instagram credentials. Please check your email and password.';
          }

          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: userMessage }));
        }
      });
    },
  };
}
